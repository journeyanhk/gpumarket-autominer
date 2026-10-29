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
const MIN_ = MIN;

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

console.log('— 被收回的成因要落到 endReason 上');
{
  const now = 1_800_000_000_000;
  const mk = (kind) => { const l = newLease('1', { gpuName: 'X', spot: true, bid: 0.1, rentedAt: now }, {}, now); l.preemptKind = kind; return l; };
  const a = closeLease(mk('host_reclaim'), { endReason: 'preempted_outbid', now: now + 60 * MIN });
  ok(a.endReason === 'host_reclaim', 'min_bid 没涨 → host_reclaim（加价也没用的那种）');
  const b = closeLease(mk('outbid'), { endReason: 'preempted_outbid', now: now + 60 * MIN });
  ok(b.endReason === 'preempted_outbid', '确实被更高出价顶掉 → 仍是 preempted_outbid');
  const c = closeLease(mk('deploy_fail'), { endReason: 'preempted_outbid', now: now + 60 * MIN });
  ok(c.endReason === 'deploy_fail', '容器起不来 → deploy_fail（看着像被收，其实是部署失败）');
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

console.log('— 到账分摊：增量份额 × 难度，含刚结束的租约');
{
  const e = new Engine();
  e.log = () => {};
  e.market.price = 2;
  e.leases = []; e.st.leases = [];   // 同一份临时 state 会被多个 Engine 实例读到，这里清空保证确定性
  const mk = (id, shares, hs, diff = 1e6) => {
    const l = e.leaseOf(id, { gpuName: 'X', spot: true, bid: 0.1, rentedAt: Date.now() - 3600_000 }, {});
    l.pool = 'kryptex'; l.sharesAccepted = shares; l.sharesMark = 0; l.difficulty = diff; l.lastHs = hs;
    return l;
  };
  const a = mk('801', 30, 100e12), b = mk('802', 10, 100e12);
  e.allocateCredit('kryptex', 0.4);
  ok(Math.abs(a.creditedPrl - 0.3) < 1e-6 && Math.abs(b.creditedPrl - 0.1) < 1e-6, `份额 30:10（同难度）→ 0.3 / 0.1 PRL（${a.creditedPrl} / ${b.creditedPrl}）`);
  ok(a.creditedSrc === 'share_alloc', 'creditedSrc = share_alloc');
  ok(a.sharesMark === 30 && b.sharesMark === 10, '分完把游标推到当前累计份额（下次只算增量）');

  // 第二轮：a 的份额没涨、b 涨了 10 → 增量 0:10，a 不该再分到钱
  b.sharesAccepted = 20;
  e.allocateCredit('kryptex', 0.2);
  ok(Math.abs(a.creditedPrl - 0.3) < 1e-6, `第二轮 a 拿 0，累计仍是 ${a.creditedPrl}`);
  ok(Math.abs(b.creditedPrl - 0.3) < 1e-6, `第二轮 b 拿满 0.2，累计 ${b.creditedPrl}`);

  // 难度加权：10 份额 @2e6 与 20 份额 @1e6 等价
  const c = e.leaseOf('803', { gpuName: 'Y', spot: true, bid: 0.1, rentedAt: Date.now() - 3600_000 }, {});
  const d = e.leaseOf('804', { gpuName: 'Y', spot: true, bid: 0.1, rentedAt: Date.now() - 3600_000 }, {});
  Object.assign(c, { pool: 'kryptex', sharesAccepted: 10, sharesMark: 0, difficulty: 2e6 });
  Object.assign(d, { pool: 'kryptex', sharesAccepted: 20, sharesMark: 0, difficulty: 1e6 });
  e.allocateCredit('kryptex', 0.02);
  ok(Math.abs(c.creditedPrl - 0.01) < 1e-6 && Math.abs(d.creditedPrl - 0.01) < 1e-6, `10 份额@2e6 = 20 份额@1e6（各 ${c.creditedPrl} / ${d.creditedPrl}）`);

  // 入账滞后：刚被收回的机器也要分到它自己挖的币
  const gone = e.leaseOf('805', { gpuName: 'Z', spot: true, bid: 0.5, rentedAt: Date.now() - 1800_000 }, {});
  Object.assign(gone, { pool: 'kryptex', sharesAccepted: 40, sharesMark: 0, difficulty: 1e6, dphTotalActual: 0.5, tEnd: Date.now() - 10 * MIN_ });
  e.allocateCredit('kryptex', 0.4);
  ok(Math.abs(gone.creditedPrl - 0.4) < 1e-6, `结束后 10 分钟的租约仍分到 ${gone.creditedPrl} PRL（入账本来就滞后）`);
  // 0.4 PRL × $2 = $0.8 入账，实付 0.5/h × 20min = $0.1667 → 净 +$0.6333
  ok(gone.netUsd != null && Math.abs(gone.netUsd - 0.6333) < 1e-3, `结束后的净收益回写（${gone.netUsd}）`);

  // 超过窗口就不再分：怕把早就结算过的币重复记到旧租约上
  const old = e.leaseOf('806', { gpuName: 'Z', spot: true, bid: 0.1, rentedAt: Date.now() - 7200_000 }, {});
  Object.assign(old, { pool: 'kryptex', sharesAccepted: 50, sharesMark: 0, difficulty: 1e6, tEnd: Date.now() - 120 * MIN_ });
  e.allocateCredit('kryptex', 0.4);
  ok(old.creditedPrl === 0, '结束超过 60 分钟的租约不再参与分摊');

  // 没有份额数据（v7 机器）→ 退回算力比例，并标注来源
  const e2 = new Engine(); e2.log = () => {};
  e2.leases = []; e2.st.leases = [];
  const f = e2.leaseOf('901', { gpuName: 'X', spot: true, bid: 0.1, rentedAt: Date.now() }, {});
  const g = e2.leaseOf('902', { gpuName: 'X', spot: true, bid: 0.1, rentedAt: Date.now() }, {});
  Object.assign(f, { pool: 'kryptex', lastHs: 100e12 });
  Object.assign(g, { pool: 'kryptex', lastHs: 300e12 });
  e2.allocateCredit('kryptex', 0.4);
  ok(Math.abs(f.creditedPrl - 0.1) < 1e-6 && Math.abs(g.creditedPrl - 0.3) < 1e-6, `缺份额时按算力 1:3 分摊（${f.creditedPrl} / ${g.creditedPrl}）`);
  ok(f.creditedSrc === 'pool_alloc', '缺份额时 creditedSrc 如实标成 pool_alloc');
}

console.log('— 每日失败成本封顶');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.dailyFailBudget = 0.3;
  e.account.vastBalance = 100;
  e.market.updatedAt = Date.now();
  e.rentCooldownUntil = 0; e.preemptCooldownUntil = 0; e.rentTimes = [];
  e.st.failSpend = { day: '', usd: 0 };
  ok(e.rentAllowed().ok, '失败成本为 0 时正常放行');
  e.addFailSpend(0.2);
  ok(e.failSpendToday().usd === 0.2 && e.rentAllowed().ok, '累计 $0.2（未到 $0.3）仍放行');
  e.addFailSpend(0.15);
  const g = e.rentAllowed();
  ok(!g.ok && /失败成本/.test(g.why), `累计 $0.35 触发封顶（${g.why}）`);
  // 第二天清零
  e.st.failSpend.day = '2000-01-01';
  ok(e.failSpendToday().usd === 0 && e.rentAllowed().ok, '跨天自动清零，恢复放行');

  // 结租时只有"没出过份额"的才算失败成本
  const now = Date.now();
  const mk = (id, hashed) => {
    const l = e.leaseOf(id, { gpuName: 'RTX 3060', spot: true, bid: 0.1, rentedAt: now - 60 * MIN_ }, {});
    l.pool = 'kryptex'; l.dphTotalActual = 0.12; l.tFirstShare = hashed ? now - 30 * MIN_ : null;
    return l;
  };
  e.st.failSpend = { day: '', usd: 0 };
  mk('601', false);
  e.closeLeaseFor('601', { reason: '竞价被抢占（stopped，磁盘仍在计费）' });
  ok(Math.abs(e.failSpendToday().usd - 0.12) < 1e-6, `没出过份额的 1 小时租约记 $0.12（当前 ${e.failSpendToday().usd}）`);
  e.st.failSpend = { day: '', usd: 0 };
  mk('602', true);
  e.closeLeaseFor('602', { reason: '竞价被抢占（stopped，磁盘仍在计费）' });
  ok(e.failSpendToday().usd === 0, '出过份额的租约不计入失败成本（即使也被收回）');
}

