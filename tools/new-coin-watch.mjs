#!/usr/bin/env node
// 新币监测（2026-11-06 计划项，2026-11-05 提前落地）：只覆盖"未被证伪的象限"。
//
// 两个未证伪象限的交集就是它：
//   A 刚上池的新币（密度还没被套利）  B CPU 腿（冻结了，但 usableThreads 是通用资产）
//
// 设计约束（用户 2026-11-05）：
//   ① 阈值**不许写死**：threshold = minRentablePrice(venue) × (1+roiReq) × 24 ÷ th，
//      输出必须带 derivedFrom（venue/price/th/roiReq），随场所与交付算力自动变；
//   ② 每条都带 cpuLegUsdHr 影子腿（纯 CPU 币的唯一收入可能就在这里）；
//   ③ 没命中就静默——监测的价值是"出现时才响"，不是每天报一次"没有"。
import fs from 'node:fs';

const STATE = '/data/prl-automine/new-coin-seen.json';
const CTRL = 'http://127.0.0.1:8290/api/state';
const AFK = 'https://afkpool.com/api/v1/coins';
const NEW_DAYS = 30;

const st = await (await fetch(CTRL, { signal: AbortSignal.timeout(8000) })).json();
const target = Number(st?.config?.targetProfitPct ?? 20);
const deployPct = (Number(st?.config?.deployCostMin ?? 2)) / 60 * 100;
const pSurvive = Number(st?.config?.pSurviveDefault ?? 0.5) || 1;
const roiReq = (target + deployPct) / pSurvive;          // 46.7%
const cpuLeg = st?.config?.cpuLeg || {};

// 两个场所的最低可租价与交付算力（都从面板取，不写死）
const rows = (st?.pricingTable || []);
const r3080 = rows.find(r => /3080(?!\s*Ti)/i.test(r.model));
const venues = [];
if (r3080?.bidFrom?.minBid) venues.push({ venue: 'vast', price: r3080.bidFrom.minBid, th: r3080.th, thSource: r3080.thSource });
try {
  const c = st?.markets?.clore?.models?.['3080'];
  if (c?.min) venues.push({ venue: 'clore', price: c.min, th: r3080?.th ?? null, thSource: r3080?.thSource ?? null });
} catch { /* 没有 clore 快照就只报 vast */ }

// 阈值：需要多少 $/TH·天 才能在某个场所过线
const thresholds = venues.filter(v => v.price > 0 && v.th > 0).map(v => ({
  venue: v.venue,
  needDensity: +(v.price * (1 + roiReq / 100) * 24 / v.th).toFixed(4),
  derivedFrom: `venue=${v.venue}, price=$${v.price}, th=${v.th}(${v.thSource}), roiReq=${roiReq.toFixed(1)}%`,
}));
const needDensity = thresholds.length ? Math.min(...thresholds.map(t => t.needDensity)) : null;

// CPU 影子腿：一个典型 16 核/32GiB 宿主能跑多少线程、值多少（不参与出价）
const usable = Math.min(16, Math.floor(((32 * 1024 / 1024) - Number(cpuLeg.osReserveGb ?? 4)) / Number(cpuLeg.ramPerThreadGb ?? 2)), Number(cpuLeg.maxThreads ?? 27));
const cpuLegUsdHr = +(usable * Number(cpuLeg.ratePerThreadHr ?? 0) * Number(cpuLeg.contentionFactor ?? 1)).toFixed(4);

// 首次见到时间（本地登记，AFKPool 不给上线日期）
let seen = {};
try { seen = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* 第一次跑 */ }
const coins = (await (await fetch(AFK, { signal: AbortSignal.timeout(20000) })).json())?.coins || [];
const now = Date.now();
const fresh = [];
for (const c of coins) {
  const id = c.id || c.slug;
  if (!id) continue;
  if (!seen[id]) { seen[id] = { firstSeen: new Date(now).toISOString(), name: c.name, symbol: c.symbol, algo: c.algorithm, stage: c.stage }; fresh.push(seen[id]); }
  seen[id].lastSeen = new Date(now).toISOString();
  seen[id].stage = c.stage;
}
fs.writeFileSync(STATE, JSON.stringify(seen, null, 2) + '\n');

const candidates = Object.entries(seen)
  .map(([id, v]) => ({ id, ...v, ageDays: +((now - Date.parse(v.firstSeen)) / 864e5).toFixed(1) }))
  .filter(v => v.ageDays <= NEW_DAYS)
  .sort((a, b) => a.ageDays - b.ageDays);

const out = {
  at: new Date().toISOString(), needDensity, thresholds, roiReq: +roiReq.toFixed(1),
  cpuLegUsdHr, cpuLegBasis: `${usable} 线程 × $${cpuLeg.ratePerThreadHr ?? 0} × ${cpuLeg.contentionFactor ?? 1}（影子，不参与出价）`,
  candidates,
};
if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

if (!candidates.length) {
  // 静默：没有新币就什么都不说（监测的价值在"出现时才响"）
  process.exit(0);
}
console.log(`新币监测 ${out.at}｜需密度 ≥ $${needDensity ?? '—'}/TH·天（roiReq ${out.roiReq}%）｜CPU 影子腿 $${cpuLegUsdHr}/h（${out.cpuLegBasis}）`);
for (const t of thresholds) console.log(`  derivedFrom: ${t.derivedFrom} → 需 $${t.needDensity}/TH·天`);
for (const c of candidates) {
  console.log(`· ${c.symbol || c.name}（${c.algo || '?'}，${c.stage || '?'}）首次见到 ${c.ageDays} 天前｜密度未知（AFKPool 不提供全网算力）`);
}
console.log(`合计 ${candidates.length} 个 ≤${NEW_DAYS} 天的新币；命中条件：密度 ≥ $${needDensity ?? '—'}/TH·天，且该币能在一处变现`);