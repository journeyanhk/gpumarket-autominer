// 本地存储：data/config.json（设置+密钥，只存在你电脑上）、data/state.json（运行状态）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');

// 硬保护：测试模式下只允许写系统临时目录。
// DATA_DIR 是 import 时按 cwd 算的，靠「记得先 chdir 再 import」是不牢的——
// 2026-10-27 就有测试把数据写进了生产 data/state.json（引擎重启时报「实例 501 已不在 vast 列表中」）。
// 这里不依赖导入顺序：只要进程处于测试模式且目标不是临时目录，直接抛错。
const TEST_MODE = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || process.env.PRL_TEST === '1';
export function assertWritable(dir = DATA_DIR) {
  if (!TEST_MODE) return;
  const tmp = path.resolve(os.tmpdir());
  const abs = path.resolve(dir);
  if (abs !== tmp && !abs.startsWith(tmp + path.sep)) {
    throw new Error(`测试模式拒绝写入 ${abs}（只允许系统临时目录 ${tmp}）：检查是否漏了 process.chdir`); 
  }
}
assertWritable();
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
  spotBidBuffer: 0.1,       // 兼容旧配置；新公式用 spotBidMultiplier
  spotBidMultiplier: 1.25,  // 以入场价的 1.25 倍作为目标出价（实测 10% 会被秒顶）
  spotBidFloorRatio: 0.7,   // 出价不低于收入的 70%（保证有竞争力）
  stopLossPct: 0,           // 已租机器实时收益率低于它并持续一段时间就退租
  maxInstances: 5,          // 最多同时租几台
  maxHourlySpend: 2,        // 所有机器加起来每小时最多花多少美元
  // —— 开关 ——
  autoRent: false,          // 自动租用（默认关闭，先观察）
  autoDestroy: true,        // 自动退租（无算力 / 跌破止损）
  // —— 高级（一般不用改）——
  rentMinIntervalMin: 10,   // 两次自动租用之间至少隔多久（分钟）——避免"被顶→秒补→再被顶"的拉锯
  maxRentsPerHour: 3,       // 每小时最多自动租几台
  maxBidRaises: 0,          // 被顶后最多加价几次（0 = 不追价：20 次改价 0 次救活，见 docs/contracts.md §8）
  preemptCooldownMin: 5,    // 竞价被收回后，冷静多久再补（分钟）
  // 实验参数的作用域覆盖：只对 pinned（测量锚点）机器生效，绝不外溢到自动租用。
  // 例：{ targetProfitPct: -50, stopLossPct: -90, stopLossMinutes: 120 }
  // 为什么必须这么写：实验参数留在全局配置里，等于让 autoRent 用实验门槛去租生产机
  // （2026-10-27 的 3060 Ti 就是以 −48.5% ROI 进场：它注定额亏，却因为止损被放到 −90% 而活着）。
  expOverride: null,
  dailyFailBudget: 0.3,   // 每日"失败成本"（租到手却没出过一份份额的租金）上限，到顶停租到明天
  minBidStablePct: 10,    // 竞价机 min_bid 30 分钟内变动超过这个百分比就跳过（正在被抢）
  // 窗口模式：利润只在"收入密度 ÷ 租金地板"越过 1 的时候出现，而平时的风控（稳定性过滤、
  // 失败成本封顶、时租上限）恰好会在窗口期挡住下单。这里只放宽这三项——
  // **绝不放宽 maxBidRaises**：追价 9 台 0 次救活、机制上是房东收回而非价高者得，窗口期也一样。
  windowMode: {
    enabled: true,
    chg1hPct: 8,            // 触发 A：PRL 1 小时涨幅 ≥ 8%
    ratio: 1.0,             // 触发 B：最优报价的「收入密度 ÷ 地板」≥ 1.0
    densityRise24hPct: 15,  //        且密度 24 小时上升 ≥ 15%（币价没涨也算窗口）
    minutes: 360,           // 单次窗口最长 6 小时，到点自动退出
    minBidStablePct: 50,    // 窗口内放宽：min_bid 波动阈值
    failBudgetUsd: 1.0,     // 窗口内放宽：失败成本封顶改成绝对额 $1/窗口（不是无限）
    maxHourlySpend: 0.6,    // 窗口内放宽：总时租上限
  },
  l1Default: 0.8,           // 没有样本的型号，按"份额反推算力 ÷ 矿工自报"= 0.8 保守折算
  l1ModelCap: 1.0,          // 型号口径封顶：>1.0 的增益只允许通过房东口径使用（防跨房东虚高）
  // 场所单点降级：Gate 现货（唯一变现出口）或 Lighter 永续（唯一对冲腿）任一不可用 → 保护态
  venueGuard: { enabled: true, inventoryCapPrl: 50 },
  // 房东存活率（用户 2026-10-29 定）：收回率 >60% 且中位存活 <20 分钟 → 7 天不租；
  // 收回 ≥2 次 → 24 小时；样本=1 且短命 → 24 小时观察期。
  hostBan: { ratePct: 60, medianMin: 20, days: 7, probationHours: 24, minSamplesForLong: 2, paroleDays: 7 },
  windowScanIntervalSec: 90,  // 窗口期二次确认的间隔（原 60 秒太快，45 分钟就把窗口桶烧光）
  survivalMinLifeMin: 30,   // 「活下来」的门槛：存活 ≥ 30 分钟才算成功样本
  deployCostMin: 2,         // 部署成本（分钟），计入期望 ROI
  unknownHostMaxConcurrent: 1, // 没有历史的房东，同时最多试 1 台
  // 额度分桶：巡航只花 40%，60% 锁给窗口（窗口通常出现在亚洲/美国盘交叠的几小时）
  cruiseScanRows: 20,     // 巡航每次取多少行（vast 按"返回行数"计费，越小能扫越多次）
  windowScanRows: 50,     // 窗口期每次取多少行（只在匿名发现过线时才动用 key 桶）
  chg6hPct: 8,            // 第三种窗口触发：6 小时涨幅 ≥ 8%
  stairRatio: 1.1,        //                   且 密度÷地板 ≥ 1.1（阶梯式上涨）
  offerCacheMaxMin: 30,   // 缓存报价可用于下单的最大年龄（额度耗尽时的应急通道）
  anonCruiseIntervalMin: 2, // 匿名巡航间隔（分钟）：廉价竞价机寿命只有几分钟
  anonCruiseRows: 30,       // 匿名巡航每次取 30 行（按 min_bid 升序）
  anonBackoffMin: 5,        // 匿名被频率锁时的退避
  minBalanceStop: 5,        // 总开关：余额低于此值，一切新租停止
  maxSourceStaleMin: 60,    // 总开关：行情三源全部失效超过这么久，停止新租
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
  revenueSource: 'min',    // 收入密度取哪一路：min（默认，最保守）/ median / pearlhash / kryptex / whattomine / max
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
  assertWritable(path.dirname(f));
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
    leases: [],      // 租约台账：一台机器一条完整生命周期记录（见 src/leases.js）
    hostStats: {},   // 房东维度：1 小时内收回 ≥2 台 → 该房东已知机器拉黑 24h
    l1ByModel: {},   // gpuKey -> { samples: [], median, n }：实测「份额反推算力 ÷ 矿工自报」
    l1ByHost: {},    // hostId -> { samples: [], median, n }：同一房东的机器口径更稳（型号可能被标错）
    hostBans: {},    // hostId -> { until, why, at }：房东级黑名单（机器级黑名单挡不住换机器挂牌）
    machineHost: {}, // machineId -> hostId：搜索接口不返回 host_id，租过一次就记住
    venueHealth: null, // { at, gate:{ok,why}, lighter:{ok,why} } 场所可用性
    venueGuard: { down: false, why: null, since: 0 }, // 单点降级总开关
    windowState: null, // { active, until, reason, startedAt }：窗口模式状态
    failSpend: { day: '', usd: 0 },   // 每日失败成本（部署失败/刚下就被收回的租金）
    minBidHist: {},  // machineId -> [{t, mb}]，用于 min_bid 30 分钟稳定性过滤
    ...readJson(stateFile, {}),
  };
}
export function saveState(s) { writeJson(stateFile, s); }

const logFile = path.join(DATA_DIR, 'events.log');
export function appendLog(line) {
  try { assertWritable(path.dirname(logFile)); fs.appendFileSync(logFile, line + '\n'); } catch (e) { if (TEST_MODE && /测试模式/.test(e.message)) throw e; }
}