console.log('— min_bid 30 分钟稳定性过滤');
{
  const e = new Engine();
  e.log = () => {};
  e.st.minBidHist = {};
  e.cfg.minBidStablePct = 10;
  const now = Date.now();
  e.recordMinBid(9001, 0.10, now - 60 * MIN_);
  e.recordMinBid(9001, 0.10, now - 30 * MIN_);
  const calm = e.recordMinBid(9001, 0.101, now);
  ok(calm && !calm.unstable, `min_bid 稳定（${calm.changePct}%）→ 不算不稳定`);
  e.st.minBidHist = {};
  e.recordMinBid(9002, 0.10, now - 25 * MIN_);
  const hot = e.recordMinBid(9002, 0.13, now);
  ok(hot && hot.unstable && hot.changePct > 25, `min_bid 25 分钟涨 ${hot.changePct}% → 判为不稳定（正在被抢）`);
  e.st.minBidHist = {};
  const fresh = e.recordMinBid(9003, 0.10, now);
  ok(fresh && !fresh.unstable && fresh.changePct === null, '样本不足 20 分钟 → 不误杀新机');
}


console.log('— 累计到账必须单调：矿池打款不能把同一笔记两次');
{
  const e = new Engine();
  e.log = () => {};
  e.st.ledger = { kryptex: { since: Date.now(), prl: { last: null, acc: 0 }, nock: { last: null, acc: 0 }, spend: 0, theo: 0, hours: 0 } };
  e.leases = []; e.st.leases = [];
  const L = () => e.st.ledger.kryptex.prl;
  e.track('kryptex', 'prl', 1.78);   // 第一笔只做基线，不计入 acc
  ok(L().acc === 0 && Math.abs(L().last - 1.78) < 1e-9, `首笔作为基线（acc=${L().acc}，last=${L().last}）`);
  e.track('kryptex', 'prl', 0.75);   // 打款后余额归零（曾经就是这里把 1.03 记了两次）
  ok(L().acc === 0, '打款导致计数回落 → acc 不变');
  ok(Math.abs(L().last - 1.78) < 1e-9, '高水位不被拉低（否则下一轮会重复计入）');
  ok((L().resets || 0) === 1, '回落被记成 resets 计数，方便以后发现口径问题');
  e.track('kryptex', 'prl', 1.90);
  ok(Math.abs(L().acc - 0.12) < 1e-9, `后续只加增量 0.12 → acc=${L().acc}`);
  // 对照：老口径（余额型）会把打款后的 0.75 再涨回 1.78 记成 +1.03
  ok(Math.abs(L().acc - 1.03) > 0.5, '没有把打款金额重复计入');
}


