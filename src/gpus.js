// 各型号显卡 pearlhash 单卡参考算力（TH/s）
// 来源：WhatToMine「Best GPUs for mining Pearl」（矿池回报算力）+ WildRig 0.50.9 发布说明（B200/B300）
// est=true 表示是估算值：自动租用会跳过，需先手动试租一台、拿到实测算力后才参与自动租用
export const BASE_HASHRATES = [
  { key: 'RTX5090', name: 'RTX 5090', th: 370 },
  { key: 'RTX4090', name: 'RTX 4090', th: 310 },
  { key: 'RTX5080', name: 'RTX 5080', th: 195 },
  { key: 'RTX4080S', name: 'RTX 4080 Super', th: 175 },
  { key: 'RTX4080', name: 'RTX 4080', th: 168 },
  { key: 'RTX5070TI', name: 'RTX 5070 Ti', th: 165 },
  { key: 'RTX4070TIS', name: 'RTX 4070 Ti Super', th: 144 },
  { key: 'RTX3090TI', name: 'RTX 3090 Ti', th: 135 },
  { key: 'RTX3090', name: 'RTX 3090', th: 130 },
  { key: 'RTX4070TI', name: 'RTX 4070 Ti', th: 124 },
  { key: 'RTX4070S', name: 'RTX 4070 Super', th: 122 },
  { key: 'RTX3080TI', name: 'RTX 3080 Ti', th: 119 },
  { key: 'RTX5070', name: 'RTX 5070', th: 110 },
  { key: 'RTX3080', name: 'RTX 3080', th: 100 },
  { key: 'RTX4070', name: 'RTX 4070', th: 97 },
  { key: 'RTX5060TI', name: 'RTX 5060 Ti', th: 90 },
  { key: 'RTX2080TI', name: 'RTX 2080 Ti', th: 90 },
  { key: 'RTX3070TI', name: 'RTX 3070 Ti', th: 76 },
  { key: 'RTX4060TI', name: 'RTX 4060 Ti', th: 74 },
  { key: 'RTX3070', name: 'RTX 3070', th: 68 },
  { key: 'RTX5060', name: 'RTX 5060', th: 66 },
  { key: 'RTX3060TI', name: 'RTX 3060 Ti', th: 59 },
  { key: 'RTX4060', name: 'RTX 4060', th: 52 },
  { key: 'RTX3060', name: 'RTX 3060', th: 41 },
  { key: 'B200', name: 'B200', th: 1400, est: true },
  { key: 'B300', name: 'B300', th: 790, est: true },
  { key: 'H100SXM', name: 'H100 SXM', th: 650, est: true },
  { key: 'H100PCIE', name: 'H100 PCIE', th: 600, est: true },
  { key: 'H100NVL', name: 'H100 NVL', th: 650, est: true },
  { key: 'H200', name: 'H200', th: 650, est: true },
];

// 把 vast 的 gpu_name（如 "RTX 4080S"、"RTX 4070S Ti"、"H100 SXM"）或矿池上报的
// "NVIDIA GeForce RTX 4080 SUPER" 统一成表里的 key
export function gpuKey(raw) {
  if (!raw) return '';
  let s = String(raw).toUpperCase()
    .replace(/NVIDIA|GEFORCE|TESLA|LAPTOP GPU/g, '')
    .replace(/SUPER/g, 'S')
    .replace(/[\s_\-]+/g, '');
  s = s.replace(/(\d{4})STI$/, '$1TIS'); // RTX4070STI -> RTX4070TIS
  if (/^H100(SXM\d?|HBM3)/.test(s)) return 'H100SXM';
  if (/^H100(PCIE)/.test(s)) return 'H100PCIE';
  if (/^H100NVL/.test(s)) return 'H100NVL';
  if (/^H100$/.test(s)) return 'H100SXM';
  if (/^H200/.test(s)) return 'H200';
  return s;
}

export function hashrateTable(calib = {}) {
  return BASE_HASHRATES.map(g => {
    const c = calib[g.key];
    const measured = c && c.samples >= 3 ? c.th : null;
    return {
      ...g,
      measured,
      measuredSamples: c ? c.samples : 0,
      effective: measured ?? g.th,
      source: measured ? '实测' : (g.est ? '估算' : '参考'),
      autoOk: !!measured || !g.est,
    };
  });
}
