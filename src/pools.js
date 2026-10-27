// 矿池定义 + Kryptex 接口（Pearlhash 的接口在 pearl.js）
//
// Kryptex 公开 API（https://pool.kryptex.com/api，无需登录）：
//   /prl/api/v1/pool/info                 手续费 commission、矿池/全网算力、出块奖励、各地区服务器
//   /prl/api/v3/miner/workers/{钱包}       每个矿工：status、last_share、opened_at、avg_hashrate_30m/3h/24h（H/s，字符串）
//   /prl/api/v1/miner/balance/{钱包}       total / unconfirmed / confirmed（PRL）
//   /prl/api/v1/miner/payouts/{钱包}/stats paid（累计已打款）、unpaid
// 注意：Kryptex 的算力是矿池按份额估算的平均值，最短 30 分钟，没有逐张显卡的数据
import { request } from './http.js';

export const POOLS = {
  pearlhash: { id: 'pearlhash', name: 'Pearlhash', fee: 0.01, minerFee: 0, miner: 'WildRig', nock: true, perGpu: true, site: 'https://pearlhash.xyz' },
  kryptex: { id: 'kryptex', name: 'Kryptex', fee: 0.03, minerFee: 0.02, miner: 'SRBMiner', nock: false, perGpu: false, site: 'https://pool.kryptex.com/prl' },
};
export const POOL_IDS = Object.keys(POOLS);
export const poolName = id => POOLS[id]?.name || id || '—';

// 两个地址都能访问同一套接口，第一个不通时用第二个
const KX_BASES = ['https://pool.kryptex.com/prl/api', 'https://prl-api.kryptex.network/api'];
let kxBase = 0;
async function kx(path, opt) {
  let last;
  for (let i = 0; i < KX_BASES.length; i++) {
    const b = (kxBase + i) % KX_BASES.length;
    try {
      const r = await request(KX_BASES[b] + path, { timeoutMs: 20000, ...opt });
      kxBase = b;
      return r;
    } catch (e) {
      last = e;
      if (e.status >= 400 && e.status < 500 && e.status !== 403 && e.status !== 429) throw e; // 参数错误换地址也没用
    }
  }
  throw last;
}

export async function fetchKryptexInfo() {
  const r = await kx('/v1/pool/info');
  if (!(r?.net_hashrate > 0)) throw new Error('Kryptex 矿池信息字段缺失');
  return {
    fee: Number(r.commission?.['PPS+'] ?? r.fee ?? POOLS.kryptex.fee),
    poolHs: Number(r.hashrate) || null,
    networkHs: Number(r.net_hashrate),
    blockTime: Number(r.block_time) || null,
    reward: Number(r.block_reward) || null,
    workers: r.workers ?? null,
  };
}

// 矿工列表。hs 用 30 分钟均值；最近 5 分钟没交过份额的视为离线（hs=0）
export async function fetchKryptexWorkers(wallet, now = Date.now()) {
  const r = await kx(`/v3/miner/workers/${encodeURIComponent(wallet)}`);
  const workers = new Map();
  for (const w of r?.results || []) {
    const lastShare = Number(w.last_share) || 0;
    const live = w.status === 'online' && now - lastShare < 5 * 60_000;
    const hs30 = Number(w.avg_hashrate_30m) || 0;
    workers.set(String(w.worker), {
      hs: live ? hs30 : 0, live, hs30, hs3h: Number(w.avg_hashrate_3h) || 0,
      openedAt: Number(w.opened_at) || null, lastShare, gpus: [], version: w.agent || '', scheme: w.scheme || '',
    });
  }
  return workers;
}

// 累计挖到的 PRL = 已打款 + 未打款（含未确认）。只会增加，用来算一段时间内的实际收益
export async function fetchKryptexEarned(wallet) {
  const [bal, st] = await Promise.all([
    kx(`/v1/miner/balance/${encodeURIComponent(wallet)}`),
    kx(`/v1/miner/payouts/${encodeURIComponent(wallet)}/stats`),
  ]);
  const total = Number(bal?.total) || 0;
  const paid = Number(st?.paid) || 0;
  return { balance: total, unconfirmed: Number(bal?.unconfirmed) || 0, paid, earned: paid + total };
}

// 按机器所在地区选最近的 Kryptex 服务器（vast 的 geolocation 形如 "Texas, US"）
const KX_REGION = {
  us: ['US', 'CA', 'MX'],
  br: ['BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'PY', 'EC', 'VE', 'BO'],
  hk: ['HK', 'CN', 'MO', 'TW', 'JP', 'KR'],
  sg: ['SG', 'MY', 'TH', 'VN', 'ID', 'PH', 'IN', 'AU', 'NZ', 'BD', 'PK', 'LK'],
  ru: ['RU', 'BY', 'KZ', 'UZ', 'KG', 'AM', 'GE', 'AZ'],
  ae: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'JO', 'EG', 'TR', 'IR', 'IQ'],
  eu: ['DE', 'FR', 'NL', 'GB', 'UK', 'PL', 'SE', 'FI', 'NO', 'DK', 'ES', 'PT', 'IT', 'CH', 'AT', 'BE', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'IE', 'LT', 'LV', 'EE', 'UA', 'RS', 'HR', 'SI', 'IS', 'LU', 'MD'],
};
export function kryptexHost(geo) {
  const cc = (String(geo || '').match(/([A-Za-z]{2})\s*$/) || [])[1]?.toUpperCase();
  for (const [r, list] of Object.entries(KX_REGION)) if (cc && list.includes(cc)) return `prl-${r}.kryptex.network`;
  return 'prl.kryptex.network';
}

// 矿工连接参数（写进开机脚本）。$W 在机器上展开成矿工名 v<实例号>
// Pearlhash 用 WildRig（0 开发费）；Kryptex 实测 WildRig 连上后交不出份额，改用 Kryptex 推荐的 SRBMiner（开发费约 2%）
export function minerTarget(pool, { wallet, nockAddress, geo, pearlUrl }) {
  if (pool === 'pearlhash') {
    const user = nockAddress ? `${wallet}@nock=${nockAddress}` : wallet;
    return { bin: 'wr', cmd: `--algo pearlhash --url ${pearlUrl || 'stratum+ssl://pool.pearlhash.xyz:9443'} --user ${user} --worker $W` };
  }
  if (pool === 'kryptex') {
    // Kryptex 的矿工名写在用户名里：钱包.矿工名（与 Kryptex 官方教程的 SRBMiner 命令一致，TCP 7048 端口）
    // --api-enable：把 accepted/rejected/stale 暴露在 127.0.0.1:21555，供机器上的脚本每 5 分钟采样
    return { bin: 'srb', cmd: `--disable-cpu --algorithm pearlhash --pool ${kryptexHost(geo)}:7048 --wallet ${wallet}.$W --api-enable --api-port 21555` };
  }
  throw new Error('未知矿池 ' + pool);
}