console.log('— 房东级存活率与黑名单（70 租 64 收不是运气，是房东）');
{
  const e = new Engine();
  e.log = () => {};
  const now = Date.now();
  e.leases = []; e.st.leases = []; e.st.hostBans = {}; e.st.blacklist = {};
  const mk = (hostId, mins, reclaim, gpu = 'RTX 4090') => {
    const l = newLease(String(Math.random()), { gpuName: gpu, spot: true, bid: 0.16, rentedAt: now - mins * MIN, hostId }, {}, now - mins * MIN);
    l.hostId = hostId; l.endReason = reclaim ? 'host_reclaim' : 'our_stoploss';
    l.tEnd = now; l.tFirstShare = now - mins * MIN + 60000;
    e.leases.push(l); return l;
  };
  // 坏房东 166545：5 收 / 7 条，中位 10 分钟
  mk(166545, 8, true); mk(166545, 9, true); mk(166545, 10, true); mk(166545, 11, true); mk(166545, 12, true);
  mk(166545, 30, false); mk(166545, 60, false);
  // 好房东 482330：0 收，764 分钟
  mk(482330, 764, false, 'RTX 3080');
  // 单样本短命房东 55313：1 条、8 分钟、收回
  mk(55313, 8, true);

  const led = e.hostLedger();
  ok(led['166545'].n === 7 && led['166545'].reclaims === 5 && led['166545'].medianLife <= 12,
     `台账聚合：166545 租 ${led['166545'].n} 收 ${led['166545'].reclaims} 中位 ${led['166545'].medianLife} 分钟`);
  ok(led['482330'].reclaims === 0 && led['482330'].medianLife > 700, '好房东 482330：0 收回、764 分钟');

  const p1 = e.pSurvive(482330, 'RTX 3080');
  const p2 = e.pSurvive(166545, 'RTX 4090');
  ok(Math.abs(p1.p - 0.75) < 1e-9 && p1.src === 'host', `482330 存活率 ${p1.p}（1 次样本 + 拉普拉斯平滑 → 0.75）`);
  ok(p2.p <= 0.4 && p2.src === 'host', `166545 存活率 ${p2.p}（host 口径）`);
  ok(e.pSurvive(null, 'RTX 9999').src === 'default', '没样本时用保守默认值');

  const applied = e.refreshHostBans(now);
  const b166545 = e.hostBanned(166545, now), b55313 = e.hostBanned(55313, now), b482330 = e.hostBanned(482330, now);
  ok(!!b166545 && b166545.until - now > 6 * 24 * 60 * MIN, `166545 → 7 天黑名单（${b166545?.why}）`);
  ok(!!b55313 && b55313.until - now <= 2 * 24 * 60 * MIN, `单样本短命 → 24 小时观察（${b55313?.why}）`);
  ok(!b482330, '好房东不拉黑');
  ok(applied.length === 2, `本轮应用 ${applied.length} 个房东黑名单`);

  // 期望 ROI：名义 × 存活概率 − 部署成本
  e.cfg.targetProfitPct = 20; e.cfg.deployCostMin = 2;
  const sv = e.pSurvive(166545, 'RTX 4090');
  const nominal = 53.7;
  const expRoi = nominal * sv.p - (2 / 60 * 100);
  ok(expRoi < 20, `166545 上 4090 名义 +${nominal}% × P${sv.p} − 部署 ≈ ${expRoi.toFixed(1)}% → 期望不过 20%，不租`);
  const svGood = e.pSurvive(482330, 'RTX 3080');
  ok(nominal * svGood.p - (2 / 60 * 100) > 20, '同一名义 ROI 放到好房东上就过线（这才是该租的）');
}

