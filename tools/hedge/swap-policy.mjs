#!/usr/bin/env node
// ROI 抢占策略（用户 2026-10-26 定的规则）：
//   1) 48h 内最多 3 台实例；
//   2) 如果市场上出现 ROI 明显更高的竞价机 → 先把它租下来（占第 3 个位），
//      等它稳定出算力并持有 ≥45 分钟，再放弃当前 ROI 最差的那台按需机；
//   3) 永远"先租后弃"：宁可多付一台的短时租金，也不能先销毁再抢不到。
//
// 只读判断 + 可选执行（--execute 才会真的租/销毁）。不碰 state.json，全部走控制台 HTTP。
// 用法：node swap-policy.mjs [--execute] [--json]
const API = 'http://127.0.0.1:8290';
const OUT = process.argv.includes('--json');
const EXEC = process.argv.includes('--execute');

const MIN_GAP_RENT = 20;      // 竞价 ROI 要比最差按需机高 20 个百分点才值得租
const MIN_GAP_SWAP = 15;      // 已经租到的竞价机，比最差按需机高 15pp 才值得弃掉按需机
const MIN_SPOT_HOLD_MIN = 45; // 竞价机必须已稳定挖这么久，才允许弃掉按需机
const MIN_RELIABILITY = 0.97;
const MAX_GPUS = 2;

