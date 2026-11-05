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
  // verdict 三态（2026-11-05 用户判定）：pass / watch / skip。
  // watch = 我们缺一项数据，不是市场没机会；**必须带 whatWouldMakeItViable**，
  // 否则 M3 会重演 PRL 那个"0 单到底是市场还是规则"的诊断困境。
  const skip = (reasonCode, note = null) => ({ action: 'skip', verdict: 'skip', reasonCode, expRoi: null, note, cost });
  const watch = (reasonCode, note, need) => ({ action: 'skip', verdict: 'watch', reasonCode, expRoi: null, note, whatWouldMakeItViable: need, cost });
  const roiReq = 1 + ((Number(ctx?.targetProfitPct ?? 20) + Number(ctx?.deployPct ?? 3.33)) / Math.max(1e-9, Number(ctx?.pSurvive ?? 0.5))) / 100;

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
  // 算法单位未标 → 连收益都算不准，只能 watch（2026-11-05：WhatToMine 的 nethash 并非都用 H/s）
  if (offer.algoUnitKnown === false) {
    return watch(REASONS.uncalibratedAlgo, `算法 ${offer.algo || '?'} 的 nethash 单位未标`, {
      needUnitFactor: true,
      note: '需要该算法的一次公开基准（3080 原生算力）来定单位系数；未标前禁止 pass',
    });
  }

  if (offer.thSource === 'spec' || offer.thSource === 'pooled' || offer.thCalibrated === false) {
    const revPerTh = Number(ctx?.revenuePerThHour) || 0;
    const thNow = Number(offer.deliveredTh) || 0;
    const needTh = revPerTh > 0 ? +(cost * roiReq / revPerTh).toFixed(1) : null;
    const specTh = Number(ctx?.specTh) || null;
    // 关键区分（2026-11-05）：需要的交付算力已经超过规格算力 → **价格是主因，校准救不回来**。
    // 不区分的话，漏斗会把人引向"再补几条实测样本"，而补多少都没用。
    const priceIsTheProblem = !!(needTh && specTh && needTh > specTh);
    return watch(REASONS.thUncalibrated, `thSource=${offer.thSource}（th=${thNow} 是回退值）`, {
      minDeliveredTh: needTh,
      maxUsdPerGpuHour: thNow > 0 ? +(thNow * revPerTh / roiReq).toFixed(4) : null,
      specTh,
      priceIsTheProblem,
      note: priceIsTheProblem
        ? `价格是主因：要过线需 ${needTh} TH > 规格 ${specTh} TH，补样本无解`
        : '需要 1 条该型号的整卡实测交付（≥5 条、≥2 host 才能升 high）',
    });
  }

  // ⑤ 期限：mrl 不是现货就不能按现货密度算（免疫记忆 #3）
  const maxLease = Number(ctx?.maxLeaseHours ?? 24);
  // mrl 未知不等于现货：默认成现货会把 30 天长约当日内机（免疫记忆 #3 的边界情况）
  if (offer.mrlHours == null) return watch(REASONS.mrlUnknown, 'mrl 缺失（不知道是不是长约）', { maxMrlHours: maxLease, note: '需要场所提供最短租期；缺失时不能按现货定价' });
  if (Number(offer.mrlHours) > maxLease) return skip(REASONS.leaseTooLong, `mrl=${offer.mrlHours}h > ${maxLease}h`);

  if (offer.hostBanned) return skip(REASONS.hostBanned, String(offer.hostBanned).slice(0, 40));

  // ⑥ 收益：收入 = 交付算力 × 每 TH 时收入
  const rev = Number(offer.deliveredTh) * Number(ctx?.revenuePerThHour);
  if (!(rev > 0)) return skip(REASONS.expRoiLow, 'revenue=0');
  const roi = (rev / cost - 1) * 100;
  if (roi > 500) return skip(REASONS.insaneRoi, `名义 ROI ${roi.toFixed(0)}% > 500%（多半是错标型号）`);
  const expRoi = roi * Number(ctx?.pSurvive ?? 0.5) - Number(ctx?.deployPct ?? 3.33);


  // 双源分歧（2026-11-05）：收入口径本身不确定时，不许给 pass
  const spread = Number(ctx?.densitySpreadPct);
  if (Number.isFinite(spread) && spread > 10) {
    return watch(REASONS.densitySpread, `密度双源分歧 ${spread}%`, {
      maxSpreadPct: 10,
      note: '两个独立源在收入口径上差 >10%：先把分歧降到 10% 以内，再谈值不值',
    });
  }

  if (expRoi < Number(ctx?.targetProfitPct ?? 20)) {
    return { action: 'skip', verdict: 'skip', reasonCode: REASONS.expRoiLow, expRoi: +expRoi.toFixed(1), note: `名义 ${roi.toFixed(1)}%`, cost };
  }
  return { action: 'rent', verdict: 'pass', reasonCode: REASONS.rent, expRoi: +expRoi.toFixed(1), note: null, cost };
}