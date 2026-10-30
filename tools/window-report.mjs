#!/usr/bin/env node
// 窗口捕获报告（M2.1，只读、零成本）：把「窗口模式触发过几次、抓到几台、赚没赚」变成可核对的表。
//
// 两种数据来源：
//   1) 实盘 episode（st.windowEpisodes）——引擎从 2026-10-30 起每次进入窗口模式就落一条，
//      带触发真因、当时的行情快照、放宽了哪三项、以及窗口内租下的租约 id。
//   2) --backfill —— 从 history（每 5 分钟的币价/密度）反推历史窗口，用于回放 10-27/10-29
//      这两个「发生了但我们没进去」的窗口。history 里没有当时的报价列表，所以只能还原
//      价格型触发（1h / 6h 涨幅），还原不了「密度÷地板」和 ratioPass——报告里会明确标出来。
//
// 用法：
//   node tools/window-report.mjs                # episode 表 + 汇总
//   node tools/window-report.mjs --backfill     # 再加历史窗口回放
//   node tools/window-report.mjs --json
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return {}; } })();
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch { return {}; } })();
const price = Number(cfg.lastPrice) || Number([...(st.history || [])].reverse().find(h => Number(h.price) > 0)?.price) || 0;
const leases = st.leases || [];
const H = [...(st.history || [])].sort((a, b) => a.t - b.t);

