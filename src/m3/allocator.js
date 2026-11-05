// M3 分配器：**纯函数**，不读时钟、不读配置、不发网络请求。
//
// 输入：一条归一化 Offer + 一个上下文（Coin 指标 + 门槛 + 预算）
// 输出：{ action, reasonCode, expRoi, note }
//
// 设计约束（用户 2026-11-04 的三条硬约束之一）：allocator 里不得出现任何场所私有字段，
// 也不得出现 PRL / Pearlhash 的字段——它只认归一化 Offer 与 Coin 指标。
import { REASONS } from './contract.js';

/**
 * @param {object} offer  归一化报价 {market,gpu,numGpus,frac,pricePerHour,mrlHours,deliveredTh,thSource,hostBanned?}
 * @param {object} ctx    {rentEnabled,targetProfitPct,deployPct,pSurvive,floorPricePerGpu,maxHourlySpend,budgetLeftUsd,revenuePerThHour,maxLeaseHours}
 */
export function decide(offer, ctx) {
  const cost = Number(offer?.pricePerHour) / Math.max(1, Number(offer?.numGpus) || 1);
  const skip = (reasonCode, note = null) => ({ action: 'skip', reasonCode, expRoi: null, note, cost });

  if (ctx?.rentEnabled === false) return skip(REASONS.rentDisabled);

  // ① 可比性：frac 必须已知且为整卡。frac=null 与 frac=1 在语义上完全不同（字段缺 ≠ 整卡）
  if (offer?.frac == null) return skip(REASONS.fracUnknown, 'frac 缺失，按整卡处理会高估 2–8 倍');
  if (Number(offer.frac) < 0.99) return skip(REASONS.fracPartial, `frac=${offer.frac}`);

  // ② 价格护栏
  if (!(cost > 0)) return skip(REASONS.noMinBid);
  const floor = Number(ctx?.floorPricePerGpu);
  if (floor > 0 && cost < floor) return skip(REASONS.belowFloor, `$${cost}/h < 地板 $${floor}/h（钓鱼挂牌）`);

  // ③ 预算：买不起就不必算收益（顺序有意义——否则"太贵"会被报成"收益不足"）
  if (cost > Number(ctx?.maxHourlySpend ?? Infinity)) return skip(REASONS.overBudget, `$${cost}/h > 单机上限 $${ctx.maxHourlySpend}/h`);
  if (Number(ctx?.budgetLeftUsd) > 0 && cost > Number(ctx.budgetLeftUsd)) return skip(REASONS.overBudget, `$${cost}/h > 剩余预算 $${ctx.budgetLeftUsd}`);

  // ④ 口径：未校准的交付算力不得参与租用决策（免疫记忆 #2）
  if (offer.thSource === 'spec' || offer.thSource === 'pooled' || offer.thCalibrated === false) {
    return skip(REASONS.thUncalibrated, `thSource=${offer.thSource}`);
  }

  // ⑤ 期限：mrl 不是现货就不能按现货密度算（免疫记忆 #3）
  const maxLease = Number(ctx?.maxLeaseHours ?? 24);
  // mrl 未知不等于现货：默认成现货会把 30 天长约当日内机（免疫记忆 #3 的边界情况）
  if (offer.mrlHours == null) return skip(REASONS.mrlUnknown, 'mrl 缺失');
  if (Number(offer.mrlHours) > maxLease) return skip(REASONS.leaseTooLong, `mrl=${offer.mrlHours}h > ${maxLease}h`);

  if (offer.hostBanned) return skip(REASONS.hostBanned, String(offer.hostBanned).slice(0, 40));

  // ⑥ 收益：收入 = 交付算力 × 每 TH 时收入
  const rev = Number(offer.deliveredTh) * Number(ctx?.revenuePerThHour);
  if (!(rev > 0)) return skip(REASONS.expRoiLow, 'revenue=0');
  const roi = (rev / cost - 1) * 100;
  if (roi > 500) return skip(REASONS.insaneRoi, `名义 ROI ${roi.toFixed(0)}% > 500%（多半是错标型号）`);
  const expRoi = roi * Number(ctx?.pSurvive ?? 0.5) - Number(ctx?.deployPct ?? 3.33);


  if (expRoi < Number(ctx?.targetProfitPct ?? 20)) {
    return { action: 'skip', reasonCode: REASONS.expRoiLow, expRoi: +expRoi.toFixed(1), note: `名义 ${roi.toFixed(1)}%`, cost };
  }
  return { action: 'rent', reasonCode: REASONS.rent, expRoi: +expRoi.toFixed(1), note: null, cost };
}