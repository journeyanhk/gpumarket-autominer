// 租约台账：一台机器从「租下」到「结束」的完整生命周期。
//
// 为什么单独建模块：型号该不该屏蔽、该优先租谁，不能看 ROI 均值——短命机器
// （部署失败、刚下就被顶）会把 ROI 分布拉歪，看着亏的其实是运气问题。
// 决策口径统一成「每机时净收益」= (入账 PRL × 币价 − 实付租金) ÷ 计费小时。
//
// 另外三个字段是为了回答各自的争议：
//   tFirstShare  —— 「出算力前被顶」和「矿工启动慢」从此可以分开算；
//   opponentRatio—— 被顶时的对手价位（该机 min_bid ÷ 我们的出价），用来检验
//                     「24GB 卡被 AI 租户抢」这个假说，不靠猜；
//   preemptKind  —— 被收回的成因（出价被顶 / 按需租走 / 房东收回 / 部署失败）。
export const END_REASONS = [
  'preempted_outbid',   // 竞价被更高的出价顶掉（推断）
  'preempted_ondemand', // 被按需租走（推断）
  'host_reclaim',       // 房东收回 / 平台回收，价格未变
  'our_stoploss',       // 我们自己按止损退租
  'our_gate',           // 我们自己按闸门退租（算力偏低 / 核价 / 余额）
  'our_manual',         // 人工退租
  'deploy_fail',        // 部署失败（镜像 / 容器 / 矿工起不来）
  'market_end',         // 平台侧已不存在，本地清理
  'unknown',
];

// 从引擎的中文reason映射成枚举：台账要能跨语言聚合，不能让文案变化破坏统计
export function endReasonOf(reason) {
  const s = String(reason || '');
  if (/竞价被收回|竞价被抢占/.test(s)) return 'preempted_outbid';
  if (/部署|矿工|镜像|容器/.test(s)) return 'deploy_fail';
  if (/止损/.test(s)) return 'our_stoploss';
  if (/算力|核价|余额|闸门|不划算|退租/.test(s)) return 'our_gate';
  if (/人工|手动/.test(s)) return 'our_manual';
  if (/已不在|不存在|回收/.test(s)) return 'market_end';
  return 'unknown';
}

