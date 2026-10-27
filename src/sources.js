// 收入密度的多源选择：三个独立来源算出来的 $/TH·天 差 20%+（Kryptex 用实际 194s 出块，
// 另两个用理论 152-154s）。ROI 门槛落在哪个源上，决定了"看起来赚"还是"实际亏"。
// 用保守源（默认取三者最小值）才在实际到账里兑现；乐观源只在面板展示。
export function densityOf({ usd, networkHs, blockTime, reward, fee = 0.01 }) {
  if (!(usd > 0 && networkHs > 0 && blockTime > 0 && reward > 0)) return 0;
  return (3600 / blockTime) * reward / networkHs * (1 - fee) * usd * 1e12 * 24;
}

const MODES = new Set(['min', 'median', 'pearlhash', 'kryptex', 'whattomine', 'max']);

// sources: { pearlhash: {usd,networkHs,blockTime,reward}, kryptex: {...}, whattomine: {...} }
export function pickDensity(sources = {}, mode = 'min') {
  const entries = Object.entries(sources)
    .map(([k, v]) => [k, densityOf(v)])
    .filter(([, d]) => d > 0);
  if (!entries.length) return { density: 0, src: null, all: {} };
  const all = Object.fromEntries(entries.map(([k, d]) => [k, +d.toFixed(6)]));
  if (MODES.has(mode) && ['pearlhash', 'kryptex', 'whattomine'].includes(mode)) {
    const hit = entries.find(([k]) => k === mode);
    if (hit) return { density: hit[1], src: hit[0], all };
  }
  const vals = entries.map(([, d]) => d).sort((a, b) => a - b);
  if (mode === 'max') { const [k, d] = entries.reduce((a, b) => (b[1] > a[1] ? b : a)); return { density: d, src: k, all }; }
  if (mode === 'median') {
    const mid = vals[Math.floor(vals.length / 2)];
    const [k] = entries.find(([, d]) => d === mid);
    return { density: mid, src: k, all };
  }
  // 默认 min：最保守
  const min = vals[0];
  const [k] = entries.find(([, d]) => d === min);
  return { density: min, src: k, all };
}