console.log('— 失败成本：短命机器按净亏计入');
{
  const e = new Engine();
  e.log = () => {};
  const now = Date.now();
  e.leases = []; e.st.leases = []; e.st.failSpend = { day: '', usd: 0 };
  e.cfg.survivalMinLifeMin = 30; e.market.price = 1.8;
  const mkLease = (mins, credited, dph = 0.16) => {
    const l = newLease(String(Math.random()), { gpuName: 'RTX 4090', spot: true, bid: dph, rentedAt: now - mins * MIN }, {}, now - mins * MIN);
    l.pool = 'kryptex'; l.dphTotalActual = dph; l.creditedPrl = credited;
    l.tFirstShare = now - mins * MIN + 30000;   // 保持 tEnd 为空，由 closeLeaseFor 收尾
    e.leases.push(l); return l;
  };
  mkLease(8, 0.006);       // 8 分钟：付 0.0213，到账 0.0108 → 净亏 0.0105
  e.closeLeaseFor(e.leases[0].id, { reason: '竞价被抢占（stopped，磁盘仍在计费）' });
  const f1 = e.failSpendToday(now).usd;
  ok(f1 > 0.008 && f1 < 0.013, `8 分钟短命机按净亏计入（$${f1.toFixed(4)}）`);

  e.st.failSpend = { day: '', usd: 0 };
  mkLease(90, 0.30);       // 90 分钟、赚了钱 → 不计失败
  e.closeLeaseFor(e.leases[1].id, { reason: '手动退租' });
  ok(e.failSpendToday(now).usd === 0, '活得久的机器即使被退租也不计失败成本');
  const fb = e.st.failBreakdown || {};
  ok((fb.shortNet || 0) > 0, `三列拆分：短命净亏 $${(fb.shortNet || 0).toFixed(4)}（封顶项）`);
  ok(fb.stopLossNet !== undefined, '止损退出净亏单独一列（不计入封顶）');
}

