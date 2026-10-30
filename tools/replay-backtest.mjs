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

const out = { at: new Date().toISOString(), price, leases: leases.length, hardBans: hardBans.size, softBans: softBans.size, caveat: '用事后 realized ROI 筛选，仅用于参数间相对比较，不能预测绝对收益', rows };

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`参数回放 ${out.at}｜币价 $${price}｜已结束租约 ${leases.length} 条｜7天硬封 ${hardBans.size} 个 / 24h观察 ${softBans.size} 个`);
console.log(`⚠ ${out.caveat}\n`);
console.log('门槛  硬封房东  价格地板   留下  跳过   净额      每机时净收益  出算力率  中位存活');
for (const r of rows) {
  console.log(`${String(r.target + '%').padEnd(5)} ${(r.hostBan ? '是' : '否').padEnd(10)} ${(r.floor ? '是' : '否').padEnd(9)} ${String(r.taken).padStart(5)} ${String(r.skipped).padStart(5)}  ${String(r.netUsd).padStart(8)}  ${String(r.netPerMachineHour ?? '—').padStart(12)}  ${String(r.hashedRate ?? '—').padStart(7)}  ${String(r.medianLifeMin ?? '—').padStart(7)}`);
}
const best = [...rows].filter(r => r.taken >= 5).sort((a, b) => (b.netPerMachineHour ?? -1e9) - (a.netPerMachineHour ?? -1e9))[0];
if (best) console.log(`\n样本 ≥5 的最优参数：门槛 ${best.target}% / 房东黑名单 ${best.hostBan ? '开' : '关'} / 价格地板 ${best.floor ? '开' : '关'} → 每机时 ${best.netPerMachineHour}、留下 ${best.taken} 条`);