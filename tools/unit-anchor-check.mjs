#!/usr/bin/env node
// 单位锚点检查（2026-11-05）：证明"WTM 的 nethash 是 H/s"这件事，而不是靠记忆里的量级。
//
// 为什么要有它：我上一次用"RVN 4–5 TH/s、Ergo 15–25 TH/s"去质疑 WTM，那是 2021–2022 的数字；
// 今天实测 RVN 0.48 TH/s、Ergo 0.59 TH/s。**用记忆质疑实测，和用记忆冒充系数是同一个错误的两面。**
// 规则：每个算法一个独立来源，比值必须落在 [0.8, 1.25]；缺锚点的算法 → 其币在漏斗里只能是 watch。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, 'unit-anchors.json');
const RATIO_MIN = 0.8, RATIO_MAX = 1.25;

const src = {
  async ergo() { const d = await (await fetch('https://api.ergoplatform.com/info', { signal: AbortSignal.timeout(15000) })).json(); return Number(d.hashRate); },
  async rvn() { const d = await (await fetch('https://rvn.cryptoscope.io/api/getnetworkhashps', { signal: AbortSignal.timeout(15000) })).json(); return Number(d.hashrate_raw); },
  async pearl() {
    // 用我们自己的引擎口径：87.6 EH/s（state.market.networkHs），拿不到就跳过
    const st = await (await fetch('http://127.0.0.1:8290/api/state', { signal: AbortSignal.timeout(8000) })).json();
    return Number(st?.market?.networkHs) || null;
  },
};

const wtm = (await (await fetch('https://whattomine.com/coins.json', { signal: AbortSignal.timeout(30000) })).json())?.coins || {};
const byCoin = (name) => Object.entries(wtm).find(([k]) => k.toLowerCase().includes(name.toLowerCase()))?.[1];

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rows = [];
for (const [algo, a] of Object.entries(data.anchors)) {
  if (a.status === 'pending') { rows.push({ algo, status: 'pending', note: a.source }); continue; }
  let live = null;
  try { live = await src[algo === 'pearl' ? 'pearl' : algo === 'autolykos' ? 'ergo' : 'rvn'](); } catch { /* 拉不到就用旧值 */ }
  const w = byCoin(a.coin);
  const wtmNow = Number(w?.nethash) || a.wtmNethash;
  const anchor = live || a.anchorHashrate;
  const ratio = +(wtmNow / anchor).toFixed(3);
  const ok = ratio >= RATIO_MIN && ratio <= RATIO_MAX;
  data.anchors[algo] = { ...a, wtmNethash: wtmNow, anchorHashrate: anchor, ratio, checkedAt: new Date().toISOString(), status: ok ? 'ok' : 'FAIL' };
  rows.push({ algo, ratio, ok, live: live ? 'live' : 'cached' });
}
data.checkedAt = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');

for (const r of rows) {
  if (r.status === 'pending') console.log(`· ${r.algo.padEnd(10)} pending（${r.note}）→ 该算法的币只能 watch`);
  else console.log(`${r.ok ? '✓' : '✗'} ${r.algo.padEnd(10)} ratio=${r.ratio}（${r.live}）${r.ok ? '' : ' ← 单位可能变了，立即停用该算法的 pass'}`);
}
const bad = rows.filter(r => r.ok === false);
console.log(bad.length ? `\n单位断言失败 ${bad.length} 个算法` : '\n单位断言通过');
process.exit(bad.length ? 1 : 0);
