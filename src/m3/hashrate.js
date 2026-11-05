// 每卡算力表（TH/s）——**这是 ±30% 量级的不确定，不是单位系数**（2026-11-05 用户判定）。
// 单位统一 TH/s，注释里写清换算，避免"48 MH/s 写成 0.048 TH/s"（我自己犯过，差 1e6）。
export const CARD_HASHRATE_TH = {
  pearl: null,              // 运行时从引擎取（交付算力，不是规格）
  kawpow: 48e6 / 1e12,      // 48 MH/s
  autolykos: 175e6 / 1e12,  // 175 MH/s
  etchash: 92e6 / 1e12,     // 92 MH/s
  fishhash: 90e6 / 1e12,    // 90 MH/s
  karlsenhashv2: 350e6 / 1e12,
  cuckatoo32: 1.6e9 / 1e12,
};

export const HASHRATE_NOTE = '每卡算力为公开量级（±30%）；单位系数由 tools/unit-anchors.json 断言，二者不是一回事';
