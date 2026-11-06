#!/usr/bin/env node
// D14 判决（2026-11-11 执行；11-07 起每天 dry-run，不许 11-11 才首跑）
// 默认 dry-run：只输出，不写任何状态、不改任何配置。
import fs from 'node:fs';

const CTRL = 'http://127.0.0.1:8290/api/state';
const LIVE = process.argv.includes('--live');   // 只有显式 --live 才允许提出动作建议（仍不改配置）

const st = await (await fetch(CTRL, { signal: AbortSignal.timeout(10000) })).json();
const leases = st?.leases?.byModel ? null : null;
const raw = JSON.parse(fs.readFileSync('/data/gpumarket-autominer/data/state.json', 'utf8'));
const all = raw.leases || [];
const price = Number(st?.market?.price) || 0;

// ① ≥1 次净正完整闭环：入账×币价 − 实付 > 0（严格：含变现费则更难，这里先算租约口径）
const closed = all.filter(l => l.tEnd).map(l => {
  const h = (new Date(l.tEnd) - new Date(l.tRent)) / 36e5;
  const paid = (Number(l.dphTotalActual) || 0) * h;
  const rev = (Number(l.creditedPrl) || 0) * price;
  return { id: l.id, net: +(rev - paid).toFixed(4), h: +h.toFixed(2), prl: l.creditedPrl };
});
const positive = closed.filter(c => c.net > 0);

// ② 回放期望为正 + P(存活≥30min) ≥ 0.3
const r3080 = (st?.pricingTable || []).find(r => /3080(?!\s*Ti)/i.test(r.model));
const gapPct = Number(r3080?.gapPct);
const survive = closed.filter(c => c.h >= 0.5).length / Math.max(1, closed.length);
const c2 = { pass: Number.isFinite(gapPct) && gapPct < 0 && survive >= 0.3, gapPct, survivePct: +(survive * 100).toFixed(0) };

// ③ vast 窗口期整卡供给 ≥2
const whole = Number(st?.offerStats?.wholeCount);
const c3 = { pass: whole >= 2, whole };

const verdict = c2.pass ? 'PASS' : 'FAIL(②)';
const lines = [
  `D14 verdict=${verdict} (dry-run=${!LIVE})`,
  `① net-positive closed loop: ${positive.length ? 'PASS' : 'FAIL'}｜${closed.length} 条租约，正收益 ${positive.length} 条，最佳 ${positive.sort((a, b) => b.net - a.net)[0]?.net ?? '—'}`,
  `② replay expectation: ${c2.pass ? 'PASS' : 'FAIL'}｜gap=${gapPct ?? '—'}%（需 <0），P(≥30min)=${c2.survivePct}%（需 ≥30%）`,
  `③ vast whole-card supply: ${c3.pass ? 'PASS' : 'FAIL'}｜${whole} 条（需 ≥2）`,
];
if (!c2.pass) lines.push('action=建议 rentEnabled=false → 只读监测（11-11 执行，改配置需用户确认）');
console.log(lines.join('\n'));
