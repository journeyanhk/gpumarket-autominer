#!/usr/bin/env node
// 触发板 T1–T5 的每日重算（2026-11-04 用户要求：阈值不能写死在文档里，
// 因为它是由 th / 密度 / 目标 ROI 推出来的，输入一变阈值就该跟着变）。
//
// 输出两件事：①每个触发器的当前阈值与它**由什么推出来**（derivedFrom）；
// ②是否命中。日报直接引用这份输出，不再抄旧数字。
//
// 用法：node tools/triggers.mjs [--json]
import fs from 'node:fs';

const CTRL = 'http://127.0.0.1:8290/api/state';
const SCAN = '/data/prl-automine/gpu-coin-daily.jsonl';

const st = await (await fetch(CTRL, { signal: AbortSignal.timeout(10000) })).json();
const price = Number(st?.market?.price) || null;
const density = Number(st?.market?.usdPerThDay) || null;
const target = Number(st?.config?.targetProfitPct) || 20;

const rows = st?.pricingTable || [];
const pick = (re) => rows.find(r => re.test(r.model));
const r3080 = pick(/3080(?!\s*Ti)/i) || pick(/3080/i);

// T4：Clore 3080 的"达标线"——必须用**面板当前 th**（可能来自 pooled/台账样本），
// 并把它是由哪个 thSource 推出来的写进 derivedFrom，避免又出现"阈值引用了旧口径"的漂移。
let t4 = null;
if (r3080 && density > 0) {
  const th = Number(r3080.th) || 0;
  const ceiling = +(th * density / 24 / (1 + target / 100)).toFixed(4);
  t4 = {
    id: 'T4', hit: false, threshold: ceiling,
    derivedFrom: `3080 th=${th} (thSource=${r3080.thSource}, thCalibrated=${r3080.thCalibrated}) × 密度 ${density} ÷24 ÷(1+${target}%)`,
    note: r3080.thCalibrated === false ? '⚠ th 未校准（pooled/spec），阈值本身是上界，命中也要人工复核' : null,
  };
  t4.rule = `Clore mrl≤24h 且 3080 Spot ≤ $${ceiling}`;
}

// T1：价格线（库存变现线，用户 2026-11-03 定 $1.90）
const t1 = { id: 'T1', hit: price != null && price >= 1.9, threshold: 1.9, value: price, derivedFrom: '用户 2026-11-03 定：PRL<$1.9 不报差额' };

// T2/T5：矿工流向（Pearl 24h 难度）——读最近一行 scan
let scan = null;
try {
  const lines = fs.readFileSync(SCAN, 'utf8').trim().split('\n').filter(Boolean);
  scan = JSON.parse(lines[lines.length - 1]);
} catch { /* 没有采集文件就跳过 */ }
// gpu-coin-scan 的一行里有：pearl = Pearl 24h 难度变化(%)、kryptex.sharePct = 池占比
const pearlChg = Number(scan?.pearl ?? NaN);
const t2 = { id: 'T2', hit: Number.isFinite(pearlChg) && pearlChg <= -1.5, value: Number.isFinite(pearlChg) ? pearlChg : null, threshold: -1.5, derivedFrom: 'PLAN §8：矿工撤离 Pearl 才可能让密度回升' };

// T3：Kryptex 池占比（低于 7 日中位 5 个点）
const share = Number(scan?.kryptex?.sharePct ?? NaN);
const shareMed = Number(scan?.shareBaseline7d ?? NaN);
const t3 = { id: 'T3', hit: Number.isFinite(share) && Number.isFinite(shareMed) && share <= shareMed - 5,
  value: Number.isFinite(share) ? share : null, threshold: Number.isFinite(shareMed) ? +(shareMed - 5).toFixed(1) : null,
  derivedFrom: '7 日中位 −5pt（供给回流信号）' };

// T5：难度继续挤入 / 全市场撤离
const t5 = { id: 'T5', hit: Number.isFinite(pearlChg) && pearlChg >= 3, value: Number.isFinite(pearlChg) ? pearlChg : null, threshold: 3, derivedFrom: 'Pearl 难度 +3% = 仍在挤入' };

const board = [t1, t2, t3, t4, t5].filter(Boolean);
const hits = board.filter(t => t.hit);

const out = { at: new Date().toISOString(), price, density, targetProfitPct: target, board, hits: hits.map(h => h.id), window: st?.window?.info?.ratioPass ?? null, windowActive: !!st?.window?.active };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`触发板 ${out.at}｜PRL $${price ?? '—'}｜密度 $${density ?? '—'}/TH·天｜ratioPass ${out.window ?? 'null'}`);
for (const t of board) {
  const v = t.value != null ? `当前 ${typeof t.value === 'number' ? t.value.toFixed(t.value < 10 ? 2 : 1) : t.value}` : '当前 —';
  console.log(`${t.hit ? '✅' : '·'} ${t.id} 阈值 ${t.threshold ?? '—'}｜${v}｜由 ${t.derivedFrom}`);
  if (t.note) console.log(`   ${t.note}`);
}
console.log(hits.length ? `命中：${hits.map(h => h.id).join('、')}` : '无命中（保持静默）');