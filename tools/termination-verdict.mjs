#!/usr/bin/env node
// 终止判决（2026-11-12 立项，12-31 执行）：让那一天**不需要人判断任何东西**。
//
// 判据（§6.16，预注册）：
//   到 2026-12-31 为止，新币监测未出现"连续 3 天"满足
//   density ≥ minRentablePrice × (1+roiReq) × 24 ÷ th（双源取小、CPU 影子腿计入）的标的
//   → TRIGGERED（终止）：停一切实验支出、降只读、按 TERMINATION_STATEMENT 归档
//
// 数据来源：data/offerLog/newcoin-YYYYMMDD.jsonl（每日一行，由 new-coin-watch --append 写入）
// 默认 dry-run：只读、不写、不改配置。
import fs from 'node:fs';
import path from 'node:path';

const LOGDIR = '/data/gpumarket-autominer/data/offerLog';
const DEADLINE = '2026-12-31';
const NEED_DAYS = 3;

const argDate = (() => { const i = process.argv.indexOf('--asof'); return i > 0 ? process.argv[i + 1] : new Date().toISOString().slice(0, 10); })();
const LIVE = process.argv.includes('--live');

function readNewcoinSeries() {
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(LOGDIR).filter(f => /^newcoin-\d{8}\.jsonl$/.test(f)).sort(); } catch { /* 没有就空 */ }
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(path.join(LOGDIR, f), 'utf8').trim().split('\n').filter(Boolean)) {
        try { rows.push(JSON.parse(line)); } catch { /* 单行坏不影响整体 */ }
      }
    } catch { /* 单文件坏不影响整体 */ }
  }
  return rows;
}

const series = readNewcoinSeries();
// 按天聚合：某天是否出现"≥1 个标的越过阈值"
const byDay = new Map();
for (const r of series) {
  const day = (r.at || '').slice(0, 10);
  if (!day) continue;
  const hit = (r.candidates || []).some(c => c.density != null && c.threshold != null && c.density >= c.threshold);
  byDay.set(day, byDay.get(day) || false);
  if (hit) byDay.set(day, true);
}
const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
let streak = 0, best = 0;
for (const [, hit] of days) { streak = hit ? streak + 1 : 0; best = Math.max(best, streak); }

const triggered = best < NEED_DAYS;
const out = {
  at: new Date().toISOString(), asOf: argDate, live: LIVE,
  daysWithData: days.length, bestStreak: best, needDays: NEED_DAYS,
  verdict: triggered ? 'TRIGGERED' : 'NOT_TRIGGERED',
  reason: triggered
    ? `新币监测最长连续达标 ${best} 天 < ${NEED_DAYS} → 触发终止条件`
    : `曾出现连续 ${best} 天达标 → 不触发终止`,
  statement: 'TERMINATION_STATEMENT（见 src/m3/constants.js）',
};

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`终止判决 ${out.at}（asof=${out.asOf}，dry-run=${!LIVE}）`);
console.log(`数据：${out.daysWithData} 天有记录；最长连续达标 ${out.bestStreak} 天（需 ${NEED_DAYS}）`);
console.log(`verdict=${out.verdict}`);
console.log(`reason=${out.reason}`);
if (triggered && LIVE) console.log('action=停实验支出 → 只读 → 按 TERMINATION_STATEMENT 归档（改配置需用户确认）');
else if (triggered) console.log('action=（dry-run）到 12-31 用 --live 再跑一次');