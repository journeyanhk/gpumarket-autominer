#!/usr/bin/env node
// 追价 dry-run 汇总（只读，零成本）：把每次「被顶」时算出来的三元组统计出来，
// 回答「追价救不活到底是机制（房东收回）还是门槛（我们出价太低）」。
//
// 数据来源：data/state.json 的 st.raiseLog（tryRaiseBid 每次被顶都写一条，与机器是否销毁无关）。
// 字段：cur 我方出价 / minBid 当下 min_bid / requiredRaise=minBid÷cur / kind=chase|reentry /
//       target 若追会出的价 / upper 20% ROI 允许的上限 / viable / reject=max_raises|not_viable /
//       decided=raise|skip
//
// 用法：node tools/raise-report.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'state.json'), 'utf8')); } catch { return {}; } })();
const log = (st.raiseLog || []).slice();
const q = (a, p) => { const v = [...a].filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };

const by = (f) => log.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
const chase = log.filter(r => r.kind === 'chase');
const reentry = log.filter(r => r.kind === 'reentry');
const out = {
  at: new Date().toISOString(),
  rows: log.length,
  byKind: by(r => r.kind || 'unknown'),
  byReject: by(r => r.reject || 'would_submit'),
  byDecided: by(r => r.decided || 'unknown'),
  requiredRaise: {
    p10: q(log.map(r => r.requiredRaise), 0.1), p50: q(log.map(r => r.requiredRaise), 0.5), p90: q(log.map(r => r.requiredRaise), 0.9),
    chaseP50: q(chase.map(r => r.requiredRaise), 0.5), reentryP50: q(reentry.map(r => r.requiredRaise), 0.5),
  },
  headroom: { // target ≤ upper 的比例：能追却被闸门挡住 = 门槛问题；本来就追不起 = 机制问题
    viablePct: log.length ? +(log.filter(r => r.viable).length / log.length * 100).toFixed(0) : null,
    viableButBlocked: log.filter(r => r.viable && r.reject === 'max_raises').length,
  },
  recent: log.slice(-5),
};

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`追价 dry-run 汇总 ${out.at}｜样本 ${out.rows} 条`);
if (!out.rows) { console.log('（还没有被顶记录：raiseLog 从 2026-11-02 起才有）'); process.exit(0); }
console.log(`  分类：${Object.entries(out.byKind).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
console.log(`  闸门：${Object.entries(out.byReject).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
console.log(`  requiredRaise（对手价÷我方出价）：P10 ${out.requiredRaise.p10} / P50 ${out.requiredRaise.p50} / P90 ${out.requiredRaise.p90}`);
console.log(`    · 追价类(chase ≤1.5×) P50 ${out.requiredRaise.chaseP50}（${chase.length} 条）`);
console.log(`    · 重新入场类(reentry >1.5×) P50 ${out.requiredRaise.reentryP50}（${reentry.length} 条）`);
console.log(`  在利润带内(viable) ${out.headroom.viablePct}%，其中被 maxRaises 挡掉的 ${out.headroom.viableButBlocked} 条`);
console.log('  最近 5 条：');
for (const r of out.recent) console.log(`    ${new Date(r.at).toISOString()} ${r.gpu || '?'} host ${r.host ?? '—'} cur $${r.cur} min_bid $${r.minBid}（${r.requiredRaise}× ${r.kind}）→ ${r.decided}${r.reject ? `/${r.reject}` : ''}`);