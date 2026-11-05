#!/usr/bin/env node
// M3 漏斗：拿**真实快照**跑一遍归一化 + allocator，输出"今天这套系统能不能找到东西"。
//
// 用户 2026-11-05 的第四条验收：fixture 全绿只证明"代码按我写的规则运行"，
// 漏斗才回答"有没有机会、差在哪一项数据"。所以这个工具的输出必须能一眼看出
// 报价总数 → 归一化成功 → 供给可用 → 各原因码计数 → pass/watch/skip。
//
// 用法：node tools/m3-funnel.mjs [--date YYYYMMDD] [--json]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { normalizeVast, normalizeClore, toAllocatorOffer } from '../src/m3/normalize.js';
import { decide } from '../src/m3/allocator.js';
import { calibrationShoppingList } from '../src/m3/ev.js';

const CTRL = 'http://127.0.0.1:8290/api/state';
const LOGDIR = '/data/gpumarket-autominer/data/offerLog';
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const day = arg('--date', new Date().toISOString().slice(0, 10).replace(/-/g, ''));

const st = await (await fetch(CTRL, { signal: AbortSignal.timeout(10000) })).json();
const price = Number(st?.market?.price) || 0;
const density = Number(st?.market?.usdPerThDay) || 0;
const target = Number(st?.config?.targetProfitPct) || 20;
const deployPct = (Number(st?.config?.deployCostMin ?? 2)) / 60 * 100;
const pSurvive = Number(st?.config?.pSurviveDefault ?? 0.5);
// 收入口径：密度 $/TH·天 ÷ 24 → $/TH·h（与 PRL 面板同源）
const revenuePerThHour = density / 24;

const ctx = {
  rentEnabled: true, targetProfitPct: target, deployPct, pSurvive,
  revenuePerThHour, floorPricePerGpu: 0.02, maxHourlySpend: 0.2, budgetLeftUsd: 5, maxLeaseHours: 24,
};

// 型号 → 交付算力与口径（直接用面板，未校准会标 pooled/spec）
const thByModel = {};
for (const r of st?.pricingTable || []) thByModel[r.model] = { th: r.th, thSource: r.thSource, thCalibrated: r.thCalibrated };
const specByModel = {};
for (const g of st?.table || []) specByModel[g.name] = Number(g.effective) || null;

function readLines(file) {
  try {
    const txt = zlib.gunzipSync(fs.readFileSync(file)).toString().trim();
    return txt ? txt.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  } catch { return []; }
}

// --live：直接用当前扫描结果（offers 自带 gpuName），用于"今天真实的漏斗比例"；
// 日志模式用于时间序列（历史行可能缺 gpu 字段，会记进 normalizeFailed）
const LIVE = process.argv.includes('--live');
const liveRows = LIVE ? (st?.offers || []).map(o => ({ id: o.id, m: o.machineId, gpu: o.gpuName, dph: o.dph, mb: o.minBid, frac: o.gpuFrac, th: o.th })) : null;
const vastFile = path.join(LOGDIR, `${day}.jsonl.gz`);
const cloreFile = path.join(LOGDIR, `clore-${day}.jsonl.gz`);
const vastRounds = LIVE ? [{ rows: liveRows }] : readLines(vastFile);
const cloreRounds = readLines(cloreFile);

const funnel = { at: new Date().toISOString(), day, density, price, revenuePerThHour: +revenuePerThHour.toFixed(6), rounds: { vast: vastRounds.length, clore: cloreRounds.length }, total: 0, normalized: 0, normalizeFailed: 0, byReason: {}, byVerdict: {}, byMarket: {}, watchHints: [], candidates: [], supply: {} };
const fracCount = { whole: 0, partial: 0, unknown: 0 };

// vast：快照里存的是**已评估过的**精简行（id/m/dph/mb/frac/eff/ram/th），不是原始 vast 字段，
// 所以这里按行内字段重建，不做 raw 解析——这也说明 offerLog 的字段设计要跟着 adapter 走。
const seen = new Set();
for (const round of vastRounds) {
  for (const r of round.rows || []) {
    funnel.total++;
    if (r.frac == null) fracCount.unknown++;
    else if (Number(r.frac) >= 0.99) fracCount.whole++;
    else fracCount.partial++;
    const key = `${r.m}`;
    // 型号名直接取快照行（2026-11-05 修复：早先快照没存型号，模糊匹配会把所有行配到第一个型号，
    // 于是"价格主因 962 条"那个数是错的——错配的 specTh 会把结论整体带偏）
    const model = r.gpu && thByModel[r.gpu] ? r.gpu : null;
    if (!model) { funnel.normalizeFailed++; continue; }
    const info = thByModel[model];
    const offer = toAllocatorOffer({
      id: r.id, market: 'vast', gpu: model, numGpus: 1,
      frac: r.frac ?? null, pricePerHour: Number(r.dph) || null, mrlHours: 0,
    }, { deliveredTh: info.th, thSource: info.thSource, thCalibrated: info.thCalibrated });
    const d = decide(offer, { ...ctx, specTh: specByModel[model] });
    funnel.normalized++;
    funnel.byReason[d.reasonCode] = (funnel.byReason[d.reasonCode] || 0) + 1;
    funnel.byVerdict[d.verdict] = (funnel.byVerdict[d.verdict] || 0) + 1;
    funnel.byMarket.vast = (funnel.byMarket.vast || 0) + 1;
    if (d.verdict === 'watch' && d.whatWouldMakeItViable) {
      const tag = `${model}|${d.reasonCode}|${d.whatWouldMakeItViable.priceIsTheProblem ? 'price' : 'data'}`;
      if (!funnel._seen) funnel._seen = new Set();
      if (!funnel._seen.has(tag) && funnel.watchHints.length < 6) {
        funnel._seen.add(tag);
        funnel.watchHints.push({ market: 'vast', model, reason: d.reasonCode, need: d.whatWouldMakeItViable });
      }
      if (d.whatWouldMakeItViable.priceIsTheProblem) funnel.priceLimited = (funnel.priceLimited || 0) + 1;
      else {
        funnel.dataLimited = (funnel.dataLimited || 0) + 1;
        // 只有"数据可能改变判断"的才进校准购物单
        funnel.candidates.push({ model, needTh: d.whatWouldMakeItViable.minDeliveredTh, specTh: d.whatWouldMakeItViable.specTh, samples: [] });
      }
    }
    seen.add(key);
  }
}