export function newLease(id, m = {}, inst = {}, now = Date.now()) {
  return {
    id: String(id),
    machineId: m.machineId ?? inst.machine_id ?? null,
    // 同一房东反复收回，比「哪个型号」更强的信号 —— 单独记
    hostId: m.hostId ?? inst.host_id ?? null,
    gpu: m.gpuName || inst.gpu_name || null,
    numGpus: Number(m.numGpus ?? inst.num_gpus ?? 1) || 1,
    geo: inst.geolocation || m.geo || '',
    type: m.spot ? 'spot' : 'on-demand',
    bidEntry: numOrNull(m.bid),
    bidFinal: numOrNull(m.bid),
    raises: 0,
    dphBaseActual: null,
    dphTotalActual: null,
    tRent: Number(m.rentedAt) || now,
    tRunning: null,
    tMinerUp: null,
    tFirstShare: null,
    tEnd: null,
    endReason: null,
    preemptKind: null,
    opponentRatio: null,
    sharesAccepted: 0,
    sharesRejected: 0,
    creditedPrl: 0,
    creditedSrc: 'pool_alloc',
    // 分摊用的游标：sharesMark 是本轮已计入的累计份额，difficulty 是该机的 vardiff 难度
    sharesMark: 0,
    difficulty: null,
    localThAvg: null,
    priceUsd: null,
    netUsd: null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function hoursOf(l, now = Date.now()) {
  const end = Number(l.tEnd) || now;
  return Math.max(0, (end - (Number(l.tRent) || end)) / 3_600_000);
}

// 计酬小时只能从「第一次有份额」开始算：之前的时间是纯支出，不能摊进收益
export function hashedHoursOf(l, now = Date.now()) {
  if (!l.tFirstShare) return 0;
  const end = Number(l.tEnd) || now;
  return Math.max(0, (end - l.tFirstShare) / 3_600_000);
}

export function netUsdOf(l, { now = Date.now(), priceUsd = 0 } = {}) {
  const dph = Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0;
  const spent = dph * hoursOf(l, now);
  const earned = (Number(l.creditedPrl) || 0) * (Number(priceUsd) || 0);
  return +(earned - spent).toFixed(4);
}

export function closeLease(l, { endReason = 'unknown', now = Date.now(), priceUsd = null, preemptKind = null, opponentRatio = null } = {}) {
  l.tEnd ||= now;
  l.endReason = END_REASONS.includes(endReason) ? endReason : 'unknown';
  // 竞价被收回是笼统说法：min_bid 没涨（对手价位 <1×）说明不是被顶掉的，是房东收回。
  // 两者对决策的意义完全不同——被顶说明「我们的出价不够」，房东收回说明「加价也没用」。
  const kind = preemptKind || l.preemptKind;
  if (l.endReason === 'preempted_outbid' && kind === 'host_reclaim') l.endReason = 'host_reclaim';
  if (l.endReason === 'preempted_outbid' && kind === 'deploy_fail') l.endReason = 'deploy_fail';
  if (preemptKind) l.preemptKind = preemptKind;
  if (opponentRatio != null && Number.isFinite(Number(opponentRatio))) l.opponentRatio = +Number(opponentRatio).toFixed(3);
  if (priceUsd != null) l.priceUsd = +Number(priceUsd).toFixed(4);
  l.netUsd = netUsdOf(l, { priceUsd: l.priceUsd ?? priceUsd ?? 0 });
  return l;
}

// 被收回的成因推断：status_msg 能区分「部署期容器起不来」；
// min_bid 明显高于我们的出价 → 被更高竞价顶掉；价格没动 → 房东收回/平台回收。
export function preemptKindOf({ statusMsg = '', minBid = null, ourBid = null, intended = '', actual = '' } = {}) {
  const msg = String(statusMsg || '');
  if (/failed to create task|Error response from daemon|oci runtime|no space left/i.test(msg)) return 'deploy_fail';
  const mb = Number(minBid), ob = Number(ourBid);
  if (Number.isFinite(mb) && Number.isFinite(ob) && ob > 0) {
    if (mb > ob * 1.02) return 'outbid';
    return 'host_reclaim';
  }
  if (String(intended) === 'stopped' && ['created', 'loading', null, undefined, ''].includes(actual)) return 'outbid';
  return 'unknown';
}

export function median(arr) {
  const v = arr.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function row(key, group, now, priceUsd) {
  const n = group.length;
  const hashed = group.filter(l => l.tFirstShare).length;
  // 净收益一律现算：租约结束后仍可能有矿池到账（滞后的 unconfirmed 结算）
  const nets = group.map(l => netUsdOf(l, { now, priceUsd }));
  const hours = group.reduce((a, l) => a + hoursOf(l, now), 0);
  const spent = group.reduce((a, l) => a + (Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) * hoursOf(l, now), 0);
  const credited = group.reduce((a, l) => a + (Number(l.creditedPrl) || 0), 0);
  const usd = credited * (Number(priceUsd) || 0);
  const lives = group.map(l => hoursOf(l, now) * 60);
  const opp = group.filter(l => l.opponentRatio != null).map(l => l.opponentRatio);
  return {
    key,
    leases: n,
    hashedRate: n ? +(hashed / n * 100).toFixed(1) : null,
    medianLifetimeMin: median(lives) == null ? null : +median(lives).toFixed(1),
    hours: +hours.toFixed(2),
    spendUsd: +spent.toFixed(4),
    creditedPrl: +credited.toFixed(8),
    earnedUsd: +usd.toFixed(4),
    // 决策口径：每机时净收益（含没挖到钱的那台机器的时间）
    netPerMachineHour: hours > 0.01 ? +((usd - spent) / hours).toFixed(4) : null,
    medianOpponentRatio: median(opp) == null ? null : +median(opp).toFixed(3),
    reasons: Object.fromEntries(Object.entries(group.reduce((a, l) => { const k = l.endReason || 'open'; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1])),
    netUsdSum: +nets.reduce((a, b) => a + (Number(b) || 0), 0).toFixed(4),
  };
}

export function summarize(leases = [], { now = Date.now(), priceUsd = 0 } = {}) {
  const by = (f) => {
    const m = new Map();
    for (const l of leases) {
      const k = f(l) || '未知';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(l);
    }
    return [...m.entries()].map(([k, g]) => row(k, g, now, priceUsd)).sort((a, b) => (b.netPerMachineHour ?? -1e9) - (a.netPerMachineHour ?? -1e9));
  };
  const hours = leases.reduce((a, l) => a + hoursOf(l, now), 0);
  const nets = leases.map(l => netUsdOf(l, { now, priceUsd }));
  return {
    total: {
      leases: leases.length,
      hours: +hours.toFixed(2),
      netUsd: +nets.reduce((a, b) => a + (Number(b) || 0), 0).toFixed(4),
      netPerMachineHour: hours > 0.01 ? +((nets.reduce((a, b) => a + (Number(b) || 0), 0) / hours)).toFixed(4) : null,
      open: leases.filter(l => !l.tEnd).length,
    },
    byGpu: by(l => l.gpu),
    // 「同一房东反复收回」是比型号更强的信号，所以按 host 也出一份
    byHost: by(l => (l.hostId != null ? `host:${l.hostId}` : l.machineId != null ? `machine:${l.machineId}` : null)),
  };
}