console.log('— L1 按房东维护（型号可能被标错，份额不会）');
{
  const e = new Engine();
  e.log = () => {};
  e.st.l1ByModel = {}; e.st.l1ByHost = {}; e.st.machineHost = {};
  e.cfg.l1Default = 0.8;
  e.st.machineHost['146614'] = 482330;
  ok(e.l1ForHost(482330) === null, '样本 <3 的房东返回 null');
  e.recordL1('RTX 2080 Ti', 1.19, 482330);
  ok(e.l1ForHost(482330) === null, '1 条样本仍不算数');
  e.recordL1('RTX 2080 Ti', 1.21, 482330);
  e.recordL1('RTX 2080 Ti', 1.17, 482330);
  const m = e.l1ForMachine('RTX 2080 Ti', '146614');
  ok(m.source === 'host' && Math.abs(m.l1 - 1.19) < 1e-9, `房东口径优先：L1=${m.l1}（source=${m.source}）`);
  ok(m.hostId === 482330, '机器 → 房东的映射记住了');
  // 没有 host 记录的机器回退型号口径
  const m2 = e.l1ForMachine('RTX 3080', '999999');
  ok(m2.source === 'model', '未知机器回退到型号口径');
  // 对照：型号口径被这台假 2080 Ti 污染
  // 型号口径封顶 1.0：>1.0 的增益只允许通过房东口径使用，否则会跨房东虚高
  ok(e.l1For('RTX 2080 Ti') === 1.0, `型号口径被封顶在 ${e.l1For('RTX 2080 Ti')}（1.19 只在本房东生效）`);
}

console.log('— 场所单点降级：库存超上限才停租');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.venueGuard = { enabled: true, inventoryCapPrl: 50 };
  e.account.vastBalance = 100; e.market.updatedAt = Date.now();
  e.rentCooldownUntil = 0; e.preemptCooldownUntil = 0; e.rentTimes = []; e.st.failSpend = { day: '', usd: 0 };
  e.st.venueGuard = { down: false, why: null, since: 0 };
  ok(e.rentAllowed().ok, '场所正常时正常放行');
  e.st.venueGuard = { down: true, why: 'gate:trade_status=sell_only', since: Date.now() };
  e.account.prlBalance = 10; e.kx = { earned: { balance: 5 } };
  ok(e.rentAllowed().ok, `降级但库存 ${e.inventoryPrl()} PRL < 50 → 仍可租（只挖不卖）`);
  e.account.prlBalance = 60; e.account.prlPending = 0;
  const g = e.rentAllowed();
  ok(!g.ok && /场所降级/.test(g.why), `库存 ${e.inventoryPrl()} PRL > 50 → 停租（${g.why}）`);
  e.st.venueGuard = { down: false };
  ok(e.rentAllowed().ok, '场所恢复后自动解除');
}

