// M3 接口契约（2026-11-05，时间盒起点）
//
// 只有签名与校验，没有实现：先让"接口长什么样"被钉死，实现由 adapter 填。
// 为什么先写这个：PRL 那 9 天里最贵的 bug 全是"同一规则写两遍"（isRentable / pricingTable、
// 取价两处实现、0.6 与 ÷1.2 两处口径）。接口一旦有校验器，第二份实现就藏不住。

// observeSupply() 的返回必须含 wholeCardShare（2026-11-05 用户判定）：
// 换市场时它是**比价格更早、更硬**的第一个筛子——vast 的 frac_partial 占 74%，
// 说明它的主流供给是"可切分的卡"，而我们要的是整卡独占。
export const SUPPLY_FIELDS = ['counts', 'wholeCardShare', 'wholeCardUnits', 'exhaustive', 'sampledRows', 'at'];

// countOffers(query)：按型号的确定性计数。回答"有没有货"，与"值不值"（decide）分开。
// 关键在 exhaustive：vast 匿名额度每轮 30 行 → 永远 false，只能给下界；
// Clore 全量拉取 → true。两者不得直接相减（2026-11-05 用户判定）。
export const COUNT_FIELDS = ['count', 'exhaustive', 'sampledRows', 'asOf'];

/** Market：一个可租算力的场所（vast / clore / …）。四个方法，全部只读。 */
export const MARKET_METHODS = [
  'listOffers',      // () => Promise<RawOffer[]>           原始报价（各场所自己的字段）
  'normalizeOffer',  // (raw) => NormalizedOffer           归一化，**不得**出现任何场所私有字段
  'observeSupply',   // () => Promise<{counts, at}>        可租整卡数（按型号）
  'health',          // () => {ok, why}                    场所可用性（降级开关用）
];

/** Coin：一条算力币的收益口径。三个方法，纯函数。 */
export const COIN_METHODS = [
  'specOf',          // (gpuModel) => TH/s                规格算力
  'revenuePerUnit',  // (deliveredTh, market) => $/h      收入（不含成本）
  'deliverableOf',   // (samples) => {th, thSource, n}     交付算力估计 + **口径标签**
];

/** 决策原因码：稳定字符串，进台账、进日报，不允许随手改文案。 */
export const REASONS = {
  rent: 'rent',
  rentDisabled: 'rent_disabled',
  fracUnknown: 'frac_unknown',
  fracPartial: 'frac_partial',
  noMinBid: 'no_min_bid',
  belowFloor: 'below_floor',
  thUncalibrated: 'th_uncalibrated',
  leaseTooLong: 'lease_too_long',
  mrlUnknown: 'mrl_unknown',
  expRoiLow: 'exp_roi_low',
  overBudget: 'over_budget',
  hostBanned: 'host_banned',
  insaneRoi: 'insane_roi',
};

export function assertSupply(supply, name = 'supply') {
  const missing = SUPPLY_FIELDS.filter(k => !(k in (supply || {})));
  if (missing.length) throw new Error(`${name} 缺字段：${missing.join('、')}（wholeCardShare 是换市场的第一筛子）`);
  if (!(supply.wholeCardShare >= 0 && supply.wholeCardShare <= 1)) throw new Error(`${name}.wholeCardShare 应在 0~1`);
  // wholeCardUnits 是跨场所唯一可比的量：share 的分母里，Clore 根本不存在"分数卡"这个类别
  if (!(supply.wholeCardUnits >= 0)) throw new Error(`${name}.wholeCardUnits 必须是非负数`);
  // 但 units 本身也可能来自采样：没有 exhaustive 标记，它就会被当成市场事实
  if (typeof supply.exhaustive !== 'boolean') throw new Error(`${name}.exhaustive 必须是布尔（false 只能做同场所时间序列）`);
  return true;
}

export function assertCount(c, name = 'count') {
  const missing = COUNT_FIELDS.filter(k => !(k in (c || {})));
  if (missing.length) throw new Error(`${name} 缺字段：${missing.join('、')}`);
  if (typeof c.exhaustive !== 'boolean') throw new Error(`${name}.exhaustive 必须是布尔`);
  if (!(c.count >= 0)) throw new Error(`${name}.count 必须是非负数`);
  return true;
}

export function assertMarket(adapter, name = 'market') {
  const missing = MARKET_METHODS.filter(m => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`${name} 未实现 Market 接口：缺 ${missing.join('、')}`);
  return true;
}

export function assertCoin(adapter, name = 'coin') {
  const missing = COIN_METHODS.filter(m => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`${name} 未实现 Coin 接口：缺 ${missing.join('、')}`);
  return true;
}

// 归一化报价的必填字段（少一个就说明 adapter 漏了映射——这正是"缓存少字段"那类 bug 的入口）
export const NORMALIZED_FIELDS = ['id', 'market', 'gpu', 'numGpus', 'frac', 'pricePerHour', 'mrlHours'];

export function assertNormalized(o, name = 'offer') {
  const missing = NORMALIZED_FIELDS.filter(k => !(k in (o || {})));
  if (missing.length) throw new Error(`${name} 归一化缺字段：${missing.join('、')}`);
  if (typeof o.market !== 'string') throw new Error(`${name}.market 必须是字符串`);
  if (o.frac != null && (o.frac <= 0 || o.frac > 1)) throw new Error(`${name}.frac 越界：${o.frac}`);
  return true;
}