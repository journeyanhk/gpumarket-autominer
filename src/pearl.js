// PRL 数据源：全部来自 Pearlhash 矿池自己的接口（链上数据，非第三方估算）
//   /api/pearl-price          币价 + 24h 涨跌
//   /api/chain-info           全网算力 networkhashps、平均出块 avg_block_time_s、难度、高度
//   /api/pool-wallet-txs      矿池钱包流水，最新 coinbase 的 receivedGrains = 当前区块奖励（1 PRL = 1e8 grains）
//   /api/account/{wallet}     connected_workers[].worker_name / gpu_info[].hashrate（H/s）
//   /api/nock-balance/{wallet} 余额 + 待结算
// 接口限速 60 次/分钟
import { request } from './http.js';

const BASE = 'https://pearlhash.xyz/api';
export const POOL_FEE = 0.01;

export async function fetchPrice() {
  const r = await request(`${BASE}/pearl-price`);
  if (typeof r?.usd !== 'number') throw new Error('币价字段缺失');
  return { usd: r.usd, change24h: r.usd_24h_change ?? null, vol24h: r.usd_24h_vol ?? null };
}

export async function fetchChain() {
  const r = await request(`${BASE}/chain-info`);
  if (!(r?.networkhashps > 0)) throw new Error('全网算力字段缺失');
  return {
    networkHs: r.networkhashps,
    blockTime: r.avg_block_time_s > 0 ? r.avg_block_time_s : 177,
    difficulty: r.difficulty,
    height: r.blocks,
  };
}

export async function fetchBlockReward() {
  const r = await request(`${BASE}/pool-wallet-txs?page=1`);
  const cb = (r?.transactions || []).find(t => t.type === 'coinbase' && t.receivedGrains > 0);
  if (!cb) throw new Error('没找到最新 coinbase 交易');
  return { reward: cb.receivedGrains / 1e8, height: cb.blockHeight };
}

export async function fetchPoolStats() {
  const r = await request(`${BASE}/stats`);
  return { poolHs: r?.hashrate ?? null, workers: r?.total_workers ?? null };
}

// 账户：矿工列表 + PRL 余额/待结算 + 矿池里登记的 NOCK 收款地址
// workers: Map<worker_name, { hs, gpus:[{name, hs}] }>
export async function fetchAccount(wallet) {
  const r = await request(`${BASE}/account/${encodeURIComponent(wallet)}`);
  const workers = new Map();
  for (const w of r?.connected_workers || []) {
    const gpus = (w.gpu_info || []).map(g => ({ name: g.name, hs: Number(g.hashrate) || 0 }));
    workers.set(String(w.worker_name), { hs: gpus.reduce((a, g) => a + g.hs, 0), gpus, version: w.version });
  }
  const prlBalance = (r?.balance_transactions || [])
    .filter(t => (t.coin_type || 'pearl') === 'pearl')
    .reduce((a, t) => a + (Number(t.amount) || 0), 0);
  // 累计入账 = 所有正数入账（负数是自动打款），再加上还没结算的部分 → 一直只增不减，用来统计实际收益
  const prlCredited = (r?.balance_transactions || [])
    .filter(t => (t.coin_type || 'pearl') === 'pearl' && Number(t.amount) > 0)
    .reduce((a, t) => a + Number(t.amount), 0);
  const nockAddr = r?.nock_payout_address;
  return {
    workers,
    prlBalance: Math.max(0, prlBalance),
    prlCredited,
    prlPending: r?.pending_rewards?.total_pending_prl ?? 0,
    prlEpochs: (r?.pending_rewards?.epochs || []).filter(e => (e.coin_type || 'pearl') === 'pearl'),
    nockPayoutAddress: nockAddr && !/please set/i.test(nockAddr) ? nockAddr : null,
  };
}