const MIN = 60e3;
const TZ = 8;   // 报告一律北京时间，跟巡检一致（服务器是 UTC）
const fmtT = (ms) => new Date(ms + TZ * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const hoursOf = l => Math.max(0, ((Number(l.tEnd) || Date.now()) - (Number(l.tRent) || 0)) / 3_600_000);
const paidOf = l => (Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) * hoursOf(l);
const netOf = l => (Number(l.creditedPrl) || 0) * price - paidOf(l);
const median = a => { const v = [...a].filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// ---------- 1) 实盘 episode ----------
const episodes = (st.windowEpisodes || []).map(ep => {
  const ls = (ep.rents || []).map(id => leases.find(l => String(l.id) === String(id))).filter(Boolean);
  const nets = ls.map(netOf);
  const lives = ls.map(l => hoursOf(l) * 60);
  const hashed = ls.filter(l => l.tFirstShare).length;
  const end = ep.endedAt || (st.windowState?.active && !ep.endedAt ? Date.now() : ep.plannedEnd);
  return {
    i: ep.i, start: ep.start, end, plannedMin: Math.round((ep.plannedEnd - ep.start) / MIN),
    actualMin: Math.round((end - ep.start) / MIN), ended: !!ep.endedAt,
    reason: ep.reason,
    info: ep.info || {},
    rents: ls.length,
    netUsd: +nets.reduce((a, b) => a + b, 0).toFixed(4),
    medianLifeMin: median(lives) == null ? null : +median(lives).toFixed(0),
    hashedRate: ls.length ? +(hashed / ls.length * 100).toFixed(0) : null,
    leases: ls.map(l => ({ id: l.id, gpu: l.gpu, hostId: l.hostId, hours: +hoursOf(l).toFixed(2), netUsd: +netOf(l).toFixed(4), endReason: l.endReason || 'open' })),
  };
});

// ---------- 2) 历史窗口回放（--backfill） ----------
// 触发规则与引擎一致，但只能用价格口径：1h ≥8%、6h ≥8%（密度÷地板需要当时的报价列表，history 里没有）。
function chgAt(t, backMs) {
  const now = [...H].reverse().find(h => h.t <= t)?.price;
  const old = [...H].reverse().find(h => h.t <= t - backMs)?.price;
  if (!(now > 0 && old > 0)) return null;
  return +((now / old - 1) * 100).toFixed(2);
}
const chg1hPct = Number(cfg.windowMode?.chg1hPct ?? 8);
const chg6hPct = Number(cfg.windowMode?.chg6hPct ?? 8);
const hits = [];
for (const h of H) {
  const c1 = chgAt(h.t, 3600e3), c6 = chgAt(h.t, 6 * 3600e3);
  const why = [];
  if (c1 != null && c1 >= chg1hPct) why.push(`1h +${c1}%`);
  if (c6 != null && c6 >= chg6hPct) why.push(`6h +${c6}%`);
  if (why.length) hits.push({ t: h.t, price: h.price, c1, c6, why: why.join(' / ') });
}
// 相隔 <60 分钟的命中合并成一个窗口（一个窗口 6 小时，触发会连着报几十次）
const backfill = [];
for (const hit of hits) {
  const last = backfill.at(-1);
  // 合并条件：距上次命中 <60 分钟 **且** 这一段还没到 6 小时。
  // 不封顶会把"价格一路上涨 14 小时"合成一个巨型窗口，把窗口之后好几小时租的机器也算进捕获里
  // （2026-10-30 实测：10-28 的窗口被拉长到次日凌晨，混进了 8 条与窗口无关的租约）。
  if (last && hit.t - last.lastHit < 60 * MIN && hit.t - last.start < 6 * 3600e3) { last.lastHit = hit.t; last.n++; last.why = hit.why; last.peakPrice = Math.max(last.peakPrice, hit.price); continue; }
  backfill.push({ start: hit.t, lastHit: hit.t, n: 1, why: hit.why, price: hit.price, peakPrice: hit.price });
}
for (const w of backfill) {
  // 窗口模式是「进入后 6 小时」，所以窗口区间 = start..start+6h。
  // 用 lastHit+6h 会把连续上涨的尾巴也算成窗口（10-28 那次就被拉长到 12 小时，混进了次日凌晨的租约）。
  w.end = w.start + 6 * 3600e3;
  const ls = leases.filter(l => l.tRent <= w.end && (Number(l.tEnd) || Date.now()) >= w.start);
  const nets = ls.map(netOf);
  w.rents = ls.length;
  w.netUsd = +nets.reduce((a, b) => a + b, 0).toFixed(4);
  w.leases = ls.map(l => ({ id: l.id, tRent: l.tRent, gpu: l.gpu, hostId: l.hostId, endReason: l.endReason || 'open', netUsd: +netOf(l).toFixed(4) }));
}

const summary = {
  at: new Date().toISOString(),
  price,
  episodes: episodes.length,
  captured: episodes.filter(e => e.rents > 0).length,
  captureRate: episodes.length ? +(episodes.filter(e => e.rents > 0).length / episodes.length * 100).toFixed(0) : null,
  windowNetUsd: +episodes.reduce((a, e) => a + e.netUsd, 0).toFixed(4),
  windowRents: episodes.reduce((a, e) => a + e.rents, 0),
  active: !!st.windowState?.active,
};
const out = { summary, episodes, backfill: process.argv.includes('--backfill') ? backfill : [] };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`窗口捕获报告 ${summary.at}｜币价 $${price}`);
console.log(`实盘 episode ${summary.episodes} 个｜捕获 ${summary.captured} 个（${summary.captureRate ?? '—'}%）｜窗口内租 ${summary.windowRents} 台｜窗口净额 $${summary.windowNetUsd}${summary.active ? '｜当前窗口进行中' : ''}`);
if (!summary.episodes) console.log('（还没有 episode：引擎从 2026-10-30 起才记录，历史窗口请看 --backfill）');
if (episodes.length) {
  console.log('\n#  开始(北京)  实际/计划  触发真因                          chg1h  chg6h  ratioPass  租  净额     中位存活  出算力率');
  for (const e of episodes) {
    const i = e.info || {};
    console.log(`${String(e.i).padEnd(2)} ${fmtT(e.start).padEnd(11)} ${String(e.actualMin + '/' + e.plannedMin + 'm').padEnd(9)} ${String(e.reason || '').slice(0, 30).padEnd(31)} ${String(i.chg1h ?? '—').padStart(5)} ${String(i.chg6h ?? '—').padStart(6)} ${String(i.ratioPass ?? '—').padStart(8)} ${String(e.rents).padStart(3)}  ${String(e.netUsd).padStart(8)}  ${String(e.medianLifeMin ?? '—').padStart(7)}  ${String(e.hashedRate ?? '—').padStart(6)}`);
    for (const l of e.leases) console.log(`     └ ${l.gpu} host ${l.hostId} ${l.hours}h 净 $${l.netUsd}（${l.endReason}）`);
  }
}
if (process.argv.includes('--backfill')) {
  console.log(`\n历史窗口回放（只用价格口径，密度÷地板与 ratioPass 无法还原）：命中 ${backfill.length} 个`);
  if (!backfill.length) console.log('（history 里没有 1h/6h 涨幅 ≥ 阈值的连续区间）');
  console.log('开始(北京)  峰值价  持续  触发                       窗口内租  净额');
  for (const w of backfill) {
    console.log(`${fmtT(w.start).padEnd(11)} ${String(w.peakPrice).padStart(6)}  ${String(Math.round((w.end - w.start) / 3600e3) + 'h').padStart(4)}  ${String(w.why).padEnd(26)} ${String(w.rents).padStart(6)}  ${String(w.netUsd).padStart(8)}`);
    for (const l of w.leases) console.log(`     └ ${fmtT(l.tRent || w.start)} ${l.gpu} host ${l.hostId} 净 $${l.netUsd}（${l.endReason}）`);
  }
  console.log('\n⚠ 回放的「窗口内租」= 该时段内开租的租约，不代表窗口一定被抓住了：可能是窗口前下的单，也可能是被节流挡住的。');
}