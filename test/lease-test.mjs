// 租约台账 + 追价开关 + 对手价位：三条改动的回归测试。
// 只跑本地纯逻辑与 mock，不会真的租机器。
//
// 注意：必须先 chdir 到临时目录再 import 引擎——store.js 的 DATA_DIR 是在 import 时
// 用 process.cwd() 算出来的，先 import 再 chdir 就会写到生产 data/state.json 上
// （2026-10-27 踩过一次：引擎重启时报「实例 501 已不在 vast 列表中」）。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
process.chdir(dir);
const U = p => pathToFileURL(path.join(dir, p)).href;
const { Engine } = await import(U('src/engine.js'));
const { summarize, netUsdOf, preemptKindOf, endReasonOf, newLease, closeLease, hoursOf } = await import(U('src/leases.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const MIN = 60_000;

console.log('— (a) 追价开关默认关闭');
{
  const e = new Engine();
  e.log = () => {};
  ok(Number(e.cfg.maxBidRaises) === 0, `默认 maxBidRaises=0（当前 ${e.cfg.maxBidRaises}）`);
  e.rawInstances = [{ id: 501, label: '', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.12, dph_base: 0.12, actual_status: 'stopped', intended_status: 'stopped', start_date: Date.now() / 1000 - 600, machine_id: 9, min_bid: 0.2 }];
  const id = '501';
  e.st.managed[id] = { rentedAt: Date.now() - 10 * MIN, gpuName: 'RTX 3090', numGpus: 1, spot: true, bid: 0.12, dph: 0.12, pool: 'kryptex', hashAt: Date.now() - 5 * MIN };
  e.everHashed.add(id);
  const before = JSON.stringify(e.st.managed[id].bid);
  ok(!(await e.tryRaiseBid({ ...e.instances()[0], spot: true, revenueHr: 0.2, expRevenueHr: 0.2 }, e.st.managed[id], Date.now())), '被顶时不加价（返回 false → 走销毁）');
  ok(JSON.stringify(e.st.managed[id].bid) === before, '出价没被改动（没有花钱）');
  const w = e.st.managed[id].wouldRaise;
  ok(w && w.target > w.cur, `仍然记下「若追价会出什么价」（$${w?.cur} → $${w?.target}，上限 $${w?.upper}）`);
  ok(Number(e.cfg.maxBidRaises) === 0 && (e.st.managed[id].bidRaises || []).length === 0, '没有产生 bidRaises 记录');
}

console.log('— (a) 打开开关后仍能追价（代码路径保留）');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.maxBidRaises = 1;
  e.vast.setBidPrice = async (i, p) => { globalThis.__raised = [String(i), p]; return { success: true }; };
  const m = { rentedAt: Date.now() - 10 * MIN, spot: true, bid: 0.1, dph: 0.1 };
  const raised = await e.tryRaiseBid({ id: '9', spot: true, dph: 0.1, revenueHr: 0.3, expRevenueHr: 0.3, minBid: 0.05 }, m, Date.now());
  ok(raised === true && globalThis.__raised?.[1] > 0.1, `开关=1 时照常改价（$${globalThis.__raised?.[1]}）`);
  ok(m.bid === globalThis.__raised?.[1], '改价后 m.bid 跟随（核价基准）');
  ok(await e.tryRaiseBid({ id: '9', spot: true, dph: 0.1, revenueHr: 0.3, expRevenueHr: 0.3 }, m, Date.now()) === false, '超过上限次数后不再改价');
}

console.log('— (c) 被顶成因与对手价位');
{
  ok(preemptKindOf({ statusMsg: 'Error response from daemon: failed to create task for container', minBid: 1, ourBid: 0.1 }) === 'deploy_fail', '容器起不来 → deploy_fail（不是被抢）');
  ok(preemptKindOf({ statusMsg: 'success, running vastai/base-image', minBid: 0.15, ourBid: 0.1 }) === 'outbid', 'min_bid 明显高于我方出价 → outbid');
  ok(preemptKindOf({ statusMsg: 'success, running vastai/base-image', minBid: 0.1005, ourBid: 0.1 }) === 'host_reclaim', '价格没动 → host_reclaim（房东收回，加价没用）');
  ok(preemptKindOf({}) === 'unknown', '没信息时不编结论');

  const e = new Engine();
  e.log = () => {};
  e.st.managed['77'] = { rentedAt: Date.now() - 20 * MIN, gpuName: 'RTX 3090', numGpus: 1, spot: true, bid: 0.10, dph: 0.10, machineId: 555 };
  e.rawInstances = [{ id: 77, label: '', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.1, actual_status: 'stopped', intended_status: 'stopped', start_date: Date.now() / 1000 - 1200, machine_id: 555 }];
  e.offers = [{ machineId: 555, minBid: 0.13 }];
  const info = e.opponentInfo(e.instances()[0], e.st.managed['77']);
  ok(Math.abs(info.ratio - 1.3) < 1e-9, `对手价位/我方出价 = ${info.ratio}×`);
  ok(info.kind === 'outbid', `成因推断 ${info.kind}`);
}

console.log('— (b) 租约生命周期与净收益');
{
  const now = 1_800_000_000_000;
  const l = newLease('1', { machineId: 42, hostId: 7, gpuName: 'RTX 3080', numGpus: 1, spot: true, bid: 0.1, rentedAt: now }, { geolocation: 'Texas, US' }, now);
  l.tRunning = now + 2 * MIN;
  l.tFirstShare = now + 6 * MIN;
  l.dphTotalActual = 0.12;
  l.sharesAccepted = 13; l.sharesRejected = 0;
  l.creditedPrl = 0.01;
  closeLease(l, { endReason: 'preempted_outbid', now: now + 66 * MIN, priceUsd: 1.75, opponentRatio: 1.31 });
  ok(Math.abs(hoursOf(l, now + 66 * MIN) - 1.1) < 1e-9, `计费小时 1.1h（${hoursOf(l, now + 66 * MIN).toFixed(2)}）`);
  // 0.01 PRL × 1.75 − 0.12 × 1.1 = 0.0175 − 0.132 = −0.1145
  ok(Math.abs(l.netUsd - (-0.1145)) < 1e-6, `每台净收益 −$0.1145（入账 0.01 PRL − 租金 0.132）`);
  ok(l.endReason === 'preempted_outbid' && l.opponentRatio === 1.31, '终局：成因 + 对手价位都落账');
  ok(l.hostId === 7 && l.type === 'spot' && l.geo === 'Texas, US', '房东/类型/地域都记了（房东反复收回是比型号更强的信号）');

  ok(endReasonOf('竞价被抢占（stopped，磁盘仍在计费）') === 'preempted_outbid', '中文 reason → 枚举');
  ok(endReasonOf('开机后 8 分钟矿工仍未上线：SRBMiner 崩了') === 'deploy_fail', '矿工不上线 → deploy_fail');
  ok(endReasonOf('跌破止损') === 'our_stoploss' && endReasonOf('余额不足') === 'our_gate', '止损/闸门分开');
}

console.log('— (b) 按型号聚合用的是每机时净收益，不是 ROI 均值');
{
  const now = 1_800_000_000_000;
  const mk = (id, gpu, dph, credited, mins, tfs) => {
    const l = newLease(id, { gpuName: gpu, spot: true, bid: dph, rentedAt: now }, {}, now);
    l.dphTotalActual = dph;
    l.creditedPrl = credited;
    l.tFirstShare = tfs ? now + tfs * MIN : null;
    closeLease(l, { endReason: 'market_end', now: now + mins * MIN, priceUsd: 2 });
    return l;
  };
  // A：两台 1 小时，一台赚一台全亏（短命）→ 用净收益算就知道型号整体怎样
  const leases = [
    mk('1', 'RTX 3080', 0.1, 0.06, 60, 2),   // 0.12 − 0.1 = +0.02
    mk('2', 'RTX 3080', 0.1, 0, 8, 0),       // −0.0133
    mk('3', 'RTX 3090', 0.15, 0.03, 60, 3),  // 0.06 − 0.15 = −0.09
  ];
  const r = summarize(leases, { now, priceUsd: 2 });
  const g3080 = r.byGpu.find(g => g.key === 'RTX 3080');
  const g3090 = r.byGpu.find(g => g.key === 'RTX 3090');
  ok(g3080.leases === 2 && g3090.leases === 1, '按型号聚合租约数');
  ok(Math.abs(g3080.hashedRate - 50) < 1e-9, `出算力率 50%（${g3080.hashedRate}%）`);
  ok(g3080.netPerMachineHour > g3090.netPerMachineHour, `3080 每机时净收益 ${g3080.netPerMachineHour} > 3090 ${g3090.netPerMachineHour}`);
  ok(g3080.reasons.market_end === 2, '结束原因分布也进聚合');
  ok(r.total.leases === 3 && r.byHost.length >= 1, '总量与按房东聚合都在');
}


console.log('— 实验参数作用域：只对 pinned 机器生效');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.targetProfitPct = 20; e.cfg.stopLossPct = 0; e.cfg.stopLossMinutes = 30; e.cfg.hashLowPct = 85;
  e.cfg.expOverride = { targetProfitPct: -50, stopLossPct: -90, stopLossMinutes: 120 };

  const prod = e.limitsFor({ pinned: false });
  ok(prod.stopLossPct === 0 && prod.stopLossMinutes === 30 && !prod.skipRoi, '普通机器用生产阈值（0 / 30 分钟）');
  ok(prod.targetProfitPct === 20, '普通机器目标收益率仍是 20%（实验的 −50% 不外溢）');

  const exp = e.limitsFor({ pinned: true });
  ok(exp.stopLossPct === -90 && exp.stopLossMinutes === 120 && exp.fromOverride, 'pinned 机器用实验覆盖（−90% / 120 分钟）');

  e.cfg.expOverride = null;
  const pinnedNoOv = e.limitsFor({ pinned: true });
  ok(pinnedNoOv.skipRoi === true, 'pinned 但没配覆盖 → 维持老语义（不参与 ROI 淘汰）');
}

