// 校准的信息价值（EV）：只回答一件事——"花 1 小时租这台去测交付算力，值不值"。
//
// 背景（用户 2026-11-05）：漏斗显示 1001 条 watch 里 962 条是**价格主因**
// （所需交付算力 > 规格算力），补样本不可能改变判断。剩下 39 条才是"数据可能改变决策"的，
// 而它们也必须先算账再租——PRL 那三周就是先租后想。
//
// EV = P(交付 ≥ need) × 该机预期日收益 × 剩余天数 − 1 小时租价
//   · P 用该型号历史样本里 ≥ need 的比例（无样本 → null，视为不可估 → 不租）
//   · 预期日收益 = need × revenuePerThHour × 24（保守：只按"刚好过线"的交付算）

export function calibrationEv({ needTh, samples = [], revenuePerThHour, daysLeft, rentPerHour }) {
  const need = Number(needTh);
  const rev = Number(revenuePerThHour);
  const days = Number(daysLeft);
  const rent = Number(rentPerHour);
  if (!(need > 0) || !(rev > 0) || !(days > 0) || !(rent > 0)) {
    return { evUsd: null, p: null, viable: false, why: '输入不全' };
  }
  const vals = (samples || []).map(Number).filter(v => Number.isFinite(v) && v > 0);
  if (!vals.length) {
    // 没有样本 = 连 P 都不知道，不能拍 0.5 当先验（那正是"用魔法常数"的老毛病）
    return { evUsd: null, p: null, viable: false, why: '该型号无历史样本，P 不可估' };
  }
  const p = vals.filter(v => v >= need).length / vals.length;
  const dailyProfit = need * rev * 24;
  const evUsd = p * dailyProfit * days - rent;
  return {
    evUsd: +evUsd.toFixed(4), p: +p.toFixed(2),
    dailyProfitUsd: +dailyProfit.toFixed(4), daysLeft: days, rentPerHour: rent,
    viable: evUsd > 0,
    why: evUsd > 0 ? `P=${p.toFixed(2)} × $${dailyProfit.toFixed(3)}/天 × ${days} 天 > 租价 $${rent}` : `EV 为负：P=${p.toFixed(2)}`,
  };
}

/** 一批候选（漏斗里 th_uncalibrated 且非价格主因的）→ 购物单 + 预算结论 */
export function calibrationShoppingList(candidates, { revenuePerThHour, daysLeft, rentPerHour }) {
  const rows = (candidates || []).map(c => ({
    model: c.model, needTh: c.needTh, specTh: c.specTh,
    ...calibrationEv({ needTh: c.needTh, samples: c.samples, revenuePerThHour, daysLeft, rentPerHour }),
  }));
  const viable = rows.filter(r => r.viable);
  return {
    rows, viable,
    budgetUsd: +viable.reduce((a, r) => a + Number(rentPerHour || 0), 0).toFixed(2),
    conclusion: viable.length ? `${viable.length} 条 EV>0，建议预算 $${(viable.length * rentPerHour).toFixed(2)}` : '当前校准预算 = $0（无一条 EV>0）',
  };
}