// clore：快照里存的是聚合结果（min/med/mrl），不是逐台原始报价，只能按型号近似跑
for (const round of cloreRounds) {
  for (const [model, m] of Object.entries(round.models || {})) {
    funnel.total++;
    const info = thByModel[model] || { th: null, thSource: 'spec', thCalibrated: false };
    const offer = toAllocatorOffer({
      id: null, market: 'clore', gpu: model, numGpus: 1,
      frac: 1, pricePerHour: m.min != null ? m.min : null, mrlHours: m.mrlMin ?? null,
    }, { deliveredTh: info.th, thSource: info.thSource, thCalibrated: info.thCalibrated });
    const d = decide(offer, { ...ctx, specTh: specByModel[model] });
    funnel.normalized++;
    funnel.byReason[d.reasonCode] = (funnel.byReason[d.reasonCode] || 0) + 1;
    funnel.byVerdict[d.verdict] = (funnel.byVerdict[d.verdict] || 0) + 1;
    funnel.byMarket.clore = (funnel.byMarket.clore || 0) + 1;
  }
}

const fracTotal = fracCount.whole + fracCount.partial + fracCount.unknown;
funnel.supply.vast = { whole: fracCount.whole, partial: fracCount.partial, unknown: fracCount.unknown, wholeCardShare: fracTotal ? +(fracCount.whole / fracTotal).toFixed(3) : null };
{
  const c = cloreRounds[cloreRounds.length - 1];
  const fd = c?.fracDist;
  if (fd) {
    const t = (fd['1.0'] || 0) + (fd.partial || 0) + (fd.null || 0);
    funnel.supply.clore = { whole: fd['1.0'] || 0, partial: fd.partial || 0, unknown: fd.null || 0, wholeCardShare: t ? +((fd['1.0'] || 0) / t).toFixed(3) : null };
  }
}
// 校准购物单：EV>0 才值得租（PRL 的教训是先租后想）
{
  const daysLeft = Math.max(1, Math.round((Date.parse('2026-11-11T00:00:00Z') - Date.now()) / 864e5));
  funnel.shopping = calibrationShoppingList(funnel.candidates, { revenuePerThHour, daysLeft, rentPerHour: 0.067 });
  funnel.shopping.daysLeft = daysLeft;
}
// 时间序列：D14 需要的是"pass 是否曾经非零 / 价格主因比例有没有下降"，单日快照答不了
if (process.argv.includes('--append')) {
  const line = JSON.stringify({
    at: funnel.at, day, total: funnel.total, normalized: funnel.normalized,
    pass: funnel.byVerdict.pass || 0, watch: funnel.byVerdict.watch || 0, skip: funnel.byVerdict.skip || 0,
    priceLimited: funnel.priceLimited || 0, dataLimited: funnel.dataLimited || 0,
    wholeCardShareVast: funnel.supply.vast?.wholeCardShare ?? null,
    wholeCardShareClore: funnel.supply.clore?.wholeCardShare ?? null,
    price, density: +density.toFixed(5),
  });
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(path.join(LOGDIR, `funnel-${day}.jsonl`), line + '\n');
    console.log(`已追加漏斗序列 → data/offerLog/funnel-${day}.jsonl`);
  } catch (e) { console.log(`漏斗序列写入失败：${e.message}`); }
}

if (process.argv.includes('--json')) { console.log(JSON.stringify(funnel, null, 2)); process.exit(0); }

console.log(`M3 漏斗 ${funnel.at}｜快照 ${day}｜vast ${funnel.rounds.vast} 轮 / clore ${funnel.rounds.clore} 轮`);
console.log(`收入口径：密度 $${density.toFixed(5)}/TH·天 → $${revenuePerThHour.toFixed(6)}/TH·h｜PRL $${price}`);
console.log(`报价 ${funnel.total} → 归一化成功 ${funnel.normalized}（失败 ${funnel.normalizeFailed}）→ 决策：${Object.entries(funnel.byVerdict).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
console.log('按原因码：');
for (const [k, v] of Object.entries(funnel.byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
if (funnel.priceLimited || funnel.dataLimited) console.log(`watch 拆分：价格主因 ${funnel.priceLimited || 0} 条 / 数据缺失 ${funnel.dataLimited || 0} 条`);
if (funnel.watchHints.length) {
  console.log('watch 的补救条件（差哪一项数据）：');
  for (const h of funnel.watchHints) console.log(`  ${h.model} ${h.reason} → ${JSON.stringify(h.need)}`);
}
console.log(`供给形态：vast 整卡 ${funnel.supply.vast?.whole} / 分数 ${funnel.supply.vast?.partial} → wholeCardShare ${funnel.supply.vast?.wholeCardShare}｜clore ${funnel.supply.clore?.wholeCardShare ?? '—'}`);
console.log(`校准购物单：候选 ${funnel.candidates.length} 条 → EV>0 ${funnel.shopping.viable.length} 条 → ${funnel.shopping.conclusion}`);
console.log(funnel.byVerdict.pass ? '✅ 有 pass 项' : '⛔ pass: 0（今天没有可租项；上面就是"缺什么"）');