console.log('— 到账分摊：有份额按份额，没份额退回算力');
{
  const e = new Engine();
  e.log = () => {};
  const mk = (id, shares, hs) => { const l = e.leaseOf(id, { gpuName: 'X', spot: true, bid: 0.1, rentedAt: Date.now() }, {}); l.pool = 'kryptex'; l.sharesAccepted = shares; l.lastHs = hs; return l; };
  const a = mk('801', 30, 100e12), b = mk('802', 10, 100e12);
  e.allocateCredit('kryptex', 0.4);
  ok(Math.abs(a.creditedPrl - 0.3) < 1e-6 && Math.abs(b.creditedPrl - 0.1) < 1e-6, `份额 3:1 → 入账 0.3 / 0.1 PRL（${a.creditedPrl} / ${b.creditedPrl}）`);
  ok(a.creditedSrc === 'share_alloc' && b.creditedSrc === 'share_alloc', 'creditedSrc 标成 share_alloc（不是算力分摊）');

  const c = mk('803', 0, 200e12);
  a.sharesAccepted = 0; b.sharesAccepted = 0;
  e.allocateCredit('kryptex', 0.3);
  ok(Math.abs(c.creditedPrl - 0.3 * (200 / 400)) < 1e-6, `没有份额时退回算力比例（c 得 ${c.creditedPrl}）`);
  ok(c.creditedSrc === 'pool_alloc', '退回算力比例时 creditedSrc 标成 pool_alloc');
}

console.log('— 测试模式写保护（不依赖导入顺序）');
{
  const { assertWritable, DATA_DIR } = await import(U('src/store.js'));
  ok(assertWritable(DATA_DIR) === undefined, '临时目录允许写（当前 DATA_DIR 在 tmp 下）');
  let threw = null;
  try { assertWritable('/data/production-data'); } catch (x) { threw = x.message; }
  ok(threw && /测试模式/.test(threw), `非临时目录直接抛错（${String(threw).slice(0, 28)}…）`);
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
