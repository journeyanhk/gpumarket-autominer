// 租用 EV（不是"校准价值"，2026-11-05 用户纠正）：
// 它只回答"花 1 小时租这台来挖矿值不值"——那是 decide() 的活。
// **校准预算不用这个公式论证**：单机测出的 TH 不迁移到别的 host/配置，
// 所以"这次测量会改变某个决策"的概率趋近 0，校准预算直接写死 $0（见 contracts §6.11）。
//
// 背景（用户 2026-11-05）：漏斗显示 1001 条 watch 里 962 条是**价格主因**
// （所需交付算力 > 规格算力），补样本不可能改变判断。剩下 39 条才是"数据可能改变决策"的，
// 而它们也必须先算账再租——PRL 那三周就是先租后想。
//
// EV = P(交付 ≥ need) × 该机预期日收益 × 剩余天数 − 1 小时租价
//   · P 用该型号历史样本里 ≥ need 的比例（无样本 → null，视为不可估 → 不租）
//   · 预期日收益 = need × revenuePerThHour × 24（保守：只按"刚好过线"的交付算）

export function rentEv({ needTh, specTh = null, samples = [], revenuePerThHour, daysLeft, rentPerHour }) {
  const need = Number(needTh);
  const rev = Number(revenuePerThHour);
  const days = Number(daysLeft);
  const rent = Number(rentPerHour);
  if (!(need > 0) || !(rev > 0) || !(days > 0) || !(rent > 0)) {
    return { evUsd: null, p: null, viable: false, why: '输入不全' };
  }
  // 机器不可能交付超过规格：need > spec 时这不是"数据问题"，是价格问题，
  // 用 need 当收入基数会把 EV 算成正的（300 TH × 收入 远大于 1 小时租价），那是假象。
  const spec = Number(specTh);
  if (spec > 0 && need > spec) {
    return { evUsd: null, p: null, viable: false, why: `需要 ${need} TH > 规格 ${spec} TH：价格主因，补样本无解` };
  }
  const vals = (samples || []).map(Number).filter(v => Number.isFinite(v) && v > 0);
  if (!vals.length) {
    // 没有样本 = 连 P 都不知道，不能拍 0.5 当先验（那正是"用魔法常数"的老毛病）
    return { evUsd: null, p: null, viable: false, why: '该型号无历史样本，P 不可估' };
  }
  // Laplace 平滑 (k+1)/(n+2)：n=5 时"4 台都好"不该读成 80% 把握，
  // 尤其那 4 台很可能来自同一个房东（2026-11-05 用户要求）。
  const k = vals.filter(v => v >= need).length;
  const p = (k + 1) / (vals.length + 2);
  const dailyProfit = need * rev * 24;
  const evUsd = p * dailyProfit * days - rent;
  return {
    evUsd: +evUsd.toFixed(4), p: +p.toFixed(3), k, n: vals.length,
    dailyProfitUsd: +dailyProfit.toFixed(4), daysLeft: days, rentPerHour: rent,
    viable: evUsd > 0,
    why: evUsd > 0 ? `P=${p.toFixed(2)} × $${dailyProfit.toFixed(3)}/天 × ${days} 天 > 租价 $${rent}` : `EV 为负：P=${p.toFixed(2)}`,
  };
}

/** 一批候选（漏斗里 th_uncalibrated 且非价格主因的）→ 购物单 + 预算结论 */
export function rentEvShoppingList(candidates, { revenuePerThHour, daysLeft, rentPerHour }) {
  const rows = (candidates || []).map(c => ({
    model: c.model, needTh: c.needTh, specTh: c.specTh,
    ...rentEv({ needTh: c.needTh, specTh: c.specTh, samples: c.samples, revenuePerThHour, daysLeft, rentPerHour }),
  }));
  const viable = rows.filter(r => r.viable);
  return {
    rows, viable,
    budgetUsd: +viable.reduce((a, r) => a + Number(rentPerHour || 0), 0).toFixed(2),
    // 这里只给"租用"建议；校准预算恒为 $0，与本列表无关（§6.11）
    conclusion: viable.length ? `${viable.length} 条租用 EV>0，建议预算 $${(viable.length * rentPerHour).toFixed(2)}` : '无一条租用 EV>0',
  };
}