// NOCK 余额/待结算（Pearlhash 按同样的算力份额额外分 NOCK）
export async function fetchNock(wallet) {
  const r = await request(`${BASE}/nock-balance/${encodeURIComponent(wallet)}`);
  return { balance: r?.balance ?? 0, pending: r?.pending_rewards?.total_pending ?? 0, epochs: r?.pending_rewards?.epochs || [] };
}

// 用同一结算小时的 PRL 和 NOCK 待结算反推「矿池每分 1 PRL 附带多少 NOCK」
// 每个周期：矿池总量 = 你的数量 ÷ 你的份额；两币总量之比就是比例，和你自己算力多少无关
export function nockPerPrl(prlEpochs, nockEpochs) {
  const hourKey = s => (String(s).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [])[0];
  const ratios = [];
  for (const n of nockEpochs) {
    const p = prlEpochs.find(e => hourKey(e.epoch_label) === hourKey(n.epoch_label));
    if (!p || !(n.share > 0 && p.share > 0 && n.amount > 0 && p.amount > 0)) continue;
    ratios.push((n.amount / n.share) / (p.amount / p.share));
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

// NOCK 价格：CoinGecko 为主，CoinLore 兜底
export async function fetchNockPrice() {
  try {
    const r = await request('https://api.coingecko.com/api/v3/simple/price?ids=nockchain&vs_currencies=usd&include_24hr_change=true', { timeoutMs: 15000 });
    if (r?.nockchain?.usd > 0) return { usd: r.nockchain.usd, change24h: r.nockchain.usd_24h_change ?? null, src: 'CoinGecko' };
  } catch {}
  const r = await request('https://api.coinlore.net/api/ticker/?id=183031', { timeoutMs: 15000 });
  const t = Array.isArray(r) ? r[0] : null;
  if (!(Number(t?.price_usd) > 0)) throw new Error('NOCK 价格获取失败');
  return { usd: Number(t.price_usd), change24h: Number(t.percent_change_24h) || null, src: 'CoinLore' };
}

// Nockchain 地址：base58，不含 0 O I l；Pearlhash 输入框最长 128
export function validNockAddress(a) {
  return typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{30,128}$/.test(a);
}

// 每 1 H/s 每小时能挖到多少美元（已扣矿池手续费，默认 Pearlhash 的 1%）
export function usdPerHsHour({ usd, networkHs, blockTime, reward, fee = POOL_FEE }) {
  if (!(usd > 0 && networkHs > 0 && blockTime > 0 && reward > 0)) return 0;
  return (3600 / blockTime) * reward / networkHs * (1 - fee) * usd;
}

// bech32 地址校验（prl1...），防止钱包填错白挖
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i];
  }
  return chk;
}
export function validWallet(addr) {
  if (!addr || addr !== addr.toLowerCase() || !addr.startsWith('prl1')) return false;
  const pos = addr.lastIndexOf('1');
  const hrp = addr.slice(0, pos), data = addr.slice(pos + 1);
  if (data.length < 6) return false;
  const vals = [];
  for (const c of data) { const i = CHARSET.indexOf(c); if (i < 0) return false; vals.push(i); }
  const hrpExp = [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
  const pm = polymod([...hrpExp, ...vals]);
  return pm === 1 || pm === 0x2bc830a3; // bech32 / bech32m
}

// 在控制端（你的电脑）解析 WildRig 最新 Linux 包的真实下载地址，再塞给 GPU 机器
// 避免 GPU 机器（很多在国内）自己访问 GitHub API 失败
export async function resolveWildrigUrl() {
  const r = await request('https://api.github.com/repos/andru-kun/wildrig-multi/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  });
  const a = (r?.assets || []).find(x => /linux/i.test(x.name) && !/hiveos/i.test(x.name) && /\.tar\.(xz|gz)$/.test(x.name));
  if (!a) throw new Error('GitHub 最新版里没找到 Linux 包');
  return { url: a.browser_download_url, version: r.tag_name, name: a.name };
}
