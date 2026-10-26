// 本地存储：data/config.json（设置+密钥，只存在你电脑上）、data/state.json（运行状态）
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DEFAULT_CONFIG = {
  vastApiKey: '',
  wallet: '',               // Pearlhash 用的 PRL 钱包
  kryptexWallet: '',        // Kryptex 用的 PRL 钱包（可以和上面不同，方便分开统计收益）
  defaultPool: 'pearlhash', // 自动/手动租用时默认挖哪个矿池
  failover: true,           // 默认矿池故障时，把机器自动切到另一个矿池，恢复后切回
  failoverMinutes: 5,       // 故障持续多久才切
  nockAddress: '',          // 可选：Nockchain 收款地址，矿池会额外分 NOCK
  includeNock: true,        // 矿池已登记 NOCK 地址时，把 NOCK 收益计入利润
  // —— 核心 4 项 ——
  targetProfitPct: 30,      // 达到这个收益率（利润÷租金）才租
  useSpot: false,           // 竞价实例（可被抢占）。开之前先读 docs/contracts.md §8
  spotBidFactor: 0.75,      // 出价 = 该机器每小时收入 × 这个系数（越低越赚，但越抢不到）
  spotBidBuffer: 0.1,       // 入场价之上再让这么多（10%）：贴着 min_bid 出价会被秒顶，实测 1 秒就没
  stopLossPct: 0,           // 已租机器实时收益率低于它并持续一段时间就退租
  maxInstances: 5,          // 最多同时租几台
  maxHourlySpend: 2,        // 所有机器加起来每小时最多花多少美元
  // —— 开关 ——
  autoRent: false,          // 自动租用（默认关闭，先观察）
  autoDestroy: true,        // 自动退租（无算力 / 跌破止损）
  // —— 高级（一般不用改）——
  minBalanceReserve: 2,     // 余额低于它就停止新租
  runwayGuard: false,       // 续航保护开关（默认关闭，在设置里打开）
  minRunwayHours: 12,       // 余额必须够所有机器再跑这么多小时，否则停止新租
  stopLossMinutes: 30,      // 跌破止损持续多久才退租
  bootTimeoutMinutes: 20,   // 租下（或重启）后多久还没算力就判定部署失败并退租
  minerStartTimeoutMinutes: 8, // 机器开机后多久矿工还没上线就判定失败（正常不到 1 分钟）
  hashLowPct: 80,           // 实测算力低于预期的这个百分比就标为异常
  minReliability: 0.95,
  minInetDown: 200,         // 下行带宽太低的机器拉镜像要十几分钟以上
  maxGpusPerMachine: 8,
  minCuda: 12.4,
  disk: 10,
  scanIntervalSec: 300,     // 最短扫描间隔；有剩余额度信息时会自动放慢，把额度均匀用到重置前
  scanRows: 100,            // 每次搜索取多少条（vast 按条数计每日额度）
  poolUrl: 'stratum+ssl://pool.pearlhash.xyz:9443',
  image: 'vastai/base-image:cuda-12.4.1-auto',
  launchMode: 'args',       // args = 快速启动（跳过 SSH 初始化，不能 SSH 登录）；ssh = 可以 SSH 登录但开机慢
  minerArgs: '',
  proxy: '',
  port: 8290,
};

const cfgFile = path.join(DATA_DIR, 'config.json');
const stateFile = path.join(DATA_DIR, 'state.json');

function readJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}
function writeJson(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

// 设置页保存时会把所有字段写进 config.json，导致之后改了默认值也不生效。
// 这里把「仍等于旧默认值」的项升级成新默认值；用户自己改过的值保持不变。
const UPGRADES = [
  { v: 2, key: 'minInetDown', from: 20, to: 200 },
  { v: 2, key: 'scanIntervalSec', from: 180, to: 300 },
];
const CONFIG_VERSION = 2;
export function loadConfig() {
  const saved = readJson(cfgFile, {});
  const cfg = { ...DEFAULT_CONFIG, ...saved };
  const ver = saved.configVersion || 1;
  if (ver < CONFIG_VERSION) {
    for (const u of UPGRADES) if (ver < u.v && saved[u.key] === u.from) cfg[u.key] = u.to;
    cfg.configVersion = CONFIG_VERSION;
    try { writeJson(cfgFile, cfg); } catch {}
  }
  return cfg;
}
export function saveConfig(c) { writeJson(cfgFile, c); }

export function loadState() {
  return {
    managed: {},     // instanceId -> { offerId, machineId, gpuName, numGpus, expectedTh, rentedAt, belowSince }
    blacklist: {},   // machineId -> { until, reason }
    calib: {},       // gpuKey -> { th, samples }
    history: [],     // [{ t, price, netEh, usdPerThDay, spend, revenue }]
    ...readJson(stateFile, {}),
  };
}
export function saveState(s) { writeJson(stateFile, s); }

const logFile = path.join(DATA_DIR, 'events.log');
export function appendLog(line) {
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}