console.log('— 额度分桶：巡航 40% / 窗口 60%');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.autoRent = true; e.account.vastBalance = 100; e.market.updatedAt = Date.now();
  e.anonAvailable = false;   // 本用例测账号额度分桶路径，先关掉匿名巡航
  e.st.quotaEst = 19860;   // 今天学到的额度
  e.st.searchUsage = { day: e.utcDay(), requests: 0, rows: 0, cruiseRows: 0, windowRows: 0 };
  e.st.windowState = { active: false };
  let bk = e.quotaBuckets();
  ok(bk.cruiseBudget === Math.floor(19860 * 0.4) && bk.windowBudget === Math.floor(19860 * 0.6),
     `预算 40/60 拆分：巡航 ${bk.cruiseBudget} 行 / 窗口 ${bk.windowBudget} 行`);
  e.st.searchUsage.cruiseRows = bk.cruiseBudget;   // 巡航额度用光
  bk = e.quotaBuckets();
  ok(bk.cruiseLeft === 0 && bk.windowLeft === bk.windowBudget, '巡航用光后窗口桶仍然是满的（这就是改成 40/60 的意义）');
  const planCruise = e.scanPlan();
  ok(/巡航额度已用完/.test(planCruise.why || ''), `巡航桶耗尽 → 只等窗口（${planCruise.why}）`);
  // 窗口开启后，只有"匿名已看到过线报价"才动用 key 桶（二次确认），节奏 90 秒 / 50 行
  e.st.windowState = { active: true, until: Date.now() + 3600e3 };
  e.cfg.windowScanRows = 50; e.cfg.windowScanIntervalSec = 90;
  e.offers = [];   // 没有过线报价 → 不动用 key 桶
  const planNoPass = e.scanPlan();
  ok(planNoPass.bucket !== 'window', `匿名没有过线报价时不动用 key 桶（${planNoPass.bucket}）`);
  e.offers = [{ spotSkip: false, roi: 45, expRoi: 30 }];
  const planWin = e.scanPlan();
  ok(planWin.interval === 90_000 && planWin.rows === 50 && planWin.bucket === 'window',
     `窗口期二次确认：每 ${planWin.interval / 1000}s、${planWin.rows} 行、桶=${planWin.bucket}`);
  // 窗口桶也用光 → 回落到巡航节奏（不会无限扫）
  e.st.searchUsage.windowRows = bk.windowBudget;
  const planWin2 = e.scanPlan();
  ok(planWin2.bucket !== 'window' || planWin2.interval > 60_000, '窗口桶用光后不再高频扫描');
}

console.log('— 第三种窗口触发：6h 阶梯上涨');
{
  const e = new Engine();
  e.log = () => {};
  const now = Date.now();
  e.cfg.windowMode = { enabled: true, chg1hPct: 8, chg6hPct: 8, stairRatio: 1.1, ratio: 1, densityRise24hPct: 15, minutes: 360, minBidStablePct: 50, failBudgetUsd: 1, maxHourlySpend: 0.6 };
  e.cfg.l1Default = 1;
  e.st.windowState = null;
  e.market.price = 1.81;
  e.st.history = [{ t: now - 6 * 3600e3, price: 1.63 }, { t: now - 3600e3, price: 1.80 }];
  e.densitySamples = [{ t: now - 3600e3, v: 0.0224 / 24e12 }];
  e.offers = [{ dph: 0.10, th: 100 }];   // 收入 100*0.0224/24 = 0.0933 → ratio 0.93
  let st = e.updateWindowMode(now);
  ok(!st.active, `比值不足 1.1 时不触发（${JSON.stringify(e.windowInfo(now))}）`);
  e.offers = [{ dph: 0.08, th: 100 }];   // ratio ≈ 1.17
  st = e.updateWindowMode(now);
  ok(st.active && /6h/.test(st.reason || ''), `6h +11% 且比值 ≥1.1 → 触发阶梯窗口（${st.reason}）`);
}