const j = async (p, opt) => {
  const r = await fetch(API + p, { ...opt, headers: { 'content-type': 'application/json', ...(opt?.headers || {}) } });
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${JSON.stringify(d).slice(0, 120)}`);
  return d;
};

const get = p => j(p);
const post = (p, body = {}) => j(p, { method: 'POST', body: JSON.stringify(body) });

const out = { at: new Date().toISOString(), exec: EXEC, actions: [], reason: '', candidates: [], rigs: [] };

// 1) 让控制台按竞价模式扫一次（策略本身需要知道市场上有什么）
//    注意：不能覆盖用户/实验设定的花费上限，只改扫描模式与目标收益率
const before = await get('/api/state');
await post('/api/settings', {
  useSpot: true, maxInstances: 3,
  // 不覆盖实验设定的目标收益率：正在做「-5% 出价能否站住」的对照实验
  targetProfitPct: before.config.targetProfitPct,
  maxHourlySpend: before.config.maxHourlySpend,
});
await post('/api/scan');
const s = await get('/api/state');

const cfg = s.config;
const inst = s.instances || [];
const spend = s.summary.spendHr || 0;
const room = Math.max(0, (cfg.maxHourlySpend || 0) - spend);
const slots = Math.max(0, (cfg.maxInstances || 0) - inst.length);

// 现有机器（按 ROI 升序，最差在前）
// pinned 是测量锚点（实验机），不参与 ROI 替换：换掉它等于把正在采的数据扔了
const rigs = inst.filter(i => i.managed && !i.pinned).map(i => ({
  id: String(i.id), gpu: i.gpuName, pool: i.pool, spot: !!i.spot, phase: i.phase,
  roi: i.roi, dph: i.dph, hs: i.avgHs, ageMin: i.ageMin,
})).sort((a, b) => (a.roi ?? -999) - (b.roi ?? -999));
out.rigs = rigs;

// 矿池覆盖护栏：不能把某个矿池的最后一台机器弃掉，否则跨池对照/realizedFactor
// 的判定来源就没了（Kryptex 是唯一的 PPS+ 池，只用于测 realizedFactor）。
const poolCount = rigs.reduce((a, r) => (a[r.pool] = (a[r.pool] || 0) + 1, a), {});
const keepPool = new Set(Object.entries(poolCount).filter(([, n]) => n <= 1).map(([p]) => p));
const droppable = rigs.filter(r => !r.spot && !keepPool.has(r.pool));
const worst = droppable[0] || null;
if (!worst && keepPool.size) {
  out.keepPool = [...keepPool];
}
const spotRigs = rigs.filter(r => r.spot && r.phase === 'mining' && (r.ageMin || 0) >= MIN_SPOT_HOLD_MIN);
const bestSpot = (s.offers || [])
  .filter(o => o.bid != null && o.numGpus <= MAX_GPUS && (o.reliability || 0) >= MIN_RELIABILITY && o.autoOk !== false)
  .sort((a, b) => b.roi - a.roi)
  .slice(0, 5)
  .map(o => ({ id: o.id, gpu: o.gpuName, n: o.numGpus, minBid: o.minBid, bid: o.bid, roi: o.roi, rel: o.reliability, geo: o.geolocation }));
out.candidates = bestSpot;

// 2) 已经租到竞价机并稳定 → 弃掉最差的按需机
//    两种触发条件：
//    a) ROI 领先 ≥ MIN_GAP_SWAP（不同型号之间的替换）
//    b) 同型号按需机存在、竞价机租金至少便宜 10%（等价硬件，纯省钱，不需要等 ROI 拉开）
const SAME_GPU_DISCOUNT = 0.9;
const sameGpu = spotRigs.find(r => {
  const od = rigs.find(x => !x.spot && x.gpu === r.gpu && !keepPool.has(x.pool));
  return od && r.dph > 0 && od.dph > 0 && r.dph <= od.dph * SAME_GPU_DISCOUNT;
});
const swap = sameGpu || spotRigs.find(r => worst && r.roi != null && worst.roi != null && r.roi >= worst.roi + MIN_GAP_SWAP);
if (sameGpu) {
  const od = rigs.find(x => !x.spot && x.gpu === sameGpu.gpu && !keepPool.has(x.pool));
  out.reason = `同型号替换：竞价 ${sameGpu.id}（$${sameGpu.dph.toFixed(4)}/h）比按需 ${od.id}（$${od.dph.toFixed(4)}/h）便宜 ${((1 - sameGpu.dph / od.dph) * 100).toFixed(0)}%，且已稳定 ${Math.round(sameGpu.ageMin)} 分钟`;
  out.swapTarget = od.id;
  if (EXEC) {
    await post(`/api/instances/${od.id}/destroy`);
    out.actions.push(`已销毁按需机 ${od.id}（${od.gpu}，$${od.dph.toFixed(4)}/h），保留竞价机 ${sameGpu.id}，每小时省 $${(od.dph - sameGpu.dph).toFixed(4)}`);
  } else {
    out.actions.push(`[dry] 建议销毁按需机 ${od.id}，保留竞价机 ${sameGpu.id}`);
  }
}
if (!sameGpu && swap && worst) {
  out.reason = `竞价机 ${swap.id}（${swap.gpu}，ROI ${swap.roi.toFixed(1)}%，已挖 ${Math.round(swap.ageMin)} 分钟）比按需机 ${worst.id}（ROI ${worst.roi.toFixed(1)}%）高 ${(swap.roi - worst.roi).toFixed(1)}pp`;
  if (EXEC) {
    await post(`/api/instances/${worst.id}/destroy`);
    out.actions.push(`已销毁按需机 ${worst.id}（${worst.gpu}，ROI ${worst.roi.toFixed(1)}%），保留竞价机 ${swap.id}`);
  } else {
    out.actions.push(`[dry] 建议销毁按需机 ${worst.id}，保留竞价机 ${swap.id}`);
  }
} else if (bestSpot.length && slots > 0 && worst) {
  // 3) 有空位 → 先租更高 ROI 的竞价机
  const cand = bestSpot.find(o => o.bid <= room && o.roi >= (worst.roi ?? -999) + MIN_GAP_RENT);
  if (cand) {
    out.reason = `最优竞价 ${cand.gpu}×${cand.n} 出价 $${cand.bid}/h、ROI ${cand.roi.toFixed(1)}%，比按需机 ${worst.id}（ROI ${(worst.roi ?? 0).toFixed(1)}%）高 ${(cand.roi - (worst.roi ?? 0)).toFixed(1)}pp，且预算剩 $${room.toFixed(3)}/h`;
    if (EXEC) {
      try {
        const r = await post(`/api/rent/${cand.id}`);
        out.actions.push(`已租竞价机 ${cand.gpu}（offer ${cand.id}）→ 实例 ${r.id}；稳定 ${MIN_SPOT_HOLD_MIN} 分钟后才会弃掉按需机`);
      } catch (e) {
        out.actions.push(`租用失败：${e.message}`);
      }
    } else {
      out.actions.push(`[dry] 建议租用 offer ${cand.id}（${cand.gpu}，ROI ${cand.roi.toFixed(1)}%）`);
    }
  } else {
    out.reason = '没有比现有机器高 ' + MIN_GAP_RENT + 'pp 且装得下的竞价机';
  }
} else if (!out.reason) {
  out.reason = slots > 0 ? '没有可比较的按需机或候选' : '已满 3 台，等竞价机稳定后再决定是否替换';
}

if (OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`ROI 抢占检查 ${new Date().toISOString().replace('T', ' ').slice(0, 19)}Z${EXEC ? '（执行模式）' : '（只读）'}`);
  for (const r of rigs) console.log(`  现役 ${r.id} ${r.spot ? '竞价' : '按需'} ${r.gpu} | ${r.phase} | ROI ${r.roi == null ? '—' : r.roi.toFixed(1) + '%'} | ${r.pool} | ${Math.round(r.ageMin)}min`);
  if (bestSpot.length) console.log(`  最优竞价：${bestSpot.slice(0, 3).map(o => `${o.gpu} ROI ${o.roi.toFixed(0)}% @$${o.bid}`).join(' | ')}`);
  if (out.keepPool) console.log(`  矿池护栏：${out.keepPool.join('、')} 只剩 1 台，不参与替换（保住跨池对照）`);
  console.log(`  结论：${out.reason}`);
  for (const a of out.actions) console.log(`  → ${a}`);
}
process.exit(out.actions.some(a => !a.startsWith('[dry]')) ? 0 : 1);