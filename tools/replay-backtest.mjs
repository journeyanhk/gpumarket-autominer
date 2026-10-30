#!/usr/bin/env node
// 参数回放（B 线，零成本、只读）：用真实台账回放不同参数下的「假想结果」。
//
// 重要 caveat（必须印在输出里）：这里用的是**事后**已知的 realized ROI 做筛选，
// 所以它回答的是"如果当初就按这个门槛筛，已经发生的这批租约会留下哪些、净亏多少"，
// 不是"这个门槛未来的期望"。它适合比较参数间的相对差异，不适合预测绝对收益。
//
// 用法：node tools/replay-backtest.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.cwd(), 'data');
const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return {}; } })();
const price = Number([...(st.history || [])].reverse().find(h => Number(h.price) > 0)?.price) || 0;
const leases = (st.leases || []).filter(l => l.tEnd && l.tRent);

const hoursOf = l => Math.max(0, (l.tEnd - l.tRent) / 3_600_000);
const paidOf = l => (Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) * hoursOf(l);
const netOf = l => (Number(l.creditedPrl) || 0) * price - paidOf(l);
const roiOf = l => { const p = paidOf(l); return p > 0 ? (netOf(l) / p) * 100 : null; };
const median = a => { const v = [...a].filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// 已知的坏房东：必须区分「7 天硬封」与「24h 观察/假释」——
// 前者是钓鱼/高频收回，后者只是样本不足，把后者也当坏人会连带筛掉唯一赚钱的房东
// （2026-10-30 回放实测：房东 97161 有 3 条租约、中位存活 103 分钟、每机时 +$0.024，但它在 24h 观察名单里）。
const nowMs = Date.now();
const banInfo = st.hostBans || {};
const hardBans = new Set(Object.entries(banInfo).filter(([, v]) => (v.until - nowMs) > 3 * 24 * 3600e3).map(([k]) => String(k)));
const softBans = new Set(Object.entries(banInfo).filter(([, v]) => (v.until - nowMs) <= 3 * 24 * 3600e3).map(([k]) => String(k)));
// 钓鱼/错标：paid 极低或挂牌远低于型号中位（用成交价 < 0.02 近似）
const looksFake = l => (Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) < 0.02;

const sets = [];
for (const target of [15, 20, 25, 30]) {
  for (const hostBan of [true, false]) {
    for (const floor of [true, false]) {
      sets.push({ target, hostBan, floor });
    }
  }
}

const rows = sets.map(s => {
  const kept = leases.filter(l => {
    // hostBan=on → 只排除 7 天硬封；观察期房东仍允许（与运行时“假释期只许 1 台”一致，回放里简化成允许）
    if (s.hostBan && hardBans.has(String(l.hostId))) return false;
    if (s.floor && looksFake(l)) return false;
    const r = roiOf(l);
    return r != null && r >= s.target;
  });
  const net = kept.reduce((a, l) => a + netOf(l), 0);
  const h = kept.reduce((a, l) => a + hoursOf(l), 0);
  const lives = kept.map(l => hoursOf(l) * 60);
  const hashed = kept.filter(l => l.tFirstShare).length;
  return {
    ...s, taken: kept.length, skipped: leases.length - kept.length,
    netUsd: +net.toFixed(4),
    netPerMachineHour: h > 0.01 ? +(net / h).toFixed(4) : null,
    hours: +h.toFixed(2),
    hashedRate: kept.length ? +(hashed / kept.length * 100).toFixed(0) : null,
    medianLifeMin: median(lives) == null ? null : +median(lives).toFixed(0),
  };
});

// 房东三层制：用同一批租约的已实现结果推导档位（与引擎同规则）。
// 注意：白名单本身也是这样推出来的，所以"白名单房东很赚"同样是事后信息，不能当预测。
const tierLedger = {};
for (const l of leases) {
  const h = String(l.hostId ?? '—');
  const b = tierLedger[h] ||= { n: 0, reclaims: 0, lives: [], hours: 0, paid: 0, prl: 0 };
  const hrs = hoursOf(l);
  b.n++; b.lives.push(hrs * 60); b.hours += hrs;
  b.paid += (Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) * hrs;
  b.prl += Number(l.creditedPrl) || 0;
  if (l.endReason === 'host_reclaim') b.reclaims++;
}
const tiers = Object.entries(tierLedger).map(([hostId, b]) => {
  const med = median(b.lives);
  const netPerHr = b.hours > 0.01 ? +((b.prl * price - b.paid) / b.hours).toFixed(4) : null;
  const rate = b.n ? b.reclaims / b.n * 100 : 0;
  let tier = '中性';
  if (rate > 60 && med != null && med < 20 && b.n >= 2) tier = '硬封 7 天';
  else if (b.reclaims >= 2) tier = '观察 24h';
  else if (b.reclaims >= 1 && med != null && med < 20) tier = '观察 24h';
  if (b.n >= 3 && med != null && med > 60 && netPerHr != null && netPerHr > 0 && tier !== '硬封 7 天') tier = '白名单';
  return { hostId, n: b.n, reclaims: b.reclaims, rate: +rate.toFixed(0), medianLifeMin: med == null ? null : +med.toFixed(0), netPerMachineHour: netPerHr, tier };
}).sort((a, b) => (b.netPerMachineHour ?? -1e9) - (a.netPerMachineHour ?? -1e9));

const r20 = rows.find(r => r.target === 20 && r.hostBan && r.floor);
const caveat = '用事后 realized ROI 筛选：只能证明「筛选能剔掉亏的」，不能证明「筛选后的期望收益」';
const survivorship = {
  kept: rows.find(r => r.target === 20 && r.hostBan && r.floor)?.taken ?? null,
  why: [
    `回放用的 ${leases.length} 条租约都是「旧参数下已经租到」的机器，只回答"当时按这个门槛，哪些会被剔掉"。`,
    '它看不到两件事：① 被筛掉的 offer 后来活了多久；② 20% 门槛下本来会租到的其它机器（那些时点根本没下单）。',
    `所以"留下 ${r20?.taken ?? '—'} 条、每机时 ${r20?.netPerMachineHour ?? '—'}"证明的是筛选有效，不是这就是期望收益。`,
    '期望 = 每机时净收益 × P(过线 offer 能租到) × P(租到后活下来)，后两项在回放里恒等于 1（偏差就来自这里）。',
    '真正的正面检验是窗口回放：node tools/window-report.mjs --backfill（窗口期能不能租到、租到后活多久）。',
  ],
};

const out = { at: new Date().toISOString(), price, leases: leases.length, hardBans: hardBans.size, softBans: softBans.size, caveat, survivorship, rows, tiers };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`参数回放 ${out.at}｜币价 $${price}｜已结束租约 ${leases.length} 条｜7天硬封 ${hardBans.size} 个 / 24h观察 ${softBans.size} 个`);
console.log(`\n⚠ 幸存者偏差（必读）`);
for (const line of survivorship.why) console.log(`  · ${line}`);
console.log('');
console.log('门槛  硬封房东  价格地板   留下  跳过   净额      每机时净收益  出算力率  中位存活');
for (const r of rows) {
  console.log(`${String(r.target + '%').padEnd(5)} ${(r.hostBan ? '是' : '否').padEnd(10)} ${(r.floor ? '是' : '否').padEnd(9)} ${String(r.taken).padStart(5)} ${String(r.skipped).padStart(5)}  ${String(r.netUsd).padStart(8)}  ${String(r.netPerMachineHour ?? '—').padStart(12)}  ${String(r.hashedRate ?? '—').padStart(7)}  ${String(r.medianLifeMin ?? '—').padStart(7)}`);
}
const best = [...rows].filter(r => r.taken >= 5).sort((a, b) => (b.netPerMachineHour ?? -1e9) - (a.netPerMachineHour ?? -1e9))[0];
if (best) console.log(`\n样本 ≥5 的最优参数：门槛 ${best.target}% / 房东黑名单 ${best.hostBan ? '开' : '关'} / 价格地板 ${best.floor ? '开' : '关'} → 每机时 ${best.netPerMachineHour}、留下 ${best.taken} 条`);

console.log('\n房东三层制（同一批租约的已实现结果；白名单也是事后推出来的，不是预测）');
console.log('房东       样本 收回 收回率 中位存活  每机时净收益  档位');
for (const t of tiers) {
  console.log(`${t.hostId.padEnd(10)} ${String(t.n).padStart(4)} ${String(t.reclaims).padStart(4)} ${String(t.rate + '%').padStart(5)} ${String(t.medianLifeMin ?? '—').padStart(8)}  ${String(t.netPerMachineHour ?? '—').padStart(11)}  ${t.tier}`);
}
const wl = tiers.filter(t => t.tier === '白名单');
const hard = tiers.filter(t => t.tier === '硬封 7 天');
console.log(`白名单 ${wl.length} 个${wl.length ? `（${wl.map(t => t.hostId).join('、')}）` : ''}；硬封 ${hard.length} 个；其余为观察/中性`);