console.log('— 窗口模式：两种触发 / 只放宽三项 / 自动退出');
{
  const e = new Engine();
  e.log = () => {};
  const now = Date.now();
  e.cfg.minBidStablePct = 10; e.cfg.dailyFailBudget = 0.3; e.cfg.maxHourlySpend = 0.2; e.cfg.maxBidRaises = 0;
  e.cfg.windowMode = { enabled: true, chg1hPct: 8, ratio: 1.0, densityRise24hPct: 15, minutes: 360, minBidStablePct: 50, failBudgetUsd: 1.0, maxHourlySpend: 0.6 };
  e.st.windowState = null; e.st.history = []; e.densitySamples = []; e.offers = [];
  e.market.price = 1.7;

  ok(!e.updateWindowMode(now).active, '平时不进窗口（没有涨幅也没有比值）');
  const base = e.effectiveLimits(now);
  ok(base.minBidStablePct === 10 && base.dailyFailBudget === 0.3 && base.maxHourlySpend === 0.2 && !base.window, '生产阈值：10% / $0.3 / $0.2');

  // 触发 A：1 小时涨幅 ≥ 8%
  e.market.price = 1.85;
  e.st.history = [{ t: now - 3600e3, price: 1.70 }];
  let w = e.updateWindowMode(now);
  ok(w.active && /1h/.test(w.reason || ''), `触发 A：${w.reason}`);
  const lim = e.effectiveLimits(now);
  ok(lim.window && lim.minBidStablePct === 50 && lim.dailyFailBudget === 1.0 && lim.maxHourlySpend === 0.6, '窗口内放宽三项：50% / $1.0 / $0.6');
  ok(!('maxBidRaises' in lim) && Number(e.cfg.maxBidRaises) === 0, '**不放宽追价**（maxBidRaises 仍是 0，这是花钱买来的结论）');

  // 自动退出
  e.st.windowState.until = now - 1;
  w = e.updateWindowMode(now);
  ok(!w.active, '到点自动退出');
  const after = e.effectiveLimits(now);
  ok(after.minBidStablePct === 10 && after.dailyFailBudget === 0.3 && after.maxHourlySpend === 0.2, '退出后三项全部恢复生产值');

  // 触发 B：密度÷地板 ≥ 1 且密度 24h +15%（币价没涨也算窗口）
  e.market.price = 1.70; e.st.history = [];
  e.st.windowState = null;
  // densitySamples 的单位是 $/H/s/小时：$0.020/TH·天 = 0.020/24e12
  const toV = thDay => thDay / 24e12;
  e.densitySamples = [{ t: now - 25 * 3600e3, v: toV(0.020) }, { t: now - 1 * 3600e3, v: toV(0.030) }];
  e.offers = [{ dph: 0.10, th: 100 }];
  w = e.updateWindowMode(now);
  ok(w.active && /密度/.test(w.reason || ''), `触发 B：${w.reason}`);

  // 窗口内失败成本达到绝对上限 → 提前退出
  e.st.failSpend = { day: new Date(now).toISOString().slice(0, 10), usd: 1.0 };
  e.account.vastBalance = 100; e.market.updatedAt = now; e.rentCooldownUntil = 0; e.preemptCooldownUntil = 0; e.rentTimes = [];
  e.rentAllowed(now);
  ok(!e.st.windowState.active, '窗口内失败成本到 $1 → 提前退出窗口（不是无限放宽）');
}

