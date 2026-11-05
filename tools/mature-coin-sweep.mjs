#!/usr/bin/env node
// 成熟币全灭表（2026-11-05）：回答"换币能不能救"。
//
// ⚠ 单位警告（这条比表本身重要）：
//   WhatToMine 的 `nethash` **不是所有算法都用 H/s**。实测：
//     Pearl  8.707e19 → 87.1 EH/s（与我们自己口径一致，H/s ✓）
//     RVN    4.954e11 → 若 H/s 则 0.5 TH/s（公开量级 4–5 TH/s）→ 单位存疑
//     Ergo   5.959e11 → 若 H/s 则 0.6 TH/s（公开量级 15–25 TH/s）→ 单位存疑
//   所以"零系数、直接算密度"只对 **Pearl 这类 nethash 单位可验证的币** 成立。
//   本工具的做法：
//     ① 先算每 TH·天密度；② 用 3080 的算法算力反推 $/h；
//     ③ 若结果落在 [1e-4, 1] $/h 之外 → 标记 unitSuspect，**不参与跨算法排序**；
//     ④ 跨算法比较只在 `--units <algo>=<factor>` 显式给出时才做（不许默认拟合）。
//
// 用法：
//   node tools/mature-coin-sweep.mjs                 # 按算法分组，组内排序
//   node tools/mature-coin-sweep.mjs --units kawpow=0.001   # 显式给单位系数后才跨算法比
import fs from 'node:fs';

const WTM = 'https://whattomine.com/coins.json';
const GATE_BTC = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT';
const CLORE_MIN = 0.0499;      // Clore 3080 最低可租（mrl 6h）
const ROI_REQ = 1.467;         // 与 isRentable 同源：收入 ≥ 成本 × 1.467

// 3080 在各算法上的**公开量级**算力（只用于排序，不用于定价；单位与 WTM 原生单位一致）
const TH3080 = {
  pearl: 68.9,        // 我们实测交付（不是规格）
  kawpow: 0.062,      // 62 MH/s
  autolykos: 0.24,    // 240 MH/s
  etchash: 0.095,     // 95 MH/s
  fishhash: 0.09,
  karlsenhashv2: 0.35,
  cuckatoo32: 0.0016,
};

const unitsArg = process.argv.find(a => a.startsWith('--units'));
const units = {};
if (unitsArg) for (const kv of (process.argv[process.argv.indexOf('--units') + 1] || '').split(',')) {
  const [k, v] = kv.split('='); if (k && v) units[k.toLowerCase()] = Number(v);
}

const btc = Number((await (await fetch(GATE_BTC, { signal: AbortSignal.timeout(15000) })).json())?.[0]?.last) || 0;
const coins = (await (await fetch(WTM, { signal: AbortSignal.timeout(30000) })).json())?.coins || {};

const rows = [];
for (const [name, v] of Object.entries(coins)) {
  const nh = Number(v.nethash), bt = Number(v.block_time), br = Number(v.block_reward), px = Number(v.exchange_rate);
  if (!(nh > 0 && bt > 0 && br > 0 && px > 0 && btc > 0)) continue;
  const algo = String(v.algorithm || '').toLowerCase();
  const usdPerThDay = (br * (3600 / bt) * px * btc) / nh * 1e12 * 24;
  const th = TH3080[algo];
  const factor = units[algo] ?? 1;
  const revHr = th ? usdPerThDay * th / 24 * factor : null;
  const unitSuspect = revHr != null && (revHr < 1e-4 || revHr > 1);
  rows.push({
    coin: name, tag: v.tag, algo, nethash: nh, usdPerThDay: +usdPerThDay.toFixed(5),
    th3080: th ?? null, revHr: revHr == null ? null : +revHr.toFixed(4), unitSuspect,
    ceiling: revHr == null ? null : +(revHr / ROI_REQ).toFixed(4),
    gap: revHr == null ? null : +(CLORE_MIN / (revHr / ROI_REQ)).toFixed(1),
  });
}

// 单位可验证 = 不可疑且有 3080 算力
const usable = rows.filter(r => r.revHr != null && !r.unitSuspect);
usable.sort((a, b) => b.revHr - a.revHr);

if (process.argv.includes('--json')) { console.log(JSON.stringify({ at: new Date().toISOString(), btc, cloreMin: CLORE_MIN, roiReq: ROI_REQ, rows }, null, 2)); process.exit(0); }

console.log(`成熟币全灭表 ${new Date().toISOString()}｜BTC $${btc}｜基准租价 $${CLORE_MIN}/h（Clore 3080 最低）｜门槛 ×${ROI_REQ}`);
console.log(`币 ${rows.length} 个；单位可验证且有 3080 算力的 ${usable.length} 个\n`);
console.log('coin            algo          密度$/TH·天   3080 $/h   达标租价上限   溢价(vs $0.0499)  单位');
for (const r of usable.slice(0, 12)) {
  console.log(`${String(r.coin).padEnd(15)} ${String(r.algo).padEnd(12)} ${String(r.usdPerThDay).padStart(10)} ${String(r.revHr).padStart(9)} ${String(r.ceiling).padStart(12)} ${String(r.gap + '×').padStart(14)}   ok`);
}
const suspect = rows.filter(r => r.unitSuspect);
if (suspect.length) {
  console.log(`\n⚠ 单位存疑（nethash 不是 H/s，本表不参与排序）：${suspect.slice(0, 8).map(r => `${r.coin}(${r.algo})`).join('、')}${suspect.length > 8 ? ' …' : ''}`);
  console.log('  → 这些币的"零系数算密度"不成立；要给系数请用 --units <algo>=<factor> 显式声明，禁止默认拟合。');
}
const best = usable[0];
if (best) {
  const pass = usable.filter(r => r.gap <= 1);
  console.log(`\n结论：pass=${pass.length}；最优 ${best.coin}（${best.algo}）$${best.revHr}/h，仍差 ${best.gap}×`);
  console.log(pass.length ? `✅ 有币过线：${pass.map(r => r.coin).join('、')}` : '⛔ 无币过线——换币种这条路在本租价下关闭');
}
try { fs.appendFileSync('/data/prl-automine/mature-coin-sweep.jsonl', JSON.stringify({ at: new Date().toISOString(), btc, usable: usable.slice(0, 12), suspect: suspect.map(r => r.coin) }) + '\n'); } catch { /* 写不进去不影响输出 */ }