console.log('— L1（份额反推算力 ÷ 矿工自报）按型号维护');
{
  const e = new Engine();
  e.log = () => {};
  e.cfg.l1Default = 0.8;
  e.st.l1ByModel = {};
  ok(e.l1For('RTX 3080') === 0.8, '没有样本的型号用全局保守值 0.8');
  e.recordL1('RTX 3080', 0.70);
  e.recordL1('RTX 3080', 0.90);
  ok(e.l1For('RTX 3080') === 0.8, '样本 <3 仍用全局值（不拿两台机器当结论）');
  e.recordL1('RTX 3080', 0.95);
  ok(Math.abs(e.l1For('RTX 3080') - 0.90) < 1e-9, `样本 3 条 → 中位数 ${e.l1For('RTX 3080')}`);
  e.recordL1('RTX 3080', 5);      // 明显异常值
  ok(e.l1For('RTX 3080') <= 1.5, '异常值被过滤（>1.5 不进样本）');
  ok(e.l1For('RTX 4090') === 0.8, '别的型号不受影响');
}


console.log('— 同一房东 1 小时收回 ≥2 台 → 拉黑该房东已知机器 24h');
{
  const e = new Engine();
  e.log = () => {};
  e.leases = []; e.st.leases = []; e.st.blacklist = {}; e.st.hostStats = {};
  const now = Date.now();
  const mk = (id, machineId, hostId, minsAgo) => {
    const l = newLease(id, { gpuName: 'RTX 3080', spot: true, bid: 0.1, rentedAt: now - 3600_000, machineId, hostId }, {}, now - 3600_000);
    l.endReason = 'host_reclaim'; l.tEnd = now - minsAgo * MIN_;
    e.leases.push(l);
    return l;
  };
  const a = mk('1', 146144, 90577, 20);
  mk('2', 139830, 90577, 30);      // 同房东的另一台（历史记录，已知机器）
  let rec = e.recordHostReclaim(a, { machine_id: 146144 });
  ok(rec.reclaims.length === 1 && !rec.blacklistedUntil, '第 1 台收回：只记数，不拉黑');
  ok(Object.keys(e.st.blacklist).length === 0, '第 1 台收回不产生黑名单');

  const b = mk('3', 147000, 90577, 0);
  rec = e.recordHostReclaim(b, { machine_id: 147000 });
  ok(rec.blacklistedUntil > now, '第 2 台收回：房东进入 24h 黑名单');
  const ids = Object.keys(e.st.blacklist).map(String);
  ok(ids.includes('146144') && ids.includes('139830') && ids.includes('147000'),
     `该房东已知的 ${ids.length} 台机器全部拉黑（${ids.join(',')}）`);
  ok(Object.values(e.st.blacklist).every(v => v.reason.includes('同一房东')), '黑名单原因写明是房东收回，不是机器坏');

  // 另一房东不受牵连
  const c = mk('4', 145135, 379343, 0);
  const rec2 = e.recordHostReclaim(c, { machine_id: 145135 });
  ok(rec2.reclaims.length === 1 && !rec2.blacklistedUntil, '另一个房东只有 1 次收回 → 不拉黑');
  ok(!Object.keys(e.st.blacklist).includes('145135'), '不同房东互不牵连');
}


console.log('— v8 的 stats 行（键名只剩半边引号）也要能解析');
{
  const e = new Engine();
  e.log = () => {};
  // v8 实际产出的格式：grep 只挑值，键名尾部的引号还在
  e.rigLogs.set('700', { t: Date.now(), text: '[prl] 11:42:02 stats srb time=69.1ms :: accepted":14 rejected":0 difficulty":1000000 uptime":900 ' });
  const sh = e.sharesOf('700');
  ok(sh?.accepted === 14 && sh?.rejected === 0 && sh?.difficulty === 1000000, `compact 格式解析：accepted=${sh?.accepted} rejected=${sh?.rejected} diff=${sh?.difficulty}`);
  // 旧格式（完整 JSON）继续兼容
  e.rigLogs.set('701', { t: Date.now(), text: '[prl] 11:42:02 stats srb :: { "shares": {"accepted": 7, "rejected": 1}, "difficulty": 500000 }' });
  const sh2 = e.sharesOf('701');
  ok(sh2?.accepted === 7 && sh2?.rejected === 1, '完整 JSON 格式仍然可解析');
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
