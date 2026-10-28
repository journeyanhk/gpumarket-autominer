// 核心引擎：行情 → 市场扫描 → 自动租用部署 → 实时利润监控 → 自动退租
import { Vast } from './vast.js';
import * as P from './pearl.js';
import { gpuKey, hashrateTable } from './gpus.js';
import { buildOnstart, workerName, SCRIPT_VERSION } from './onstart.js';
import { POOLS, POOL_IDS, poolName, minerTarget, fetchKryptexInfo, fetchKryptexWorkers, fetchKryptexEarned } from './pools.js';
import { loadConfig, saveConfig, loadState, saveState, appendLog, DEFAULT_CONFIG } from './store.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './miners.js';
import { pickDensity } from './sources.js';
import { request } from './http.js';
import { newLease, closeLease, endReasonOf, preemptKindOf, summarize, netUsdOf } from './leases.js';

const MIN = 60_000;
const LABEL = 'prl-auto';
// 算力样本按实例 ID 存，统一转成字符串当键（数字和字符串的 ID 都能对上，不会出现 NaN 串数据）
class KeyMap extends Map {
  get(k) { return super.get(String(k)); }
  set(k, v) { return super.set(String(k), v); }
  has(k) { return super.has(String(k)); }
  delete(k) { return super.delete(String(k)); }
}
const MIN_GPU_PRICE = 0.04; // vast 上单卡时租基本不会低于这个价：某型号按当前币价连这个价都达不到目标，就不搜它
const ACTIVE = new Set(['running', 'loading', 'created', 'scheduling']);
const SWITCH_TIMEOUT_MIN = 8;   // 改标签后多久还没在新矿池出算力就判定切换失败
const PREEMPT_DESTROY_MIN = 5;  // 竞价被抢占后，最多留多久（stopped 也在收磁盘费）
// 真正「平台已收走」的终态：出现这些才允许立刻判 preempted
const TERMINAL_STATUS = new Set(['exited', 'stopped', 'offline', 'failed']);
const KX_WARMUP_MIN = 30;       // Kryptex 只有 30 分钟均值，刚切过去的前 30 分钟不判断算力偏低/止损
const labelPool = label => (String(label || '').match(/\bpool=([a-z]+)/) || [])[1] || null;

export class Engine {
  constructor() {
    this.cfg = loadConfig();
    this.st = loadState();
    this.st.aliases ||= {};
    if (this.st.quotaEstSource !== 'learned') { this.st.quotaEst = null; }
    delete this.st.searchQuota;
    this.vast = new Vast(this.cfg.vastApiKey);
    this.market = {
      price: null, change24h: null, networkHs: null, blockTime: null, reward: null, height: null, poolHs: null, updatedAt: 0, error: null,
      nockPrice: null, nockChange24h: null, nockSrc: null, nockPerPrl: this.st.nockPerPrl ?? null,
      // 多源收入密度：默认取三者最小值（保守），避免用乐观源把负收益看成正收益
      sources: null, sourceName: null, density: 0, params: null,
    };
    this.account = {
      vastBalance: null, vastEmail: null, prlBalance: null, prlPending: null,
      nockBalance: null, nockPending: null, nockPayoutAddress: null, updatedAt: 0, error: null,
    };
    this.workers = new Map();
    this.workersOk = false;
    this.rawInstances = [];
    this.instancesOk = false;
    this.offers = [];
    this.offerStats = { total: 0, known: 0, profitable: 0, scannedAt: 0, error: null };
    this.samples = new KeyMap();     // String(instanceId) -> [{t, hs}]（统一用字符串当键，避免非数字 ID 转成 NaN 后串数据）
    this.lastCalib = new Map();
    this.events = [];
    // 收入密度的 6 小时滚动均值：决策（租/不租）用均值，止损仍用瞬时值。
    // 单点密度每小时能抖动 3~5%，用瞬时值会让"今天能不能租"随刷新而变。
    this.densitySamples = [];
    // 代码热更新检测：进程启动时记下 onstart.js 的 mtime，preflight 时比对
    try { this.bootScriptMtime = fs.statSync(fileURLToPath(new URL('./onstart.js', import.meta.url))).mtimeMs; } catch { this.bootScriptMtime = null; }
    this.scanPausedUntil = this.st.scanPause?.until > Date.now() ? this.st.scanPause.until : 0; // 额度暂停跨重启保留
    this.pauseReason = this.scanPausedUntil ? this.st.scanPause.reason : null;
    this.lastRentAt = 0;
    this.rentTimes = [];              // 最近一小时的自动租用时间点
    this.preemptCooldownUntil = 0;    // 竞价被收回后的冷静期
    this.busy = new Set();
    this.everHashed = new Set();
    this.rigLogs = new Map(); // instanceId -> { t, text }
    // 租约台账：每台机器一份完整生命周期记录，用来回答「哪个型号/哪个房东值得租」。
    // 决策口径是每机时净收益（见 src/leases.js），不是 ROI 均值。
    this.leases = this.st.leases ||= [];
    // 重启后把上次的报价缓存载回来（额度耗尽期间这是唯一能出价的东西）
    try { this._loadedOffers = this.loadOffers(); } catch { this._loadedOffers = 0; }
    this.trimLeases();
    // 部署用的是 miners/manifest.json 的 pin；这里只保存「上次看到的最新版」用于日志去重，不落盘
    this.wrSeen = null;
    delete this.st.wildrig; delete this.st.srb; // 老版本留下的字段，已经没用了
    // 矿工白名单：清单缺失/不合法时不租用（宁可停，也不执行来路不明的二进制）
    this.minerManifest = null;
    this.minerError = null;
    try { this.minerManifest = loadManifest(); } catch (e) { this.minerError = e.message; }
    // Kryptex：矿工列表（30 秒）、矿池信息（1 分钟）、累计收益（5 分钟）
    this.kx = { workers: new Map(), ok: false, okAt: 0, failSince: null, error: null, info: null, infoAt: 0, earned: null, earnedAt: 0 };
    this.phOkAt = 0; this.phFailSince = null;     // Pearlhash 矿工接口最近一次成功 / 连续失败开始时间
    this.poolBadSince = {}; this.poolGoodSince = {};
    this.st.ledger ||= {};
    this.st.ledgerHist ||= [];
    this.st.failovers ||= [];
  }

  // ---------- 矿池 ----------
  walletFor(pool) { return pool === 'kryptex' ? this.cfg.kryptexWallet : this.cfg.wallet; }
  poolConfigured(pool) { return !!POOLS[pool] && P.validWallet(this.walletFor(pool)); }
  configuredPools() { return POOL_IDS.filter(p => this.poolConfigured(p)); }
  poolFee(pool) { return pool === 'kryptex' ? (this.kx.info?.fee ?? POOLS.kryptex.fee) : POOLS.pearlhash.fee; }
  // 实际扣掉的比例：矿池手续费 + 矿工开发费（Kryptex 用 SRBMiner，约 2%）
  effFee(pool) { return 1 - (1 - this.poolFee(pool)) * (1 - (POOLS[pool]?.minerFee || 0)); }
  // 矿工数据是否可信（接口 2 分钟内成功过）
  poolDataOk(pool) { return pool === 'kryptex' ? this.kx.ok : this.workersOk; }
  poolApiDownMin(pool) {
    const since = pool === 'kryptex' ? this.kx.failSince : this.phFailSince;
    return since ? (Date.now() - since) / MIN : 0;
  }

  // ---------- 工具 ----------
  log(level, msg) {
    const e = { t: Date.now(), level, msg };
    this.events.unshift(e);
    this.events.length = Math.min(this.events.length, 300);
    appendLog(`${new Date(e.t).toISOString()} [${level}] ${msg}`);
    console.log(`[${level}] ${msg}`);
  }
  save() { saveState(this.st); }
  get table() { return hashrateTable(this.st.calib); }
  // 只算 PRL 的收益（按 Pearlhash 1% 手续费）
  get usdHsHrPrl() { return this.prlRate('pearlhash'); }
  prlRate(pool) {
    const m = this.market;
    // 用 revenueSource 选中的那一路参数算收入（默认三者最保守）
    const p = m.params || { networkHs: m.networkHs, blockTime: m.blockTime, reward: m.reward };
    return P.usdPerHsHour({ usd: m.price, networkHs: p.networkHs, blockTime: p.blockTime, reward: p.reward, fee: this.effFee(pool) });
  }
  // 竞价出价：收入 × 系数，但绝不超过「按目标收益率仍然划算」的上限；
  // 入场价已经高于上限的机器直接返回 null（宁可不租，也不在亏损区抢机器）。
  // 竞价出价：以「入场价 × 1.25」为起点，夹在 [收入×0.7, 收入/(1+目标ROI)] 之间。
  // 旧公式 min(收入/1.12, max(入场×1.1, 收入×1.05)) 其实永远等于 收入/1.12 ——
  // 每次都按利润上限出价，12% 的利润全让给了房东，还是被顶。
  // 新公式把利润留在自己手里：入场价×1.25 已经超过上限就直接不租。
  // thPer01 门槛是派生值，不是配置：minThPer01 = 0.1 × (1+目标ROI) ÷ 每 TH 每小时收入。
  // 币价/难度一变它就变，写死等于埋第二个真相源。
  get minThPer01() {
    const perThHr = this.usdHsHr6h * 1e12;        // $/TH/小时，用 6h 均值（决策口径）
    if (!(perThHr > 0)) return null;
    return 0.1 * (1 + this.cfg.targetProfitPct / 100) / perThHr;
  }
  // 某台机器的 thPer01（用实际会付的价：spot 用出价、按需用 dph_total）
  thPer01Of(offer) {
    const th = Number(offer.th) || 0, dph = Number(offer.dph) || 0;
    if (!(th > 0) || !(dph > 0)) return null;
    return (th / (dph / 0.1));
  }

  bidPrice(revenueHr, minBid = 0) {
    if (!(revenueHr > 0)) return null;
    const upper = revenueHr / (1 + this.cfg.targetProfitPct / 100);
    const floorRatio = Math.min(1, Math.max(0, Number(this.cfg.spotBidFloorRatio ?? 0.7)));
    const lower = revenueHr * floorRatio;
    const multi = Math.max(1, Number(this.cfg.spotBidMultiplier ?? 1.25));
    const want = minBid * multi;
    if (want > upper) return null;                 // 加价后已无利可图 → 不租
    return +Math.min(upper, Math.max(lower, want)).toFixed(4);
  }

  // 6 小时滚动均值（$/H/s/小时）；样本不足 5 分钟时退回瞬时值
  get usdHsHr6h() {
    const now = Date.now();
    const win = (this.densitySamples || []).filter(s => now - s.t <= 6 * 60 * MIN);
    if (win.length < 5) return this.usdHsHr;
    return win.reduce((a, s) => a + s.v, 0) / win.length;
  }
  recordDensity() {
    const v = this.usdHsHr;
    if (!(v > 0)) return;
    const arr = this.densitySamples;
    const last = arr[arr.length - 1];
    if (last && Date.now() - last.t < MIN) { last.v = v; return; }   // 每分钟只留一个点
    arr.push({ t: Date.now(), v });
    while (arr.length > 400) arr.shift();                              // 6h × 60 ≈ 360
  }

  // 某个矿池每 1 H/s 每小时的总收益：PRL（扣该池手续费）+ NOCK（只有 Pearlhash 有）
  usdHsHrFor(pool) {
    const prl = this.prlRate(pool);
    return POOLS[pool]?.nock ? prl * (1 + this.nockBonus) : prl;
  }
  // NOCK 额外收益占 PRL 收益的比例。只有矿池里已登记 NOCK 收款地址时才计入（没登记就领不到）
  get nockBonus() {
    const m = this.market;
    if (!this.cfg.includeNock || !this.account.nockPayoutAddress) return 0;
    if (!(m.nockPerPrl > 0 && m.nockPrice > 0 && m.price > 0)) return 0;
    if (Date.now() - (this._nockPriceAt || 0) > 30 * MIN) return 0; // NOCK 价格太旧就不算
    return m.nockPerPrl * m.nockPrice / m.price;
  }
  // 每 1 H/s 每小时的总收益（默认矿池；租用决策都按它算）
  get usdHsHr() { return this.usdHsHrFor(this.defaultPool); }
  get defaultPool() { return this.poolConfigured(this.cfg.defaultPool) ? this.cfg.defaultPool : (this.configuredPools()[0] || this.cfg.defaultPool || 'pearlhash'); }
  get marketFresh() { return Date.now() - this.market.updatedAt < 5 * MIN && this.usdHsHrPrl > 0; }
  thFor(name) {
    const k = gpuKey(name);
    return this.table.find(g => g.key === k) || null;
  }

  // ---------- 启动 ----------
  start() {
    this.log('info', `程序启动（脚本版本 v${SCRIPT_VERSION}；若与 src/onstart.js 不一致说明进程未重载）`);
    this.loop(() => this.refreshMarket(), 15_000);
    this.loop(() => this.refreshKryptex(), 30_000, 3000);
    this.loop(() => this.refreshVast(), 30_000);
    this.loop(() => this.refreshWildrig(), 6 * 60 * MIN);
    this.loop(() => this.scanTick(), 20_000, 8000);
    this.loop(() => this.decide(), 20_000, 15000);
  }
  loop(fn, interval, delay = 0) {
    const run = async () => {
      try { await fn(); } catch (e) { this.log('error', `内部错误：${e.message}`); }
      setTimeout(run, typeof interval === 'function' ? interval() : interval);
    };
    setTimeout(run, delay);
  }

  // ---------- 行情 ----------
  async refreshMarket() {
    const errs = [];
    const [price, chain, pool] = await Promise.allSettled([P.fetchPrice(), P.fetchChain(), P.fetchPoolStats()]);
    if (price.status === 'fulfilled') Object.assign(this.market, { price: price.value.usd, change24h: price.value.change24h });
    else errs.push(`币价：${price.reason.message}`);
    if (chain.status === 'fulfilled') Object.assign(this.market, chain.value);
    else errs.push(`链数据：${chain.reason.message}`);
    if (pool.status === 'fulfilled') this.market.poolHs = pool.value.poolHs;
    if (!this.market.reward || Date.now() - (this._rewardAt || 0) > 5 * MIN) {
      try { this.market.reward = (await P.fetchBlockReward()).reward; this._rewardAt = Date.now(); }
      catch (e) { errs.push(`区块奖励：${e.message}`); }
    }
    if (P.validWallet(this.cfg.wallet)) {
      const [acc, nock] = await Promise.allSettled([P.fetchAccount(this.cfg.wallet), P.fetchNock(this.cfg.wallet)]);
      if (acc.status === 'fulfilled') {
        const a = acc.value;
        this.workers = a.workers; this.workersOk = true;
        this.phOkAt = Date.now(); this.phFailSince = null;
        this.track('pearlhash', 'prl', (a.prlCredited || 0) + (a.prlPending || 0));
        const before = this.account.nockPayoutAddress;
        Object.assign(this.account, { prlBalance: a.prlBalance, prlPending: a.prlPending, nockPayoutAddress: a.nockPayoutAddress });
        if (a.nockPayoutAddress && a.nockPayoutAddress !== before) this.log('success', `矿池已登记 NOCK 收款地址 ${a.nockPayoutAddress.slice(0, 10)}…，NOCK 收益开始计入利润`);
        if (nock.status === 'fulfilled') {
          Object.assign(this.account, { nockBalance: nock.value.balance, nockPending: nock.value.pending });
          this.track('pearlhash', 'nock', (nock.value.balance || 0) + (nock.value.pending || 0));
          const r = P.nockPerPrl(a.prlEpochs, nock.value.epochs);
          if (r > 0) {
            const prev = this.market.nockPerPrl;
            this.market.nockPerPrl = prev > 0 ? prev * 0.7 + r * 0.3 : r; // 平滑
            this.st.nockPerPrl = this.market.nockPerPrl;
          }
        }
      } else {
        this.workersOk = false; this.phFailSince ||= Date.now();
        errs.push(`矿工数据：${acc.reason.message}`);
      }
    } else { this.workersOk = false; }
    if (Date.now() - (this._nockPriceAt || 0) > 5 * MIN) {
      try {
        const n = await P.fetchNockPrice();
        Object.assign(this.market, { nockPrice: n.usd, nockChange24h: n.change24h, nockSrc: n.src });
        this._nockPriceAt = Date.now();
      } catch (e) { if (!this._nockWarned) { this._nockWarned = true; this.log('warn', `NOCK 价格获取失败（不影响 PRL 计算）：${e.message}`); } }
    }
    // 多源交叉：Kryptex 与 WhatToMine 各自独立算一遍收入密度（缓存 5 分钟，别每 15 秒打一次）
    if (Date.now() - (this._srcAt || 0) > 5 * MIN) {
      const [kx, wtm] = await Promise.allSettled([
        request('https://pool.kryptex.com/prl/api/v1/pool/info', { timeoutMs: 15000 }),
        request('https://whattomine.com/coins.json', { timeoutMs: 20000 }),
      ]);
      this._srcCache = this._srcCache || {};
      if (kx.status === 'fulfilled' && Number(kx.value?.net_hashrate) > 0) {
        this._srcCache.kryptex = { networkHs: Number(kx.value.net_hashrate), blockTime: Number(kx.value.block_time) || 194, reward: Number(kx.value.block_reward) || 0 };
      }
      if (wtm.status === 'fulfilled' && Number(wtm.value?.coins?.Pearl?.nethash) > 0) {
        const c = wtm.value.coins.Pearl;
        this._srcCache.whattomine = { networkHs: Number(c.nethash), blockTime: Number(c.block_time) || 154, reward: Number(c.block_reward) || 0 };
      }
      this._srcAt = Date.now();
    }
    if (this.market.price > 0 && this.market.networkHs > 0) {
      const sources = {
        pearlhash: { usd: this.market.price, networkHs: this.market.networkHs, blockTime: this.market.blockTime, reward: this.market.reward },
        ...Object.fromEntries(Object.entries(this._srcCache || {}).map(([k, v]) => [k, { usd: this.market.price, ...v }])),
      };
      let pick;
      try { pick = pickDensity(sources, this.cfg.revenueSource || 'min'); } catch { pick = { density: 0, src: null, all: {} }; }
      this.market.sources = pick.all;
      this.market.sourceName = pick.src;
      this.market.density = pick.density;
      if (pick.src && sources[pick.src]) {
        const s2 = sources[pick.src];
        this.market.params = { networkHs: s2.networkHs, blockTime: s2.blockTime, reward: s2.reward };
      }
    }
    if (price.status === 'fulfilled' && chain.status === 'fulfilled' && this.market.reward) this.market.updatedAt = Date.now();
    // 偶尔一次超时很正常（数据 15 秒后会再拉），连续 3 次失败才记日志，恢复时再记一条
    this._mktFail = errs.length ? (this._mktFail || 0) + 1 : 0;
    if (this._mktFail === 3) this.log('warn', `Pearlhash 连续 3 次获取失败：${errs.join('；')}（网络不稳定时可在设置里填代理）`);
    if (!errs.length && this._mktFailLogged) this.log('info', 'Pearlhash 数据已恢复');
    this._mktFailLogged = this._mktFail >= 3 || (this._mktFailLogged && errs.length > 0);
    this.market.error = errs.length ? errs.join('；') : null;
    this.recordDensity();
    this.recordSamples();
    this.pushHistory();
  }

  pushHistory() {
    const h = this.st.history;
    const last = h[h.length - 1];
    if (last && Date.now() - last.t < 5 * MIN) return;
    if (!this.marketFresh) return;
    const s = this.summary();
    h.push({
      t: Date.now(), price: this.market.price, netEh: this.market.networkHs / 1e18,
      usdPerThDay: this.usdHsHr * 1e12 * 24, spend: s.spendHr, revenue: s.revenueHr,
    });
    if (h.length > 2016) h.splice(0, h.length - 2016); // 7 天
    this.save();
  }

  // 只做一件事：发现上游新版本并提示重新 pin。部署永远用清单里的版本。
  async refreshWildrig() {
    try {
      const w = await P.resolveWildrigUrl();
      if (this.wrSeen?.url === w.url) return;
      this.wrSeen = w;
      const pin = this.minerManifest?.miners?.wr;
      const behind = pin && pin.version !== w.version;
      this.log('info', `WildRig 最新版 ${w.version}${behind ? `；当前部署的是 pin 的 ${pin.version}，升级请跑 node tools/pin-miners.mjs` : '（与当前 pin 一致）'}`);
    } catch (e) {
      this.log('warn', `获取 WildRig 最新版本失败：${e.message}`);
    }
  }

  // ---------- Kryptex ----------
  async refreshKryptex() {
    const now = Date.now();
    if (now - this.kx.infoAt > MIN) {
      try { this.kx.info = await fetchKryptexInfo(); this.kx.infoAt = now; }
      catch (e) { if (!this.kx.info) this.kx.error = `矿池信息：${e.message}`; }
    }
    const wallet = this.cfg.kryptexWallet;
    if (!P.validWallet(wallet)) { this.kx.ok = false; this.kx.workers = new Map(); this.kx.failSince = null; return; }
    try {
      this.kx.workers = await fetchKryptexWorkers(wallet, now);
      this.kx.ok = true; this.kx.okAt = now; this.kx.error = null;
      if (this.kx.failSince && now - this.kx.failSince > 3 * MIN) this.log('info', 'Kryptex 数据已恢复');
      this.kx.failSince = null;
    } catch (e) {
      this.kx.ok = false; this.kx.error = e.message;
      if (!this.kx.failSince) this.kx.failSince = now;
      else if (now - this.kx.failSince > 3 * MIN) this._warnOnce('kxfail', `Kryptex 接口连续 3 分钟获取失败：${e.message}`);
    }
    if (now - this.kx.earnedAt > 5 * MIN) {
      try { this.kx.earned = await fetchKryptexEarned(wallet); this.kx.earnedAt = now; this.track('kryptex', 'prl', this.kx.earned.earned); }
      catch {}
    }
  }

  // ---------- 收益账本：每个矿池实际挖到多少 vs 花了多少租金 ----------
  // 矿池给的是「累计值」（会因为打款而减少），只累加增长部分，打款造成的下降忽略
  ledgerOf(pool) {
    const L = this.st.ledger;
    return (L[pool] ||= { since: Date.now(), prl: { last: null, acc: 0 }, nock: { last: null, acc: 0 }, spend: 0, theo: 0, hours: 0 });
  }
  // 累计到账（acc）必须是**单调**的。这里曾经踩过一个 P0 级 bug：
  // 传进来的值是「当前余额」而不是「累计到账」，于是矿池一打款余额归零、又从 0 涨回来，
  // 同一笔币被记了两次（2026-10-28 实测 Kryptex 多记 1.03、Pearlhash 多记 1.10，
  // 面板"全程盈利 +$2.26" 其实是 −$1.65）。
  // 两条防线：
  //   ① 调用方一律传单调量（Kryptex = paid + balance，Pearlhash = 正值交易之和 + pending）；
  //   ② 这里保留高水位：值一旦下降只记一次 resets 计数，绝不把 last 跟着降。
  track(pool, coin, value) {
    if (!Number.isFinite(value)) return;
    const c = this.ledgerOf(pool)[coin];
    if (c.last == null) { c.last = value; return; }
    if (value > c.last) {
      const delta = value - c.last;
      if (coin === 'prl') this.allocateCredit(pool, delta);
      c.acc += delta;
      c.last = value;
      return;
    }
    if (value < c.last) {
      // 打款/接口口径回退：累计到账不能减，也不许把高水位拉低（否则下一轮会重复计入）
      c.resets = (c.resets || 0) + 1;
      c.resetAt = Date.now();
      if (!this._warned?.ledgerReset) { this._warned ||= {}; this._warned.ledgerReset = true; this.log('warn', `${pool} 的累计到账计数回落（$${value.toFixed(4)} < 高水位 ${c.last.toFixed(4)}），已忽略本次回落`); }
    }
  }
  // 把这段时间的租金和理论收益记到机器当前所在的矿池
  accrue(list, now = Date.now()) {
    const dt = this._accrueAt ? Math.min(120_000, now - this._accrueAt) : 0;
    this._accrueAt = now;
    if (dt <= 0) return;
    const h = dt / 3_600_000;
    for (const x of list) {
      if (!(ACTIVE.has(x.status) || x.phase === 'booting')) continue;
      const L = this.ledgerOf(x.pool);
      L.spend += x.dph * h;
      L.theo += (x.avgHs > 0 ? x.revenueHr : 0) * h;
      L.hours += x.avgHs > 0 ? h : 0;
    }
    // 每小时存一个快照，用来算最近 24 小时 / 7 天的对比
    const H = this.st.ledgerHist;
    if (!H.length || now - H[H.length - 1].t >= 60 * MIN) {
      const snap = { t: now };
      for (const p of POOL_IDS) { const L = this.st.ledger[p]; if (L) snap[p] = { prl: L.prl.acc, nock: L.nock.acc, spend: L.spend, theo: L.theo, hours: L.hours }; }
      H.push(snap);
      if (H.length > 24 * 31) H.splice(0, H.length - 24 * 31);
      this.save();
    }
  }
  // 最近 windowH 小时（null = 从开始统计以来）每个矿池的实际收益、租金、收益率
  compare(windowH) {
    const now = Date.now();
    const H = this.st.ledgerHist;
    const base = windowH == null ? null : [...H].reverse().find(s => s.t <= now - windowH * 60 * MIN) || H[0] || null;
    const out = {};
    for (const p of POOL_IDS) {
      const L = this.st.ledger[p];
      if (!L) continue;
      const b = base?.[p] || { prl: 0, nock: 0, spend: 0, theo: 0, hours: 0 };
      const prl = L.prl.acc - b.prl, nock = L.nock.acc - b.nock, spend = L.spend - b.spend;
      const usdv = prl * (this.market.price || 0) + nock * (this.market.nockPrice || 0);
      out[p] = {
        prl, nock, usd: usdv, spend, theo: L.theo - b.theo, rigHours: L.hours - b.hours,
        profit: usdv - spend, roi: spend > 0.01 ? (usdv - spend) / spend * 100 : null,
        from: base ? base.t : L.since,
      };
    }
    return out;
  }

  // ---------- vast 账户与实例 ----------
  async refreshVast() {
    if (!this.vast.ok) { this.account.error = '未填写 vast API Key'; return; }
    try {
      const u = await this.vast.user();
      this.account.vastBalance = Number(u.credit ?? u.balance ?? 0);
      this.account.vastEmail = u.email || u.username || null;
      this.account.updatedAt = Date.now();
      this.account.error = null;
    } catch (e) {
      if (this.account.error !== e.message) this.log('error', `读取 vast 余额失败：${e.message}`);
      this.account.error = e.message;
    }
    try {
      this.rawInstances = await this.vast.instances();
      this.instancesOk = true;
      if (this.vastFailSince && Date.now() - this.vastFailSince > 3 * MIN) this.log('info', `vast 连接已恢复（中断了 ${Math.round((Date.now() - this.vastFailSince) / MIN)} 分钟）`);
      this.vastFailSince = null;
      for (const i of this.rawInstances) {
        const m = this.st.managed[String(i.id)];
        if (m && !m.runningAt && i.actual_status === 'running') { m.runningAt = Date.now(); this.save(); }
        // 用平台的实际 dph_total 校正托管记录：搜索页的 dph 有时是"当前竞价价"而不是成交的按需价
        // （实测 3090：日志写 $0.0865，真实扣费 $0.1533 —— 不校正的话 ROI/止损全按错价算）
        if (m && Number(i.dph_total) > 0) {
          // 核价：先用「GPU 单价 + 存储」算出预期总价，再和平台实际扣费比。
          // 动作不挂阈值，而是"记差异 → 账本按实际价 → ROI/止损决定去留"（复盘意见）：
          // 15% 的固定阈值在 20% 目标 ROI 下只剩 5% 利润，再乘 realizedFactor 就是负的。
          const base = Number(i.dph_base) > 0 ? Number(i.dph_base) : Number(i.dph_total);
          const now = Number(i.dph_total);
          const storageHr = (Number(i.storage_cost) || 0) * (Number(this.cfg.disk) || 10) / 730;
          // 核价基准必须跟上「我们自己出过的价」：被顶时 tryRaiseBid 抬价是主动保活，
          // 抬完到平台把 dph_base 补齐之间有一段窗口，此时若拿旧下单价当基准，
          // 就会把这次抬价判成「平台改价」（实例 57935994 被顶到 $0.1439 后就是这么被旧规则判死的）。
          // 用 max(平台 GPU 单价, 自己出过的价)：自己抬的价不算平台改价，平台真涨过我们的出价照样报。
          const selfBid = Number(m.bid) || 0;
          const refBase = Math.max(base, selfBid);
          const expected = refBase + storageHr;
          const prev = Number(m.dph) || 0;
          if (prev && Math.abs(now - prev) / Math.max(now, prev) > 0.05) m.dphListed = prev;
          m.dph = now; m.dphBase = refBase;
          if (expected > 0 && now / expected - 1 > 0.05) {
            m.priceDeviationPct = +((now / expected - 1) * 100).toFixed(1);
            this.log('warn', `实例 ${i.id} 实际扣费 $${now.toFixed(4)}/h 比预期 $${expected.toFixed(4)}（GPU $${refBase.toFixed(4)}${selfBid > base ? '（含自己抬价）' : ''}+存储 $${storageHr.toFixed(4)}）高 ${m.priceDeviationPct}%，按实际价计 ROI，由止损决定去留`);
          } else if (m.priceDeviationPct) {
            delete m.priceDeviationPct;
          }
          // 台账：实付价、出价轨迹、五个时间戳都在这里补齐
          {
            const l = this.leaseOf(i.id, m, i);
            l.dphBaseActual = refBase;
            l.dphTotalActual = now;
            l.bidFinal = Number(m.bid) || l.bidFinal;
            l.raises = (m.bidRaises || []).length;
            l.geo ||= i.geolocation || '';
            l.hostId ??= i.host_id ?? m.hostId ?? null;
            // 搜索接口不返回 host_id：租过一次就记住，下次评估这台机器时能用房东口径的 L1
            if (l.hostId != null && m.machineId != null) (this.st.machineHost ||= {})[String(m.machineId)] = l.hostId;
            if (String(i.actual_status) === 'running' && !l.tRunning) l.tRunning = Date.now();
            const lh = this.localHsOf(i.id);
            if (lh) {
              l.lastHs = lh;
              l.localThAvg = l.localThAvg ? +(l.localThAvg * 0.7 + (lh / 1e12) * 0.3).toFixed(2) : +(lh / 1e12).toFixed(2);
              // 矿工已经报出算力 = 矿工起来了（和「矿池开始计酬」是两件事，分开记）
              l.tMinerUp ||= Date.now();
            }
            // L1 样本：累计份额反推算力 ÷ 矿工自报（至少跑 10 分钟才采，避免爬坡污染）
            {
              const secs = l.tFirstShare ? (Date.now() - l.tFirstShare) / 1000 : 0;
              if (secs > 600 && l.sharesAccepted > 0 && Number(l.difficulty) > 0 && Number(l.lastHs) > 0) {
                const derived = l.sharesAccepted * Number(l.difficulty) * 4294967296 / secs;
                this.recordL1(m.gpuName, derived / Number(l.lastHs), l.hostId ?? i.host_id ?? null);
              }
            }
            const sh = this.sharesOf(i.id);
            if (sh) {
              l.sharesAccepted = Math.max(l.sharesAccepted || 0, sh.accepted || 0);
              l.sharesRejected = Math.max(l.sharesRejected || 0, sh.rejected || 0);
              if (Number(sh.difficulty) > 0) l.difficulty = Number(sh.difficulty);
              if (sh.accepted > 0) l.tFirstShare ||= Date.now();
            }
            if (m.hashAt && !l.tFirstShare) l.tFirstShare = m.hashAt;
            // 矿池已经报到算力 = 矿工一定已经起来了（日志还没抓到时的兜底）
            if (m.hashAt && !l.tMinerUp) l.tMinerUp = m.hashAt;
            l.pool = m.pool || l.pool || null;
          }
          this.save();
        }
        // spot 的真实状态元组每次变化都记一条（真机语义待验证，见 docs/contracts.md §8）
        if (m?.spot) this.noteSpotStatus(i, m);
      }
      // 已不存在的托管实例清理掉
      const ids = new Set(this.rawInstances.map(i => String(i.id)));
      for (const id of Object.keys(this.st.managed)) {
        if (!ids.has(id) && Date.now() - this.st.managed[id].rentedAt > 3 * MIN) {
          this.log('warn', `实例 ${id} 已不在 vast 列表中（可能被手动销毁或被平台回收）`);
          this.closeLeaseFor(id, { reason: '已不在 vast 列表中（平台侧已回收）' });
          delete this.st.managed[id]; this.save();
        }
      }
    } catch (e) {
      this.instancesOk = false;
      this.vastFailSince ||= Date.now();
      this._warnOnce('instfail', `读取实例列表失败：${e.message}（连不上 vast 期间止损和自动退租暂停）`);
    }
  }

  // spot 实例的真实状态语义还没在真机上验证过：每次元组变化记一条，
  // M1.5 跑完就能用真实数据收紧 preempted 的判定（而不是靠猜 vast 会返回什么）。
  noteSpotStatus(i, m) {
    const tuple = [i.intended_status, i.actual_status, i.cur_state, i.next_state, i.is_bid].join('|');
    if (m.spotStatus === tuple) return;
    m.spotStatus = tuple;
    this.save();
    const msg = String(i.status_msg || '').slice(0, 80);
    this.log('info', `spot 状态变化 实例 ${i.id}：intended=${i.intended_status} actual=${i.actual_status} cur=${i.cur_state ?? '-'} next=${i.next_state ?? '-'} bid=${i.is_bid ?? '-'}${msg ? ' msg=' + msg : ''}`);
  }

  // 这台机器「应该」挖哪个池（标签/记录），以及「实际」在哪个池出算力
  rigPool(i) {
    const id = String(i.id);
    const m = this.st.managed[id];
    const want = m?.pool || labelPool(i.label) || 'pearlhash';
    const name = this.st.aliases[id] || workerName(id);
    const ph = this.workers.get(name) || null;
    let kw = this.kx.workers.get(name) || null;
    // Kryptex 只给 30 分钟平均算力：刚连上 t 分钟时，均值只有真实算力的 t/30，按连接时长换算回来
    // （上限 = 预期算力 × 1.3，防止断线重连后 opened_at 重置导致高估）
    if (kw?.live && kw.openedAt) {
      const age = (Date.now() - kw.openedAt) / MIN;
      if (age < 30) {
        const ref = this.thFor(i.gpu_name);
        const exp = ref ? ref.effective * 1e12 * (i.num_gpus || 1) : 0;
        let est = kw.hs30 * 30 / Math.max(age, 1);
        if (exp > 0) est = Math.min(est, exp * 1.3);
        kw = { ...kw, hs: est, est: true, warmMin: age };
      }
    }
    const on = { pearlhash: !!(ph && ph.hs > 0), kryptex: !!(kw && kw.live) };
    const actual = on[want] ? want : on.pearlhash ? 'pearlhash' : on.kryptex ? 'kryptex' : want;
    return { want, actual, w: actual === 'kryptex' ? kw : ph, on, kw };
  }
  workerFor(id) {
    const i = this.rawInstances.find(x => String(x.id) === String(id)) || { id };
    return this.rigPool(i).w;
  }
  // 能不能切矿池：新版开机脚本（v2）租的机器，且脚本里带了目标矿池的参数
  switchablePools(i) {
    const m = this.st.managed[String(i.id)];
    if (m?.sv >= 3) return m.pools || [];
    // 脚本版本 2 挖 Kryptex 用的是 WildRig，实测交不出份额，这些机器只能留在 Pearlhash
    if (m?.sv === 2) return (m.pools || []).filter(p => p !== 'kryptex');
    return labelPool(i.label) ? ['pearlhash'] : [];
  }

  recordSamples() {
    const now = Date.now();
    for (const i of this.rawInstances) {
      const rp = this.rigPool(i);
      if (!this.poolDataOk(rp.actual)) continue; // 这个矿池的数据拉不到，不记 0，免得误判掉线
      const w = rp.w;
      const key = String(i.id);
      const arr = this.samples.get(key) || [];
      arr.push({ t: now, hs: w ? w.hs : 0 });
      while (arr.length && now - arr[0].t > 60 * MIN) arr.shift(); // 保留 1 小时，用于面板算力曲线
      this.samples.set(key, arr);
      const m = this.st.managed[String(i.id)];
      // 记下「从什么时候开始在这个池出算力」，切池后算力窗口、止损都从这里重新算
      if (m && w && w.hs > 0 && m.onPool !== rp.actual) {
        if (m.onPool) m.poolSince = now;
        m.onPool = rp.actual; this.save();
      }
      if (w && w.hs > 0) {
        this.everHashed.add(String(i.id));
        // 清抢占计时必须同时满足：①实例本身在跑（ACTIVE）②矿池有算力。
        // 只看矿池会踩坑：矿池算力是 5~30 分钟均值，实例被收回后仍会返回旧算力，
        // 于是每轮采样都把 preemptedAt 清掉 → 5 分钟销毁永远不触发
        // （实测 57826209 被收回后闲置 32 分钟、重置 3 次）。
        if (m?.preemptedAt && ACTIVE.has(i.actual_status)) { delete m.preemptedAt; this.save(); }
        if (m && !m.hashAt) this.recordDeploy(String(i.id), m, i);
      }
    }
  }

  recordDeploy(id, m, inst) {
    const now = Date.now();
    m.hashAt = now;
    const total = (now - m.rentedAt) / 1000;
    const pull = m.runningAt ? (m.runningAt - m.rentedAt) / 1000 : null;
    const miner = m.runningAt ? (now - m.runningAt) / 1000 : null;
    this.st.deployStats ||= [];
    this.st.deployStats.push({ t: now, id, gpu: inst.gpu_name, geo: inst.geolocation || '', inetDown: m.inetDown ?? inst.inet_down ?? null, total, pull, miner });
    if (this.st.deployStats.length > 50) this.st.deployStats.splice(0, this.st.deployStats.length - 50);
    this.save();
    const f = s => s == null ? '?' : `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
    this.log('success', `实例 ${id}（${inst.num_gpus}×${inst.gpu_name}）开始出算力，部署用时 ${f(total)}（拉镜像+开机 ${f(pull)} · 下载启动矿工 ${f(miner)}）`);
  }

  deployAverage() {
    const d = (this.st.deployStats || []).slice(-20);
    if (!d.length) return null;
    const avg = k => { const v = d.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return { n: d.length, total: avg('total'), pull: avg('pull'), miner: avg('miner'), slowest: Math.max(...d.map(x => x.total)) };
  }

  // 算力健康检查：实测 vs 预期（单卡参考/实测值 × 卡数），以及逐张卡检查
  hashHealth({ w, arr, numGpus, perGpuHs, now, sinceHashMin, phase, pool = 'pearlhash' }) {
    const lowPct = this.cfg.hashLowPct / 100;
    if (!['mining', 'loss'].includes(phase)) return { health: null, healthMsg: '' };
    if (!perGpuHs) return { health: null, healthMsg: '未知型号，无法判断算力是否正常' };
    if (sinceHashMin < 3) return { health: null, healthMsg: '刚开始挖，算力爬升中' };
    const recent = arr.filter(s => now - s.t <= 5 * MIN && s.hs > 0);
    const hs5 = recent.length ? recent.reduce((a, s) => a + s.hs, 0) / recent.length : (w?.hs || 0);
    const expected = perGpuHs * numGpus;
    const ratio = expected > 0 ? hs5 / expected : null;
    // Kryptex 只有矿池估算的 30 分钟均值、没有逐卡数据：刚切过去时均值偏低，30 分钟内不判断
    if (!POOLS[pool]?.perGpu) {
      if (sinceHashMin < KX_WARMUP_MIN) return { health: null, ratio, hs5, gpus: [], healthMsg: `${poolName(pool)} 30 分钟均值爬升中` };
      if (ratio !== null && ratio < lowPct) return { health: 'low', ratio, hs5, gpus: [], healthMsg: `算力只有预期的 ${Math.round(ratio * 100)}%（${poolName(pool)} 30 分钟均值）` };
      return { health: 'ok', ratio, hs5, gpus: [], healthMsg: '' };
    }
    const gpus = (w?.gpus || []).map(g => ({ name: g.name, hs: g.hs, ratio: g.hs / perGpuHs, ok: g.hs >= perGpuHs * lowPct }));
    const badGpus = gpus.filter(g => !g.ok).length;
    const missing = Math.max(0, numGpus - gpus.length);
    if (missing > 0) return { health: 'gpu', ratio, hs5, gpus, healthMsg: `只有 ${gpus.length}/${numGpus} 张卡在挖` };
    if (badGpus > 0 && numGpus > 1) return { health: 'gpu', ratio, hs5, gpus, healthMsg: `${badGpus} 张卡算力偏低` };
    if (ratio !== null && ratio < lowPct) return { health: 'low', ratio, hs5, gpus, healthMsg: `算力只有预期的 ${Math.round(ratio * 100)}%` };
    return { health: 'ok', ratio, hs5, gpus, healthMsg: '' };
  }

  // 台账里的份额与本地算力只能从矿工日志里取，而脚本 v6+ 每 5 分钟才打一行 stats——
  // 所以这里按同样节奏取一次日志。不取的话租约记录里 shares_accepted / local_th_avg 永远是空，
  // 型号排名就只能靠「有没有出算力」这种粗指标。
  async pollStats(list, now = Date.now()) {
    for (const x of list) {
      if (!['mining', 'loss'].includes(x.phase)) continue;
      const m = this.st.managed[x.id];
      if (!m) continue;
      if ((m.sv || x.scriptVer || 0) < 6) continue;
      if (now - (m.lastLogAt || 0) < 5 * MIN) continue;
      m.lastLogAt = now;
      this.save();
      await this.fetchLogs(x.id, false).catch(() => {});
    }
  }

  // 房东维度的收回统计：同一房东短时间内收回多台，是比"型号"更强的信号。
  // 一条回收/一次维护就能带走 2~3 台，把它当成"三次独立事件"会让型号排名全被噪声污染。
  // 规则（用户 2026-10-27 约定）：同一房东 1 小时内收回 ≥2 台 → 该房东已知机器全部拉黑 24h。
  recordHostReclaim(lease, inst) {
    const host = lease?.hostId ?? inst?.host_id ?? null;
    if (host == null) return null;
    const now = Date.now();
    const st = this.st.hostStats ||= {};
    const rec = st[host] ||= { reclaims: [], machines: [], blacklistedUntil: 0 };
    rec.reclaims = (rec.reclaims || []).filter(t => now - t < 60 * MIN);
    rec.reclaims.push(now);
    const machines = new Set((rec.machines || []).filter(Boolean));
    for (const l of this.leases) if (String(l.hostId) === String(host) && l.machineId != null) machines.add(l.machineId);
    if (lease?.machineId != null) machines.add(lease.machineId);
    if (inst?.machine_id != null) machines.add(inst.machine_id);
    rec.machines = [...machines];
    if (rec.reclaims.length >= 2 && !(rec.blacklistedUntil > now)) {
      rec.blacklistedUntil = now + 24 * 60 * MIN;
      for (const id of rec.machines) this.st.blacklist[id] = { until: rec.blacklistedUntil, reason: `同一房东 ${host} 1 小时内收回 ${rec.reclaims.length} 台` };
      this.log('warn', `房东 ${host} 1 小时内收回 ${rec.reclaims.length} 台，已把该房东已知的 ${rec.machines.length} 台机器拉黑 24h（同批收回按一次事件处理）`);
    }
    this.save();
    return rec;
  }

  // ---------- 租约台账 ----------
  // 一台机器一条记录，从租下跟到销毁。refreshVast 每轮补字段，destroy 时定终局。
  trimLeases() {
    const KEEP = 800;
    if (this.leases.length > KEEP) this.leases.splice(0, this.leases.length - KEEP);
  }

  leaseOf(id, m, inst) {
    id = String(id);
    let l = this.leases.find(x => x.id === id && !x.tEnd);
    if (!l) {
      l = newLease(id, m || this.st.managed[id] || {}, inst || {});
      this.leases.push(l);
      this.trimLeases();
    }
    return l;
  }

  leaseFor(id) {
    id = String(id);
    for (let i = this.leases.length - 1; i >= 0; i--) if (this.leases[i].id === id && !this.leases[i].tEnd) return this.leases[i];
    return null;
  }

  closeLeaseFor(id, { reason = '', now = Date.now(), preemptKind = null, opponentRatio = null } = {}) {
    const l = this.leaseFor(id);
    if (!l) return null;
    closeLease(l, {
      endReason: endReasonOf(reason),
      now,
      priceUsd: this.market.price || 0,
      preemptKind: l.preemptKind || preemptKind,
      opponentRatio: l.opponentRatio ?? opponentRatio,
    });
    // 从来没出过份额 → 这笔租金算"失败成本"（每日封顶的对象）
    if (!l.tFirstShare) {
      const h = Math.max(0, (l.tEnd - l.tRent) / 3_600_000);
      this.addFailSpend((Number(l.dphTotalActual ?? l.bidFinal ?? 0) || 0) * h);
    }
    this.save();
    return l;
  }

  // 被顶时的对手价位：用同一台机器在扫描结果里的 min_bid ≈ 现在的竞价地板。
  // 拿它和我们的出价比，才能验证「24GB 卡被 AI 租户抢」到底是机制还是猜测。
  opponentInfo(x, m) {
    const mid = Number(m?.machineId) || null;
    const offer = mid ? (this.offers || []).find(o => Number(o.machineId) === mid) : null;
    const minBid = Number(offer?.minBid ?? x?.minBid ?? 0) || null;
    const ourBid = Number(m?.bid ?? x?.dph ?? 0) || null;
    const kind = preemptKindOf({ statusMsg: x?.statusMsg || '', minBid, ourBid });
    const ratio = minBid && ourBid ? +(minBid / ourBid).toFixed(3) : null;
    return { minBid, ourBid, ratio, kind };
  }

  leaseReport() {
    return summarize(this.leases, { priceUsd: this.market.price || 0 });
  }

  // 矿池到账分摊。三条硬约束（2026-10-27 复核指出，前两条会让排名偏向长寿机器）：
  //   ① 权重必须是「本轮增量份额」而不是累计值 —— 用累计值的话，每笔到账老机器都拿大头；
  //   ② 分摊对象要包含「刚结束」的租约 —— 入账有滞后（Kryptex unconfirmed 几分钟到几十分钟，
  //      Pearlhash 按小时结算），一台跑 40 分钟就被收回的机器，它的币是死后才到账的；
  //   ③ 份额数跨机器不可比（Kryptex vardiff），权重用 Δaccepted × difficulty = 工作量。
  // 缺份额数据（v8 之前的脚本 stats 被日志截断）时退回瞬时算力比例，并如实标注 creditedSrc。
  allocateCredit(pool, deltaPrl) {
    if (!(deltaPrl > 0)) return;
    const now = Date.now();
    const windowMin = pool === 'pearlhash' ? 90 : 60;
    const cand = this.leases.filter(l => l.pool === pool && (!l.tEnd || now - l.tEnd <= windowMin * MIN));
    if (!cand.length) return;
    const deltaOf = l => Math.max(0, (Number(l.sharesAccepted) || 0) - (Number(l.sharesMark) || 0));
    const workOf = l => deltaOf(l) * (Number(l.difficulty) || 1);
    let total = cand.reduce((a, l) => a + workOf(l), 0);
    const useShares = total > 0;
    if (!useShares) total = cand.reduce((a, l) => a + (Number(l.lastHs) || 0), 0);
    if (!(total > 0)) return;
    const price = this.market.price || 0;
    for (const l of cand) {
      const w = useShares ? workOf(l) : (Number(l.lastHs) || 0);
      if (w > 0) l.creditedPrl = +((Number(l.creditedPrl) || 0) + deltaPrl * (w / total)).toFixed(8);
      l.creditedSrc = useShares ? 'share_alloc' : 'pool_alloc';
      if (useShares) l.sharesMark = Number(l.sharesAccepted) || 0;
      // 结束后的到账也要回写到 netUsd，否则台账里的净收益永远差最后一笔
      if (l.tEnd) l.netUsd = netUsdOf(l, { priceUsd: price });
    }
    this.save();
  }

  // 从矿工日志里抠出「GPU 本地算力」：矿池口径是按份额换算的，PPS+ 下拿它当分母会变成同义反复。
  // 日志里 SRBMiner/WildRig 都会打 "Hashrate  136.89 TH/s"，取最后一条即可。
  localHsOf(id) {
    const v = this.rigLogs.get(String(id));
    if (!v?.text) return null;
    const m = [...v.text.matchAll(/Hashrate\s+([\d.]+)\s*([TGM]?)H\/s/gi)];
    if (!m.length) return null;
    const last = m[m.length - 1];
    const n = Number(last[1]);
    const mult = { T: 1e12, G: 1e9, M: 1e6, '': 1 }[String(last[2] || '').toUpperCase()] || 1;
    return Number.isFinite(n) && n > 0 ? n * mult : null;
  }

  // 从 stats 日志里取份额计数：这个比矿池均值可靠（矿池 30 分钟均值会把爬坡期算进去）
  sharesOf(id) {
    const v = this.rigLogs.get(String(id));
    if (!v?.text) return null;
    // v8 的 stats 行只挑字段，键名两边的引号可能只剩半边（accepted":14），
    // 所以引号必须是可选的，否则新脚本采到的份额一个都读不出来。
    const acc = [...v.text.matchAll(/"?accepted"?\s*:\s*(\d+)/g)];
    const rej = [...v.text.matchAll(/"?rejected"?\s*:\s*(\d+)/g)];
    const dif = [...v.text.matchAll(/"?difficulty"?\s*:\s*([\d.]+)/g)];
    if (!acc.length && !rej.length) return null;
    const last = a => (a.length ? Number(a[a.length - 1][1]) : 0);
    // difficulty 是 vardiff 的分母：Kryptex 给每个 worker 单独调难度，
    // 单纯比 accepted 个数会把「高难度少量份额」和「低难度大量份额」算成不等价。
    return { accepted: last(acc), rejected: last(rej), difficulty: last(dif) || null };
  }

  // 阈值的作用域：实验参数只对 pinned 实验机生效，绝不外溢到自动租用。
  // 没有这条时，实验用的 targetProfitPct=-50 / stopLossPct=-90 是全局的，
  // 于是 autoRent 用实验门槛去租生产机（3060 Ti 以 −48.5% 进场就是这么来的），
  // 而止损又因为 −90% 永远不触发——两头都错。
  limitsFor(x) {
    const base = {
      targetProfitPct: Number(this.cfg.targetProfitPct),
      stopLossPct: Number(this.cfg.stopLossPct),
      stopLossMinutes: Number(this.cfg.stopLossMinutes),
      hashLowPct: Number(this.cfg.hashLowPct),
      pinned: !!x?.pinned,
      fromOverride: false,
      skipRoi: false,
    };
    if (!x?.pinned) return base;
    const o = this.cfg.expOverride;
    if (!o || typeof o !== 'object') {
      // pinned 但没有覆盖：维持老语义——测量锚点不做 ROI/算力淘汰
      return { ...base, skipRoi: true };
    }
    const pick = (k) => (Number.isFinite(Number(o[k])) ? Number(o[k]) : base[k]);
    return { ...base, targetProfitPct: pick('targetProfitPct'), stopLossPct: pick('stopLossPct'), stopLossMinutes: pick('stopLossMinutes'), hashLowPct: pick('hashLowPct'), fromOverride: true };
  }

  // 把 vast 实例 + 矿池算力 + 行情 合成面板要的数据
  instances() {
    const now = Date.now();
    return this.rawInstances.map(i => {
      const id = String(i.id);
      const m = this.st.managed[id];
      const managed = !!m || String(i.label || '').startsWith(LABEL);
      const ref = this.thFor(i.gpu_name);
      const numGpus = i.num_gpus || 1;
      // 预期算力用最新的参考值（租过的型号会被实测值替换），比租用时记下的更准
      const perGpuHs = ref ? ref.effective * 1e12 : (m?.expectedTh ? m.expectedTh / numGpus * 1e12 : 0);
      const expectedHs = perGpuHs * numGpus;
      const rp = this.rigPool(i);
      const w = rp.w;
      const usd = this.usdHsHrFor(rp.actual);
      const arr = this.samples.get(String(i.id)) || [];
      const restartAt = this.st.restarts?.[id] || 0;
      const sinceRestart = (now - restartAt) / MIN;
      const restarting = restartAt > 0 && sinceRestart < this.cfg.bootTimeoutMinutes && !arr.some(s => s.t > restartAt && s.hs > 0);
      const sw = m?.sw || null;
      // 重启或换矿池之后，之前的样本不再代表现在的状态
      const resetAt = Math.max(restartAt, m?.poolSince || 0);
      // 10 分钟均值；刚出算力时只从第一次有算力的样本开始算，不把部署阶段的 0 算进去
      let win = arr.filter(s => now - s.t <= 10 * MIN && s.t > resetAt); // 重启/换池前的样本不算
      const first = win.findIndex(s => s.hs > 0);
      win = first >= 0 ? win.slice(first) : win;
      const avgHs = win.length ? win.reduce((a, s) => a + s.hs, 0) / win.length : (w && !restarting ? w.hs : 0);
      // 出过算力的机器（记录里有出算力时间）不再算「部署中」：程序重启后内存里的记录丢了也一样
      const everSeen = !!m?.hashAt || this.everHashed.has(id) || arr.some(s => s.hs > 0) || (w ? w.hs > 0 : false);
      // 首次出算力时间：内存样本只能覆盖本次进程启动之后。重启后样本清空 → firstHashAt 变 null，
      // 而低算力/止损两条规则都靠它算「跑了多久」，于是每重启一次就要重新等 30 分钟预热。
      // m.hashAt 是落盘的，样本没了就用它兜底。
      const firstHashAt = arr.find(s => s.hs > 0 && s.t > resetAt)?.t ?? (m?.hashAt ?? null);
      const dph = Number(i.dph_total) || 0;
      const startedAt = (m?.rentedAt) || (i.start_date ? i.start_date * 1000 : now);
      const ageMin = (now - startedAt) / MIN;
      // 部署超时从「租下」或「最近一次重启」中较晚的那个开始算
      const bootAgeMin = (now - Math.max(startedAt, restartAt)) / MIN;
      const useHs = avgHs > 0 ? avgHs : 0;
      const revenueHr = useHs * usd;
      const expRevenueHr = expectedHs * usd;
      const roi = dph > 0 && useHs > 0 ? (revenueHr - dph) / dph * 100 : null;
      const expRoi = dph > 0 && expectedHs > 0 ? (expRevenueHr - dph) / dph * 100 : null;
      let phase;
      if (sw) phase = 'switching';
      else if (restarting) phase = 'restarting';
      // 竞价被收回：spot 实例只要不在 ACTIVE 状态（stopped / exited / offline / …）就按「被平台收回」处理。
      // 不要求 everSeen —— 开机阶段（拉镜像/下载矿工）出价被顶掉是最常见的抢占时点；
      // 也不写死 actual_status === 'stopped' —— vast 的真实状态组合还没被真机验证过（见 noteSpotStatus）。
      // intended=stopped 也要算：本程序从不主动 stop 实例，出现这个组合就是平台停的（出价被顶）。
      // 实测这种实例 actual_status 还是 'created'（不是 stopped），只有 intended 变成 stopped。
      // 竞价被收回的判定，必须区分「平台真的收走了」和「刚创建时的状态噪音」：
      // 实测实例刚租下的几十秒内，vast 会短暂返回 intended=stopped / actual=loading，
      // 老规则据此判 preempted，5 分钟后把一台正在拉镜像的健康机器销毁了（57884732）。
      // 现在：① actual 处于终态（exited/stopped/offline/failed）→ 立刻算收回；
      //       ② intended=stopped 但还在 loading/created 等过渡态 → 只有租下超过 3 分钟才算。
      else if (m?.spot && (
        TERMINAL_STATUS.has(String(i.actual_status)) ||
        (i.intended_status === 'stopped' && String(i.actual_status) !== 'running'
          && Date.now() - (m.rentedAt || 0) > 3 * MIN)
      )) phase = 'preempted';
      else if (!ACTIVE.has(i.actual_status) && i.actual_status) phase = i.intended_status === 'stopped' ? 'stopped' : 'offline';
      else if (!everSeen) phase = managed ? 'booting' : 'unmatched';
      else if (useHs === 0) phase = 'nohash';
      else if (roi !== null && roi < this.limitsFor({ pinned: m?.pinned, id }).stopLossPct) phase = 'loss';
      else phase = 'mining';
      const sinceHashMin = firstHashAt ? (now - firstHashAt) / MIN : 0;
      const hh = this.hashHealth({ w, arr, numGpus, perGpuHs, now, sinceHashMin, phase, pool: rp.actual });
      // 面板曲线：最近 60 分钟，单位 TH/s
      const series = arr.map(s => [Math.round((s.t - now) / 1000), +(s.hs / 1e12).toFixed(2)]);
      return {
        perGpuHs, restartAt: restartAt || null, bootAgeMin,
        health: hh.health, healthMsg: hh.healthMsg, hashRatio: hh.ratio ?? null, hs5: hh.hs5 ?? null,
        gpus: hh.gpus || (w?.gpus || []).map(g => ({ name: g.name, hs: g.hs, ratio: perGpuHs ? g.hs / perGpuHs : null, ok: true })),
        pool: rp.actual, wantPool: rp.want, onPools: rp.on, switchable: this.switchablePools(i), scriptVer: m?.sv || null, launchMode: m?.mode || null,
        hsEstimated: !!(rp.actual === 'kryptex' && rp.kw?.est),
        switching: sw ? { from: sw.from, to: sw.to, at: sw.at, auto: !!sw.auto, reason: sw.reason || '' } : null,
        failoverFrom: m?.failoverFrom || null, poolSince: m?.poolSince || null,
        series,
        id, managed, label: i.label || '', gpuName: i.gpu_name, numGpus, dph,
        status: i.actual_status || 'unknown', statusMsg: (i.status_msg || '').slice(0, 160),
        geolocation: i.geolocation || '', machineId: i.machine_id, ip: i.public_ipaddr || '',
        gpuUtil: i.gpu_util ?? null, gpuTemp: i.gpu_temp ?? null,
        startedAt, ageMin, worker: this.st.aliases[id] || workerName(id),
        liveHs: w && !restarting ? w.hs : 0, avgHs, expectedHs, firstHashAt, revenueHr, expRevenueHr, roi, expRoi, phase,
        belowSince: m?.belowSince || null, refSource: ref?.source || '未知型号',
        // 竞价/按需必须暴露给面板与策略脚本：缺了它，swap-policy 会把竞价机当成按需机
        spot: !!m?.spot, listDph: m?.listDph ?? null, pinned: !!m?.pinned, minBid: Number(i.min_bid) || 0,
        // 本地算力（矿工自报）与「按本地算力算的 ROI」：判断"租来的算力有多少真的变成了钱"
        localHs: this.localHsOf(id),
        localRoi: (() => {
          const lh = this.localHsOf(id);
          const rev = lh ? lh * this.usdHsHrFor(rp.actual) : 0;
          return rev > 0 && dph > 0 ? (rev - dph) / dph * 100 : null;
        })(),
        deploy: m ? { rentedAt: m.rentedAt, runningAt: m.runningAt || null, hashAt: m.hashAt || null, inetDown: m.inetDown ?? i.inet_down ?? null } : null,
        logHint: this.logHint(id),
      };
    });
  }

  // ---------- 市场扫描 ----------
  // ---------- 扫描调度（vast 每日搜索额度按返回条数计，UTC 0 点重置） ----------
  utcDay(t = Date.now()) { return new Date(t).toISOString().slice(0, 10); }
  nextUtcMidnight(t = Date.now()) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
  usageToday() {
    const day = this.utcDay();
    let u = this.st.searchUsage;
    if (!u || u.day !== day) u = this.st.searchUsage = { day, requests: 0, rows: 0, exhaustedAt: null };
    // 分桶上线前的历史用量全部算进巡航桶（保守：不虚报窗口余量）
    if (u.cruiseRows == null && u.windowRows == null) { u.cruiseRows = u.rows || 0; u.windowRows = 0; }
    u.cruiseRows ||= 0; u.windowRows ||= 0;
    return u;
  }

  // 额度分桶：40% 巡航、60% 锁给窗口。额度只有 ~331 次/天，而窗口通常出现在
  // 亚洲/美国盘交叠的几小时——固定节奏会把额度在无窗口时段烧光，窗口来了没子弹。
  quotaBuckets(now = Date.now()) {
    const est = Number(this.st.quotaEst) || 0;
    const u = this.usageToday(now);
    const cruiseBudget = Math.floor(est * 0.4);
    const windowBudget = Math.floor(est * 0.6);
    const cruiseRows = Number(u.cruiseRows) || 0;
    const windowRows = Number(u.windowRows) || 0;
    const lastQuota = this.st.lastQuota || {};
    const totalLeft = Number.isFinite(Number(lastQuota.remaining)) ? Number(lastQuota.remaining) : null;
    let cruiseLeft = Math.max(0, cruiseBudget - cruiseRows);
    let windowLeft = Math.max(0, windowBudget - windowRows);
    // vast 响应头是"真实剩余"的唯一来源：一旦它比我们的记账更小，两边一起夹住
    if (totalLeft != null) { cruiseLeft = Math.min(cruiseLeft, totalLeft); windowLeft = Math.min(windowLeft, totalLeft); }
    return { est, cruiseBudget, windowBudget, cruiseRows, windowRows, cruiseLeft, windowLeft, totalLeft };
  }

  // 当前应该隔多久扫一次（毫秒）以及原因
  scanPlan() {
    const now = Date.now();
    // 基础间隔取「用户设定」与「额度可持续间隔」的较大者：额度只有 ~331 次/天，
    // 90 秒扫一次会在下午就烧穿（2026-10-28 实测）。
    const sus = this.sustainableScanSec();
    const base = Math.max(Number(this.cfg.scanIntervalSec) || 90, sus) * 1000;
    const rows = this.cfg.scanRows;
    if (!this.cfg.autoRent) return { interval: Math.max(base, 15 * MIN), why: '自动租用未开，15 分钟看一次行情' };
    // 已到台数 / 预算上限：扫了也租不了，不浪费额度
    if (this.instancesOk) {
      const b = this.budget(this.instances());
      if (b.roomCount <= 0) return { skip: true, why: `已租满 ${this.cfg.maxInstances} 台，暂停扫描` };
      if (b.roomSpend < 0.02) return { skip: true, why: '已到每小时花费上限，暂停扫描' };
      if (b.roomBalance <= 0) return { skip: true, why: '余额低于保留金额，暂停扫描' };
      if (b.spendCapByRunway != null && b.spend + 0.02 >= b.spendCapByRunway) return { skip: true, why: '余额不够续航，暂停扫描' };
    }
    const msLeft = this.nextUtcMidnight() - now;
    const bk = this.quotaBuckets(now);
    const winActive = !!this.st.windowState?.active;
    // 窗口期：用窗口桶，60 秒一次、100 行（把额度花在刀刃上）
    // 窗口期可以用窗口桶；窗口桶空了但巡航还有余量 → 允许单向借用（否则会出现"窗口有余额、巡航归零"的死角）
    const winLeft = bk.windowLeft > 0 ? bk.windowLeft : bk.cruiseLeft;
    if (winActive && winLeft > 0) {
      const rowsWin = Math.min(100, Math.max(30, Number(this.cfg.windowScanRows) || 100), winLeft);
      return { interval: 60_000, rows: rowsWin, bucket: bk.windowLeft > 0 ? 'window' : 'cruise-borrow',
        why: `窗口期扫描：${bk.windowLeft > 0 ? `窗口桶剩 ${bk.windowLeft} 行` : `窗口桶为空，借巡航桶 ${bk.cruiseLeft} 行`}` };
    }
    // 巡航：只用巡航桶，间隔 = 剩余时间 ÷ 剩余次数，最少 10 分钟
    const rowsCruise = Math.min(Number(this.cfg.cruiseScanRows) || 30, Math.max(20, Number(this.cfg.scanRows) || 30));
    const cruiseLeft = bk.est > 0 ? bk.cruiseLeft : Math.max(0, 24 * 3600 / 600 * rowsCruise); // 没学到额度时按 10 分钟一次估
    const scansLeft = Math.max(0, Math.floor(cruiseLeft / rowsCruise));
    if (bk.est > 0 && scansLeft <= 0) {
      return { interval: Math.max(msLeft, 10 * MIN), rows: rowsCruise, bucket: 'cruise', why: `巡航额度已用完（窗口桶还剩 ${bk.windowLeft} 行），只等窗口` };
    }
    const pace = scansLeft > 0 ? msLeft / scansLeft : msLeft;
    return { interval: Math.max(10 * MIN, base, pace), rows: rowsCruise, bucket: 'cruise',
      why: `巡航桶剩 ${bk.cruiseLeft} 行 / 窗口桶剩 ${bk.windowLeft} 行，约每 ${Math.round(Math.max(10 * MIN, pace) / 60000)} 分钟一次` };
  }

  async scanTick() {
    if (!this.vast.ok) return;
    const now = Date.now();
    if (now < this.scanPausedUntil) return;
    const plan = this.scanPlan();
    this.offerStats.plan = plan.why || '';
    this.offerStats.nextScanAt = plan.skip ? null : (this.lastScanAttempt || 0) + plan.interval;
    if (plan.skip) return;
    if (now - (this.lastScanAttempt || 0) < plan.interval) return;
    this._scanRows = plan.rows || this.cfg.scanRows;
    this._scanBucket = plan.bucket || 'cruise';
    await this.scan();
  }

  async scan(force = false) {
    if (!this.vast.ok) return;
    if (Date.now() < this.scanPausedUntil) {
      if (force && this.pauseReason === 'quota') throw new Error(`vast 今日搜索额度已用完，${new Date(this.scanPausedUntil).toLocaleString('zh-CN', { hour12: false })} 恢复`);
      if (!force) return;
    }
    this.lastScanAttempt = Date.now();
    const meta = {};
    try {
      let sq = this.scanQuery();
      let raw;
      const scanCfg = { ...this.cfg, scanRows: this._scanRows || this.cfg.scanRows };
      try { raw = await this.vast.searchOffers(scanCfg, meta, sq.names); }
      catch (e) {
        // 万一 vast 不接受按型号过滤：本次改用全量搜索，之后不再用精准搜索
        if (sq.mode !== 'focused' || e.status === 429 || !(e.status >= 400 && e.status < 500)) throw e;
        this.focusedOff = true;
        this.log('warn', `vast 不接受按型号精准搜索（${e.message.slice(0, 80)}），改回全量搜索`);
        sq = { mode: 'broad' };
        raw = await this.vast.searchOffers(scanCfg, meta);
      }
      this.learnVastNames(raw);
      const u = this.usageToday();
      u.requests++; u.rows += raw.length;
      if (this._scanBucket === 'window') u.windowRows = (u.windowRows || 0) + raw.length;
      else u.cruiseRows = (u.cruiseRows || 0) + raw.length;   // cruise 与 cruise-borrow 都记巡航桶
      this.readQuotaHeaders(meta.headers);
      this.save();
      this.offerStats.error = null;
      this.evaluateOffers(raw);
      this.offerStats.mode = sq.mode === 'focused' ? `精准搜索 ${sq.models} 个型号` : '全量搜索';
    } catch (e) {
      this.offerStats.error = e.message;
      if (e.status === 429) {
        const quota = e.body?.error === 'search_quota_exceeded' || /quota/i.test(e.message);
        if (quota) {
          // 429 的响应头也带额度信息（remaining=0），这才是"vast 侧真实余量"，用它夹住分桶
          try { this.readQuotaHeaders(e.headers || {}); } catch {}
          const reset = Number(e.headers?.['x-ratelimit-reset']);
          const until = reset > 1e9 ? reset * 1000 : this.nextUtcMidnight();
          this.scanPausedUntil = until;
          this.pauseReason = 'quota';
          this.st.scanPause = { until, reason: 'quota' };
          const u = this.usageToday();
          if (!u.exhaustedAt) {
            u.exhaustedAt = Date.now();
            // 学习每日额度：今天用掉的条数（只在本程序是唯一使用者、且今天有记录时才有意义）
            if (u.rows > 0) { this.st.quotaEst = this.st.quotaEst ? Math.round(this.st.quotaEst * 0.5 + u.rows * 0.5) : u.rows; this.st.quotaEstSource = 'learned'; }
          }
          this.save();
          // 额度耗尽 ≠ 不能出价：下单走的是 /asks/，不吃搜索行数配额。
          // 用缓存报价按「当前币价 + 当前密度」重算一遍 roi/bid，窗口期照样能抢。
          if ((this.offers || []).length) {
            try { this.repriceOffers(); this.log('info', `额度已耗尽，改用缓存报价重算 ${this.offers.length} 条（下单不受搜索配额限制）`); } catch { /* 重算失败就维持旧值 */ }
          }
          this.log('warn', `vast 今日搜索额度已用完（今天本程序搜了 ${u.requests} 次、${u.rows} 条${this.st.quotaEst ? `，估计每日额度约 ${this.st.quotaEst} 条` : ''}），${new Date(until).toLocaleString('zh-CN', { hour12: false })} 恢复。已租机器照常监控`);
        } else {
          this.scanPausedUntil = Date.now() + 2 * MIN;
          this.pauseReason = 'rate';
          this._warnOnce('rate429', 'vast 提示请求太频繁，2 分钟后再扫描');
        }
      } else this.log('error', `扫描 vast 市场失败：${e.message}`);
    }
  }

  // 报价缓存落盘：offers 只在内存里的话，重启 + 额度耗尽 = 一整天无法出价
  // （2026-10-28 18:08 的窗口就是这么错过的：windowMode 修好了，但 offers 已被重启清空）。
  saveOffers() {
    const rows = (this.offers || []).slice(0, 80).map(o => ({
      id: o.id, machineId: o.machineId, gpuName: o.gpuName, numGpus: o.numGpus, dph: o.dph, listDph: o.listDph,
      minBid: o.minBid, spot: o.spot, reliability: o.reliability, geolocation: o.geolocation, inetDown: o.inetDown,
      cuda: o.cuda, source: o.source, autoOk: o.autoOk, l1: o.l1, hostId: o.hostId,
    }));
    if (!rows.length) return;
    this.st.offersCache = { at: Date.now(), rows };
  }

  loadOffers() {
    const c = this.st.offersCache;
    if (!c?.rows?.length) return 0;
    // 超过 12 小时的缓存不再用（机器早被租走/下架了）
    if (Date.now() - c.at > 12 * 3600e3) return 0;
    this.offers = c.rows.map(r => ({ ...r, bid: null, spotSkip: false, roi: null, stale: true }));
    try { this.repriceOffers(); } catch { /* 重算失败就保留空 roi */ }
    return this.offers.length;
  }

  // 精准搜索：只搜「有算力数据、按当前币价有可能达到目标收益率」的型号。
  // vast 的型号名要原样匹配，所以从全量搜索结果里学；每 6 次搜索做一次全量，发现新型号
  // 扫描的"可持续"间隔：每日额度 ÷ 每次行数 = 每日可用次数，再按 24h 均摊（留 20% 余量）。
  // 90 秒一扫等于每天 960 次，而额度只够 ~331 次 —— 2026-10-28 就是这么在下午烧穿、
  // 恰好错过 18:08 那个 +10% 窗口的。
  sustainableScanSec(now = Date.now()) {
    const est = Number(this.st.quotaEst) || 0;
    const rows = Math.max(1, Number(this.cfg.scanRows) || 60);
    if (!(est > 0)) return Number(this.cfg.scanIntervalSec) || 300;
    // 留 10% 余量，再扣掉最后一次（额度到顶前收手），然后按"剩余时间 ÷ 剩余次数"摊
    const perDay = Math.floor(est * 0.9 / rows) - 1;
    if (perDay < 1) return 24 * 3600;
    const remainingMs = Math.max(5 * MIN, this.nextUtcMidnight() - now);
    return Math.round(remainingMs / perDay / 1000);
  }

  scanQuery() {
    this.scanN = (this.scanN || 0) + 1;
    const usd = this.usdHsHr, names = this.st.vastNames || {};
    if (this.focusedOff || !(usd > 0) || !Object.keys(names).length || this.scanN % 6 === 1) return { mode: 'broad' };
    const t = this.cfg.targetProfitPct;
    const keys = this.table.filter(g => g.autoOk && g.effective * 1e12 * usd / (1 + t / 100) >= MIN_GPU_PRICE).map(g => g.key);
    const list = [...new Set(keys.flatMap(k => names[k] || []))].slice(0, 120);
    if (!list.length) return { mode: 'broad' };
    return { mode: 'focused', names: list, models: keys.filter(k => names[k]?.length).length };
  }
  learnVastNames(raw) {
    const names = this.st.vastNames ||= {};
    let changed = false;
    for (const o of raw) {
      const k = gpuKey(o.gpu_name);
      if (!k || !this.thFor(o.gpu_name)) continue;
      const arr = names[k] ||= [];
      if (!arr.includes(o.gpu_name)) { arr.push(o.gpu_name); changed = true; }
    }
    if (changed) this.save();
  }

  readQuotaHeaders(h) {
    if (!h) return;
    const pick = (...ks) => { for (const k of ks) if (h[k] != null && h[k] !== '') return Number(h[k]); return null; };
    const limit = pick('x-ratelimit-limit', 'x-ratelimit-limit-day', 'x-search-quota-limit');
    const remaining = pick('x-ratelimit-remaining', 'x-ratelimit-remaining-day', 'x-search-quota-remaining');
    if (remaining == null && limit == null) return;
    // 实测 vast 返回 limit=30、remaining=29，这是请求频率限制而不是每日条数额度，只记录不参与调度
    this.st.rateLimitHeaders = { limit, remaining, seenAt: Date.now() };
  }

  // 统一定价：spot 用「实际出价」、按需用挂牌价。出价上限已高于目标线的机器**保留**并标 spotSkip，
  // 否则同一台机器会在「扫描结果」和「每 20 秒重算」之间反复出现/消失（review #7）。
  priceOffer(o, usd) {
    const ref = this.thFor(o.gpuName);
    if (ref) { o.thRaw = ref.effective * o.numGpus; o.source = ref.source; o.autoOk = ref.autoOk; }
    // L1 折算必须收敛在这里：参考算力来自矿工自报，卖出去的只有 0.76~0.93 倍。
    // 之前 evaluateOffers 里乘过 L1，但这里又用 ref.effective 覆盖了 o.th，等于白乘。
    o.l1 = Number.isFinite(Number(o.l1)) ? Number(o.l1) : this.l1For(o.gpuName);
    o.th = (Number(o.thRaw) || Number(o.th) || 0) * o.l1;
    o.revenueHr = o.th * 1e12 * usd;
    if (!o.spot) {
      o.spotSkip = false;
      o.roi = o.dph > 0 ? (o.revenueHr - o.dph) / o.dph * 100 : null;
      return o;
    }
    const raw = this.bidPrice(o.revenueHr, o.minBid || 0);
    o.bid = raw === null ? null : Math.min(raw, o.listDph || raw); // 出价高于挂牌价没有意义
    o.spotSkip = o.bid === null;
    o.dph = o.bid ?? o.listDph;
    o.roi = o.spotSkip ? null : (o.revenueHr - o.bid) / o.bid * 100;
    return o;
  }

  // 用最新行情重算每台机器的收益率（扫描结果可能是几分钟前的，币价/全网算力随时在变）
  repriceOffers() {
    const usd = this.usdHsHr6h;   // 决策用 6h 均值，避免每次刷新都换一批"最划算的型号"
    const now = Date.now();
    for (const o of this.offers) {
      this.priceOffer(o, usd);
      o.thPer01 = o.th / (o.dph / 0.1);
      const bl = this.st.blacklist[o.machineId];
      o.blacklisted = bl && bl.until > now ? bl.reason : null;
    }
    this.offers.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
    this.offerStats.profitable = this.offers.filter(x => x.roi !== null && x.roi >= this.cfg.targetProfitPct).length;
  }

  evaluateOffers(raw) {
    const usd = this.usdHsHr6h;   // 同上：挂牌评估用均值
    const now = Date.now();
    const out = [];
    let known = 0;
    for (const o of raw) {
      const ref = this.thFor(o.gpu_name);
      if (!ref) continue;
      known++;
      const listDph = Number(o.dph_total) || 0;
      if (listDph <= 0) continue;
      const bl = this.st.blacklist[o.machine_id];
      // 参考算力来自矿工自报，必须乘实测 L1 才是能卖出去的算力（否则系统性高估 20~30%）
      // 房东优先的 L1：同一房东的型号可能被标错（"假 2080 Ti"），但份额口径不会骗人
      const { l1, source: l1Src, hostId } = this.l1ForMachine(o.gpu_name, o.machine_id);
      const offer = this.priceOffer({
        id: o.id, machineId: o.machine_id, gpuName: o.gpu_name, numGpus: o.num_gpus || 1,
        th: ref.effective * (o.num_gpus || 1), l1, l1Src, hostId, dph: listDph, listDph, bid: null, spotSkip: false,
        spot: this.cfg.useSpot, minBid: Number(o.min_bid ?? o.dph_total) || 0,
        reliability: o.reliability2 ?? o.reliability,
        geolocation: o.geolocation || '', inetDown: o.inet_down, cuda: o.cuda_max_good,
        source: ref.source, autoOk: ref.autoOk,
        blacklisted: bl && bl.until > now ? bl.reason : null,
      }, usd);
      // min_bid 30 分钟稳定性：竞价机的 min_bid 是房东/市场的挂牌地板，
      // 半小时内跳 >10% 说明这台机器正在被抢（或房东在试探），此时出价大概率刚租就被收。
      offer.minBidTrend = this.recordMinBid(o.machine_id, offer.minBid, now);
      // 房东口径 L1 > 1.1 = 这台机器比别人更值钱（"假 2080 Ti"那种），
      // 对它的 min_bid 波动放宽，否则会因为它被抢得凶反而先被过滤掉。
      const trustedHost = l1Src === 'host' && l1 > 1.1;
      if (offer.spot && offer.minBidTrend?.unstable && !trustedHost) offer.spotSkip = true;
      // 房东口径 L1 < 0.8 = 交不出份额，按 24GB 卡同样处理：回避
      if (l1Src === 'host' && l1 < 0.8) { offer.spotSkip = true; offer.avoidHost = true; }
      offer.thPer01 = offer.th / (offer.dph / 0.1);
      const line = this.minThPer01;
      offer.passLine = line == null ? null : offer.thPer01 >= line;
      out.push(offer);
    }
    out.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
    this.offers = out.slice(0, 150);
    if (!this._offersSavedAt || Date.now() - this._offersSavedAt > 2 * MIN) { this._offersSavedAt = Date.now(); this.saveOffers(); this.save(); }
    this.offerStats = {
      total: raw.length, known, profitable: out.filter(x => x.roi !== null && x.roi >= this.cfg.targetProfitPct).length,
      scannedAt: now, error: null,
    };
  }

  // min_bid 走势：返回 { unstable, changePct, spanMin }；样本不足返回 null（不误杀新机）
  recordMinBid(machineId, minBid, now = Date.now()) {
    if (!machineId || !(Number(minBid) > 0)) return null;
    const st = this.st.minBidHist ||= {};
    const key = String(machineId);
    const arr = (st[key] || []).filter(x => now - x.t < 30 * MIN);
    arr.push({ t: now, mb: +Number(minBid).toFixed(4) });
    if (arr.length > 40) arr.splice(0, arr.length - 40);
    st[key] = arr;
    // 清理太久没见的机器，避免 state 无限膨胀
    if (Object.keys(st).length > 400) for (const k of Object.keys(st)) if (!st[k].length || now - st[k].at(-1).t > 120 * MIN) delete st[k];
    const old = arr.find(x => now - x.t >= 20 * MIN);   // 至少 20 分钟前的样本
    if (!old) return { unstable: false, changePct: null, spanMin: null };
    const pct = (Number(minBid) / old.mb - 1) * 100;
    const limit = this.effectiveLimits(now).minBidStablePct;
    return { unstable: Math.abs(pct) > limit, changePct: +pct.toFixed(1), spanMin: Math.round((now - old.t) / MIN) };
  }

  // ---------- 决策：自动退租 + 自动租用 ----------
  async decide() {
    if (!this.instancesOk || !this.vast.ok) return;
    let list = this.instances();
    this.accrue(list);
    this.calibrate(list);
    await this.checkSwitches(list);
    await this.failover(list);
    list = this.instances();
    await this.refreshVenueHealth().catch(() => {});
    // 窗口判定必须每轮都跑：它依赖的是行情(1h 涨幅)与密度，跟"扫描有没有成功"无关。
    // 之前放在 scan() 里，一旦 429/额度耗尽就永远不触发（2026-10-28 18:08 的窗口就是这么漏掉的）。
    this.updateWindowMode();
    if (this.cfg.autoDestroy) await this.autoDestroy(list);
    await this.pollStats(list);
    if (this.cfg.autoRent) await this.autoRent(list);
  }

  calibrate(list) {
    const now = Date.now();
    for (const x of list) {
      if (x.phase !== 'mining' && x.phase !== 'loss') continue;
      if (!POOLS[x.pool]?.perGpu) continue; // 只用矿工自报的逐卡算力（Pearlhash）校准，Kryptex 是矿池估算值
      const arr = (this.samples.get(String(x.id)) || []).filter(s => now - s.t <= 15 * MIN);
      if (arr.length < 8 || arr.some(s => s.hs === 0)) continue;          // 需要连续稳定的样本
      if (now - (this.lastCalib.get(x.id) || 0) < 10 * MIN) continue;
      const w = this.workerFor(x.id);
      if (!w || w.gpus.length !== x.numGpus) continue;                     // 有卡掉了的机器不参与校准
      const k = gpuKey(x.gpuName);
      const ref = this.table.find(g => g.key === k);
      if (!ref) continue;
      const perGpu = x.avgHs / x.numGpus / 1e12;
      // 明显异常的机器（比当前参考值低 25% 以上或高 35% 以上）不拿来校准，免得一台坏机器把标准拉低
      const r = perGpu / ref.effective;
      if (r < 0.75 || r > 1.35) continue;
      const c = this.st.calib[k] || { th: perGpu, samples: 0 };
      c.th = c.samples === 0 ? perGpu : c.th * 0.8 + perGpu * 0.2;
      c.samples++;
      this.st.calib[k] = c;
      this.lastCalib.set(x.id, now);
      if (c.samples === 3) this.log('info', `${x.gpuName} 实测单卡算力 ${c.th.toFixed(1)} TH/s，已替换参考值`);
      this.save();
    }
  }

  async autoDestroy(list) {
    const now = Date.now();
    for (const x of list) {
      if (!x.managed || this.busy.has(x.id)) continue;
      const m = this.st.managed[x.id] || (this.st.managed[x.id] = { rentedAt: x.startedAt, gpuName: x.gpuName, numGpus: x.numGpus, machineId: x.machineId });
      // 0) 刚重启 / 正在换矿池：给它时间恢复，期间不做任何退租判断
      if (x.phase === 'restarting' || x.phase === 'switching') continue;
      // 0b) 竞价被抢占：先试"改价保活"（一次改价零成本，一次重部署 3 分钟），改不动再销毁
      if (x.phase === 'preempted') {
        if (await this.tryRaiseBid(x, m, now)) continue;
        if (!m.preemptedAt) {
          m.preemptedAt = now;
          // 台账：记下被收回的成因与对手价位（临时评测，回答「24GB 卡被谁抢」）
          const info = this.opponentInfo(x, m);
          const l = this.leaseOf(x.id, m, null);
          l.preemptKind ||= info.kind;
          if (info.ratio != null && l.opponentRatio == null) l.opponentRatio = info.ratio;
          m.preemptInfo = info;
          this.save();
          this.log('warn', `实例 ${x.id} 竞价被抢占（stopped，磁盘仍在计费），${PREEMPT_DESTROY_MIN} 分钟内销毁｜成因推断 ${info.kind}${info.ratio != null ? `，对手价位/我方出价 ${info.ratio}×` : ''}`);
        } else if (now - m.preemptedAt > PREEMPT_DESTROY_MIN * MIN) {
          await this.destroy(x.id, '竞价被抢占（stopped，磁盘仍计费）', 0);
        }
        continue;
      }
      // 1a) 开机后矿工迟迟不上线（正常不到 1 分钟）：卡住超过 4 分钟就去抓机器日志，超过 minerStartTimeoutMinutes 直接退租
      if (x.phase === 'booting' && x.deploy?.runningAt) {
        const stuckMin = (now - Math.max(x.deploy.runningAt, x.restartAt || 0, m.poolSetAt || 0)) / MIN;
        if (stuckMin > 4) await this.fetchLogs(x.id, false).catch(() => {});
        if (stuckMin > this.cfg.minerStartTimeoutMinutes) {
          const hint = this.logHint(x.id);
          await this.destroy(x.id, `开机后 ${this.cfg.minerStartTimeoutMinutes} 分钟矿工仍未上线${hint ? '：' + hint : '（机器日志里没有矿工输出）'}`, 24 * 60);
          continue;
        }
      }
      // 1b) 出过算力的机器被 vast 报告离线：vast 偶尔会短暂报错状态，连续离线 10 分钟才退租（以前会立刻按「部署超时」误杀）
      if (x.phase === 'offline') { if (!m.offlineSince) { m.offlineSince = now; this.save(); } }
      else if (m.offlineSince) { delete m.offlineSince; this.save(); }
      if (x.phase === 'offline' && (m.hashAt || this.everHashed.has(x.id))) {
        // spot 的「离线」多半是被收回/出价被顶，不是机器坏了：销毁但不拉黑，下轮可以重新出价
        if (now - m.offlineSince >= 10 * MIN) await this.destroy(x.id, `机器离线超过 10 分钟（vast 状态 ${x.status}${x.statusMsg ? '：' + x.statusMsg : ''}）`, m.spot ? 0 : 6 * 60);
        continue;
      }
      // 1) 部署失败：超时仍无算力（从租下或最近一次重启算起），只针对从没出过算力的机器
      if ((x.phase === 'booting' || x.phase === 'offline') && x.bootAgeMin > this.cfg.bootTimeoutMinutes) {
        await this.destroy(x.id, `部署超时 ${this.cfg.bootTimeoutMinutes} 分钟仍无算力（${x.statusMsg || x.status}）`, 24 * 60);
        continue;
      }
      // 2) 掉线：之前有算力，最近 10 分钟一直为 0（重启后的样本才算）
      if (x.phase === 'nohash' && this.poolDataOk(x.pool)) {
        const arr = (this.samples.get(String(x.id)) || []).filter(s => s.t > Math.max(x.restartAt || 0, x.poolSince || 0));
        const lastHash = [...arr].reverse().find(s => s.hs > 0)?.t ?? null;
        const zeroSince = lastHash ? arr.find(s => s.t > lastHash)?.t : arr[0]?.t;
        const zeros = arr.filter(s => s.t >= (zeroSince ?? now));
        // 连续为 0 的时间真的超过 10 分钟，且这段时间里至少采到 10 个样本（避免程序刚启动/断网恢复时误判）
        if (zeroSince && now - zeroSince >= 10 * MIN && zeros.length >= 10 && zeros.every(s => s.hs === 0)) {
          await this.destroy(x.id, x.restartAt ? `重启后 ${this.cfg.bootTimeoutMinutes} 分钟仍无算力` : '矿工掉线超过 10 分钟', m.spot ? 0 : 6 * 60);
          continue;
        }
      }
      // 2a) 阈值作用域：pinned 且没有 expOverride → 只保留"抢占/离线/部署超时"的收尾；
      //     pinned 且配了 expOverride → 用实验阈值参与 ROI/算力淘汰（实验参数不外溢到别的机器）。
      const lim = this.limitsFor(x);
      if (lim.skipRoi) continue;
      // 2b) 竞价机的算力长期只有预期的 hashLowPct 以下：按实际产出我们是在亏钱（实测 3080 只有 56%）。
      //     按需机不套用这条（按需是包干价，且换机成本高）；竞价机直接退，不拉黑机器。
      if (x.spot && x.health === 'low' && x.firstHashAt && now - x.firstHashAt > 20 * MIN) {
        await this.destroy(x.id, `算力只有预期的 ${Math.round((x.hashRatio || 0) * 100)}%（${x.gpuName}），竞价不值这个价`, 0);
        continue;
      }
      // 3) 止损：实时收益率持续低于止损线（行情数据不新鲜、或出算力不满 10 分钟时不判断）
      if (!this.marketFresh) continue;
      if (!x.firstHashAt || now - x.firstHashAt < (POOLS[x.pool]?.perGpu ? 10 : KX_WARMUP_MIN) * MIN) continue;
      if (x.roi !== null && x.roi < lim.stopLossPct) {
        if (!m.belowSince) { m.belowSince = now; this.save(); this.log('warn', `实例 ${x.id} 收益率 ${x.roi.toFixed(1)}% 跌破止损线 ${lim.stopLossPct}%${lim.fromOverride ? '（实验覆盖）' : ''}，开始计时`); }
        else if (now - m.belowSince > lim.stopLossMinutes * MIN) {
          await this.destroy(x.id, `收益率 ${x.roi.toFixed(1)}% 持续 ${lim.stopLossMinutes} 分钟低于止损线 ${lim.stopLossPct}%`, 60);
        }
      } else if (m.belowSince && x.roi !== null) {
        m.belowSince = null; this.save();
        this.log('info', `实例 ${x.id} 收益率回到 ${x.roi.toFixed(1)}%，止损计时取消`);
      }
    }
  }

  preflight() {
    const why = [];
    if (!this.vast.ok) why.push('未填 vast API Key');
    if (!this.configuredPools().length) why.push('还没填矿池钱包地址');
    else if (!this.poolConfigured(this.cfg.defaultPool)) why.push(`默认矿池 ${poolName(this.cfg.defaultPool)} 没填钱包`);
    if (!this.marketFresh) why.push('PRL 行情数据不新鲜');
    if (!this.minerManifest) why.push(`矿工清单不可用：${this.minerError || '未知原因'}`);
    if (this.account.vastBalance === null) why.push('还没读到 vast 余额');
    // 代码更新了但进程没重载：脚本版本/行为可能对不上，宁可拦住也不带着旧逻辑下单
    if (this.bootScriptMtime != null) {
      try {
        const now = fs.statSync(fileURLToPath(new URL('./onstart.js', import.meta.url))).mtimeMs;
        if (now !== this.bootScriptMtime) why.push('代码已更新但进程未重载（请重启控制台后再租）');
      } catch {}
    }
    return why;
  }

  budget(list) {
    // 抢占待销毁的实例仍然占着账户额度（还要付存储费），必须计进台数上限，
    // 否则一次抢占风暴会连租好几台，实测出现过 5 台（上限 3）的情况。
    const active = list.filter(x => ACTIVE.has(x.status) || x.phase === 'booting' || x.phase === 'preempted');
    const spend = active.reduce((a, x) => a + x.dph, 0);
    return {
      count: active.length, spend,
      roomCount: this.cfg.maxInstances - active.length,
      roomSpend: this.effectiveLimits().maxHourlySpend - spend,
      roomBalance: (this.account.vastBalance ?? 0) - this.cfg.minBalanceReserve,
      spendCapByRunway: this.cfg.runwayGuard ? Math.max(0, ((this.account.vastBalance ?? 0) - this.cfg.minBalanceReserve) / this.cfg.minRunwayHours) : null, // null = 续航保护已关闭
    };
  }

  // 租用节流：被顶 → 秒补 → 再被顶 的拉锯会烧掉部署时间和失败成本。
  // 三个闸门：冷却期（抢占后）、最小间隔、每小时上限。
  // 失败成本：只统计「从来没出过份额」的租约（部署失败 / 刚下就被收回）
  failSpendToday(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const f = this.st.failSpend ||= { day, usd: 0 };
    if (f.day !== day) { f.day = day; f.usd = 0; }
    return f;
  }

  addFailSpend(usd, now = Date.now()) {
    if (!(usd > 0)) return;
    const f = this.failSpendToday(now);
    f.usd = +(f.usd + usd).toFixed(4);
    this.save();
  }

  // ---------- 场所单点降级（Gate 现货 / Lighter 永续） ----------
  // Pearl 的变现只有 Gate 现货、对冲只有 Lighter 永续，任一条断掉就必须进入保护态：
  // 停止新开空、库存超过上限就停租，而不是继续把裸露库存堆高。
  async refreshVenueHealth(now = Date.now()) {
    const cfg = this.cfg.venueGuard || {};
    if (cfg.enabled === false) return this.st.venueHealth;
    if (this.st.venueHealth?.at && now - this.st.venueHealth.at < 10 * MIN) return this.st.venueHealth;
    const gate = { ok: false, why: null };
    try {
      const [cur, pair] = await Promise.all([
        request('https://api.gateio.ws/api/v4/spot/currencies/PEARL', { timeoutMs: 15000 }),
        request('https://api.gateio.ws/api/v4/spot/currency_pairs/PEARL_USDT', { timeoutMs: 15000 }),
      ]);
      const dep = cur?.deposit_disabled === true;
      const wd = cur?.withdraw_disabled === true;
      const tradable = String(pair?.trade_status || '').toLowerCase() === 'tradable';
      gate.ok = !wd && tradable;
      gate.why = [dep && 'deposit_disabled', wd && 'withdraw_disabled', !tradable && `trade_status=${pair?.trade_status ?? '?'}`].filter(Boolean).join(',') || null;
    } catch (e) { gate.ok = false; gate.why = e.message.slice(0, 90); }

    const lighter = { ok: false, why: null };
    try {
      const d = await request('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=4097', { timeoutMs: 15000 });
      const ob = d?.order_book_details?.[0];
      const st = String(ob?.status || '').toLowerCase();
      lighter.ok = !!ob && (st === '' || st === 'active') && (ob?.market_type === undefined || String(ob.market_type).toLowerCase().includes('perp'));
      lighter.why = lighter.ok ? null : `lighter market status=${ob?.status ?? 'missing'}`;
    } catch (e) { lighter.ok = false; lighter.why = e.message.slice(0, 90); }

    const down = !(gate.ok && lighter.ok);
    const prev = this.st.venueGuard || {};
    this.st.venueHealth = { at: now, gate, lighter };
    this.st.venueGuard = { down, why: [gate.why && `gate:${gate.why}`, lighter.why && `lighter:${lighter.why}`].filter(Boolean).join(' | ') || null, since: down ? (prev.down ? prev.since : now) : 0 };
    this.save();
    if (down && !prev.down) this.log('error', `场所降级：${this.st.venueGuard.why}｜停止新开空，库存超过上限即停租`);
    if (!down && prev.down) this.log('warn', '场所已恢复（Gate/Lighter 均可用）——是否恢复对冲需人工确认');
    return this.st.venueHealth;
  }

  // 库存（已到账 + 已确认 + 待结算）：用于降级态下的停租判断
  inventoryPrl() {
    const kx = Number(this.kx?.earned?.balance) || 0;
    const ph = Number(this.account.prlBalance) || 0;
    const pend = Number(this.account.prlPending) || 0;
    return +(kx + ph + pend).toFixed(6);
  }

  // ---------- 窗口模式 ----------
  // 两种触发：
  //   A. PRL 1 小时涨幅 ≥ chg1hPct（消息驱动的窗口）
  //   B. 最优报价的「收入密度 ÷ 地板」≥ ratio 且密度 24h 上升 ≥ densityRise24hPct（算力回落型窗口）
  // 这周的窗口就是 B 类：全世界算力从 94 掉到 76 EH/s，币价没涨但密度回升 20%——只盯币价会漏掉。
  windowInfo(now = Date.now()) {
    const H = this.st.history || [];
    const chg = (ms) => {
      const past = [...H].reverse().find(h => h.t <= now - ms);
      if (!past || !(past.price > 0) || !(this.market.price > 0)) return null;
      return +((this.market.price / past.price - 1) * 100).toFixed(2);
    };
    // densitySamples 里存的是 v = $/H/s/小时，换算成 $/TH·天 才能和挂牌价（$/h）比
    const dens = this.densitySamples || [];
    const toThDay = v => v * 1e12 * 24;
    const recent = dens.filter(x => now - x.t <= 6 * 3600e3).map(x => toThDay(x.v));
    const d6 = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const old24 = [...dens].reverse().find(x => x.t <= now - 24 * 3600e3);
    const d24 = old24 ? toThDay(old24.v) : null;
    const rise = d24 > 0 && d6 > 0 ? +((d6 / d24 - 1) * 100).toFixed(1) : null;
    // 地板：当前报价里「每 TH 每小时的挂牌价」最低值
    const offers = (this.offers || []).filter(o => o.dph > 0 && o.th > 0);
    let ratio = null;
    if (offers.length && d6 > 0) {
      const best = offers.reduce((a, o) => Math.max(a, (o.th * d6 / 24) / o.dph), 0);
      ratio = +best.toFixed(3);
      // 记住上次能用到的地板（每 TH 每小时的挂牌价），额度耗尽/缓存为空时还能算比值
      this.st.lastFloorPerTh = +offers.reduce((a, o) => Math.min(a, o.dph / o.th), Infinity).toFixed(8);
    } else if (d6 > 0 && Number(this.st.lastFloorPerTh) > 0) {
      ratio = +((d6 / 24) / Number(this.st.lastFloorPerTh)).toFixed(3);
    }
    return { chg1h: chg(3600e3), chg6h: chg(6 * 3600e3), density6h: +d6.toFixed(5), densityRise24hPct: rise, ratio };
  }

  // 每轮扫描算一次；触发则进入窗口（最长 minutes 分钟），到点自动退出
  updateWindowMode(now = Date.now()) {
    const cfg = this.cfg.windowMode || {};
    const st = this.st.windowState ||= { active: false, until: 0, reason: null, startedAt: 0 };
    if (st.active && now >= st.until) {
      st.active = false; st.reason = null;
      this.save();
      this.log('info', '窗口模式结束：阈值已恢复（minBidStablePct / dailyFailBudget / maxHourlySpend）');
      this.assertProductionLimits();
      return st;
    }
    if (st.active || cfg.enabled === false) return st;
    const info = this.windowInfo(now);
    let why = null;
    if (info.chg1h != null && info.chg1h >= Number(cfg.chg1hPct ?? 8)) why = `PRL 1h ${info.chg1h > 0 ? '+' : ''}${info.chg1h}% ≥ ${cfg.chg1hPct}%`;
    // 阶梯式上涨：6h 涨够、但 1h 已停滞（最常见的形态，只认 1h 会漏）
    else if (info.chg6h != null && info.chg6h >= Number(cfg.chg6hPct ?? 8) && info.ratio != null && info.ratio >= Number(cfg.stairRatio ?? 1.1)) {
      why = `PRL 6h +${info.chg6h}% ≥ ${cfg.chg6hPct ?? 8}% 且密度÷地板 ${info.ratio} ≥ ${cfg.stairRatio ?? 1.1}（阶梯窗口）`;
    }
    else if (info.ratio != null && info.ratio >= Number(cfg.ratio ?? 1) && info.densityRise24hPct != null && info.densityRise24hPct >= Number(cfg.densityRise24hPct ?? 15)) {
      why = `密度÷地板 ${info.ratio} ≥ ${cfg.ratio} 且密度 24h ${info.densityRise24hPct > 0 ? '+' : ''}${info.densityRise24hPct}%`;
    }
    if (!why) return st;
    st.active = true; st.startedAt = now; st.until = now + Number(cfg.minutes ?? 360) * MIN; st.reason = why;
    this.save();
    this.log('warn', `进入窗口模式（${why}）：放宽 minBidStablePct→${cfg.minBidStablePct}%、失败封顶→$${cfg.failBudgetUsd}/窗口、时租上限→$${cfg.maxHourlySpend}/h，${cfg.minutes} 分钟后自动退出；追价保持关闭`);
    return st;
  }

  // 退出窗口后核对：这三项必须回到生产值，否则报错（防止"放宽后忘了收"）
  assertProductionLimits() {
    const bad = [];
    const want = { minBidStablePct: this.cfg.minBidStablePct, dailyFailBudget: this.cfg.dailyFailBudget, maxHourlySpend: this.cfg.maxHourlySpend, maxBidRaises: this.cfg.maxBidRaises };
    if (Number(want.maxBidRaises) !== 0) bad.push(`maxBidRaises=${want.maxBidRaises}（应为 0）`);
    if (bad.length) this.log('error', `阈值恢复断言失败：${bad.join('、')}`);
    return bad;
  }

  // 有效阈值：窗口期内只有这三项被放宽，其余一律用生产值
  effectiveLimits(now = Date.now()) {
    const st = this.st.windowState || {};
    const w = this.cfg.windowMode || {};
    const base = {
      minBidStablePct: Number(this.cfg.minBidStablePct),
      dailyFailBudget: Number(this.cfg.dailyFailBudget),
      maxHourlySpend: Number(this.cfg.maxHourlySpend),
      window: false,
    };
    if (!st.active || now >= (st.until || 0)) return base;
    return {
      minBidStablePct: Number(w.minBidStablePct ?? base.minBidStablePct),
      dailyFailBudget: Number(w.failBudgetUsd ?? base.dailyFailBudget),
      maxHourlySpend: Number(w.maxHourlySpend ?? base.maxHourlySpend),
      window: true,
    };
  }

  // ---------- 份额反推 L1（按型号） ----------
  // L1 = 份额反推算力 ÷ 矿工自报。出价评估用的是"参考算力"，而参考算力来自矿工自报，
  // 所以必须乘 L1 才是真实可卖的算力；样本不足 3 的型号用全局保守值 0.8。
  l1For(gpuName) {
    const k = gpuKey(gpuName);
    const rec = (this.st.l1ByModel || {})[k];
    const s = (rec?.samples || []).filter(x => Number.isFinite(x) && x > 0.3 && x < 1.5);
    if (s.length < 3) return Number(this.cfg.l1Default ?? 0.8);
    const sorted = [...s].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  recordL1(gpuName, ratio, hostId = null) {
    if (!(ratio > 0.3 && ratio < 2.0)) return;
    const k = gpuKey(gpuName);
    const st = this.st.l1ByModel ||= {};
    const rec = st[k] ||= { samples: [] };
    rec.samples.push(+ratio.toFixed(3));
    if (rec.samples.length > 20) rec.samples.splice(0, rec.samples.length - 20);
    rec.n = rec.samples.length;
    rec.median = this.l1For(gpuName);
    // 房东维度：同一房东的机器口径更稳——型号可能被房东标错（"假 2080 Ti"就是这么来的），
    // 而份额不会骗人。样本 ≥3 才用。
    if (hostId != null) {
      const h = this.st.l1ByHost ||= {};
      const hr = h[String(hostId)] ||= { samples: [] };
      hr.samples.push(+ratio.toFixed(3));
      if (hr.samples.length > 20) hr.samples.splice(0, hr.samples.length - 20);
      hr.n = hr.samples.length;
      hr.median = this.l1ForHost(hostId);
    }
  }

  l1ForHost(hostId) {
    if (hostId == null) return null;
    const rec = (this.st.l1ByHost || {})[String(hostId)];
    const s = (rec?.samples || []).filter(x => Number.isFinite(x) && x > 0.3 && x < 2.0);
    if (s.length < 3) return null;
    const sorted = [...s].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // 选机用的 L1：房东优先、型号兜底
  l1ForMachine(gpuName, machineId) {
    const hostId = machineId != null ? this.st.machineHost?.[String(machineId)] : null;
    const byHost = this.l1ForHost(hostId);
    if (byHost != null) return { l1: byHost, source: 'host', hostId };
    return { l1: this.l1For(gpuName), source: 'model', hostId: hostId ?? null };
  }

  rentAllowed(now = Date.now()) {
    // 总开关：余额见底或行情全部失效时，一切新租停止（与 fail-closed 配套的最后一道闸）
    const bal = this.account.vastBalance;
    const minBal = Number(this.cfg.minBalanceStop ?? 5);
    if (bal != null && bal < minBal) return { ok: false, why: `余额 $${bal.toFixed(2)} < 下限 $${minBal}` };
    // 场所单点降级：库存超过上限就停租（不拦已有机器，交止损处理）
    const vg = this.st.venueGuard || {};
    if (vg.down) {
      const inv = this.inventoryPrl();
      const cap = Number(this.cfg.venueGuard?.inventoryCapPrl ?? 50);
      if (inv > cap) return { ok: false, why: `场所降级（${vg.why}）且库存 ${inv.toFixed(1)} PRL > 上限 ${cap}，停租` };
    }
    const staleMin = this.market.updatedAt ? (now - this.market.updatedAt) / MIN : 999;
    if (staleMin > Number(this.cfg.maxSourceStaleMin ?? 60)) return { ok: false, why: `行情已 ${Math.round(staleMin)} 分钟没更新` };
    if (now < (this.rentCooldownUntil || 0)) return { ok: false, why: '429 退避中' };
    if (now < (this.preemptCooldownUntil || 0)) return { ok: false, why: `竞价被收回后的冷静期（剩 ${Math.ceil((this.preemptCooldownUntil - now) / 60000)} 分钟）` };
    // 每日失败成本封顶：租到的机器一台都没出过份额就被收回/退租的钱，
    // 单独累计（不算正常租用），到顶就停到明天——否则"等待模式"的上限无界。
    const lim = this.effectiveLimits(now);
    const fs = this.failSpendToday(now);
    const fsCap = Number(lim.dailyFailBudget ?? 0.3);
    if (fsCap > 0 && fs.usd >= fsCap && lim.window) {
      // 窗口期内封顶是绝对额（$1/窗口），达到就退出窗口，避免"窗口里无限烧"
      this.st.windowState = { ...(this.st.windowState || {}), active: false, reason: null };
      this.save();
      this.log('warn', `窗口内失败成本 $${fs.usd.toFixed(2)} 达到上限 $${fsCap}，提前退出窗口模式`);
    }
    if (fsCap > 0 && fs.usd >= fsCap) return { ok: false, why: `今日失败成本 $${fs.usd.toFixed(2)} 已达上限 $${fsCap}（停机到明天）` };
    this.rentTimes = (this.rentTimes || []).filter(t => now - t < 60 * MIN);
    if (this.rentTimes.length >= (this.cfg.maxRentsPerHour || 3)) return { ok: false, why: `本小时已租 ${this.rentTimes.length} 台（上限 ${this.cfg.maxRentsPerHour}）` };
    const last = this.rentTimes[this.rentTimes.length - 1] || 0;
    const gap = (this.cfg.rentMinIntervalMin || 10) * MIN;
    if (last && now - last < gap) return { ok: false, why: `距上次租用不足 ${this.cfg.rentMinIntervalMin} 分钟` };
    return { ok: true };
  }

  // 手动租用（网页手抄 offer 的通道）：搜索额度耗尽时，这是唯一还能下单的路。
  // 用户从 cloud.vast.ai/create/ 抄 offer id + 型号 + dph + min_bid，这里做与扫描同源的估价，
  // 过线才下单，避免"盲租"。
  async rentManual({ offerId, gpuName, dph, minBid = null, numGpus = 1, geolocation = '', reliability = null, inetDown = null, force = false }) {
    if (!offerId || !gpuName || !(Number(dph) > 0)) throw new Error('需要 offerId、gpuName、dph 三个字段');
    const ref = this.thFor(gpuName);
    if (!ref) throw new Error(`未知型号 ${gpuName}（没有参考算力，无法估价）`);
    const usd = this.usdHsHr6h;
    const { l1, source: l1Src } = this.l1ForMachine(gpuName, null);
    const offer = this.priceOffer({
      id: Number(offerId), machineId: null, gpuName, numGpus: Number(numGpus) || 1,
      th: ref.effective * (Number(numGpus) || 1), l1, l1Src,
      dph: Number(dph), listDph: Number(dph), bid: null, spotSkip: false,
      spot: !!this.cfg.useSpot, minBid: Number(minBid ?? dph),
      reliability, geolocation, inetDown, cuda: null, source: '手抄', autoOk: ref.autoOk,
    }, usd);
    offer.thPer01 = offer.th / (offer.dph / 0.1);
    const line = this.minThPer01;
    offer.passLine = line == null ? null : offer.thPer01 >= line;
    const est = { gpu: gpuName, dph: offer.dph, bid: offer.bid, revenueHr: +offer.revenueHr.toFixed(4), roi: +(offer.roi ?? 0).toFixed(1), th: +offer.th.toFixed(1), thPer01: Math.round(offer.thPer01), passLine: offer.passLine, l1, l1Src, spotSkip: offer.spotSkip };
    const ok = force || (!offer.spotSkip && offer.roi != null && offer.roi >= this.cfg.targetProfitPct && offer.passLine !== false);
    if (!ok) throw Object.assign(new Error(`估价不过线：ROI ${est.roi}%（目标 ${this.cfg.targetProfitPct}%）、thPer01 ${est.thPer01}（线 ${line == null ? '—' : Math.round(line)}）${offer.spotSkip ? '、出价无效' : ''}`), { est });
    const id = await this.rent(offer, 'manual');
    return { id, est };
  }

  async autoRent(list) {
    if (Date.now() < (this.rentCooldownUntil || 0)) return; // 429 退避期内不下单
    if (Date.now() - this.lastRentAt < 60_000) return;
    const why = this.preflight();
    if (why.length) { this._warnOnce('pre', `自动租用暂停：${why.join('、')}`); return; }
    const plan = this.scanPlan();
    // 「最近扫描太旧就不下单」这条在额度耗尽时是致命的：scannedAt 不再更新，
    // 缓存里有可用报价也永远进不来（2026-10-28 两次窗口都是被这条挡住的）。
    // 额度暂停期间，用报价缓存的时间戳当新鲜度基准，上限 offerCacheMaxMin 分钟。
    const quotaPaused = this.pauseReason === 'quota' && Date.now() < (this.scanPausedUntil || 0);
    const cacheAt = this.st.offersCache?.at || 0;
    const cacheAge = cacheAt ? Date.now() - cacheAt : Infinity;
    const cacheUsable = (this.offers || []).length > 0 && cacheAge <= (Number(this.cfg.offerCacheMaxMin) || 30) * MIN;
    const maxAge = Math.min(60 * MIN, Math.max(10 * MIN, (plan.interval || 0) * 2));
    const freshAt = quotaPaused && cacheUsable ? Math.max(this.offerStats.scannedAt || 0, cacheAt) : (this.offerStats.scannedAt || 0);
    if (Date.now() - freshAt > maxAge) return;
    if (quotaPaused && cacheUsable) this._warnOnce('cachebid', `额度已耗尽，用 ${Math.round(cacheAge / 60000)} 分钟前的缓存报价出价（下单不吃搜索配额）`);
    const b = this.budget(list);
    if (b.roomCount <= 0 || b.roomSpend <= 0) return;
    this.repriceOffers(); // 下单前一刻用最新币价和全网算力重算
    if (b.roomBalance <= 0) { this._warnOnce('bal', `vast 余额低于保留金额 $${this.cfg.minBalanceReserve}，停止新租`); return; }
    // 续航保护：租下之后，余额（扣除保留金额）必须够所有机器再跑 minRunwayHours 小时
    const spendCap = this.cfg.runwayGuard ? b.roomBalance / this.cfg.minRunwayHours : Infinity;
    const now = Date.now();
    const candidates = this.offers.filter(o =>
      o.roi >= this.cfg.targetProfitPct && o.autoOk && !o.used && !o.spotSkip &&
      !(this.st.blacklist[o.machineId]?.until > now) &&
      o.dph <= b.roomSpend
      // 额度耗尽时的应急通道：用缓存报价下单（下单走 /asks/，不吃搜索配额）。
      // 只接受 ≤ offerCacheMaxMin 分钟、且 min_bid 不跳动的缓存，其余当作过期。
      && (!o.stale || Date.now() - (this.st.offersCache?.at || 0) <= (Number(this.cfg.offerCacheMaxMin) || 30) * MIN)
      && !(o.stale && o.minBidTrend?.unstable));
    const affordable = candidates.filter(o => b.spend + o.dph <= spendCap);
    if (candidates.length && !affordable.length) {
      this._warnOnce('runway', `余额 $${this.account.vastBalance.toFixed(2)} 只够每小时花 $${spendCap.toFixed(2)}（续航 ${this.cfg.minRunwayHours} 小时），现在已花 $${b.spend.toFixed(2)}/h，停止新租；充值后会自动继续`);
      return;
    }
    // 节流闸门：放在"没钱/续航不够"这些真实原因之后，只拦"刚租过/刚被顶过"的频率问题
    const gate = this.rentAllowed();
    if (!gate.ok) { this._warnOnce('rentgate', `暂停新租：${gate.why}`); return; }
    // 一轮把达标的都抢下来（最多 5 台），不再每分钟只租一台；被别人抢走就直接试下一台，每轮最多下 8 次单
    let rented = 0, tries = 0, spend = b.spend, roomSpend = b.roomSpend, roomCount = b.roomCount, used = 0;
    for (const pick of affordable) {
      if (tries >= 8 || rented >= 5 || roomCount <= 0) break;
      if (spend + pick.dph > spendCap || pick.dph > roomSpend || b.roomBalance - used < pick.dph) continue;
      tries++;
      const r = await this.rent(pick, 'auto').then(() => 'ok', e => e.gone ? 'gone' : 'fail');
      if (r === 'fail') break;
      if (r === 'ok') { rented++; spend += pick.dph; roomSpend -= pick.dph; roomCount--; used += pick.dph; }
    }
  }

  _warnOnce(key, msg) {
    this._warned ||= {};
    if (this._warned[key] && Date.now() - this._warned[key] < 30 * MIN) return;
    this._warned[key] = Date.now();
    this.log('warn', msg);
  }

  async rent(offer, by = 'manual') {
    const why = this.preflight().filter(w => by === 'auto' || !w.includes('行情'));
    if (why.length) throw new Error(why.join('、'));
    // 所有填了钱包的矿池参数都写进开机脚本，以后可以在面板上切换；先挖默认矿池
    const poolIds = this.configuredPools();
    const def = this.defaultPool;
    const onstart = buildOnstart({
      pools: poolIds.map(id => ({ id, ...minerTarget(id, {
        wallet: this.walletFor(id), geo: offer.geolocation, pearlUrl: this.cfg.poolUrl,
        // 填了 NOCK 地址时 Pearlhash 用户名为 prl地址@nock=NOCK地址（Pearlhash 规定的格式）
        nockAddress: id === 'pearlhash' ? this.cfg.nockAddress : '',
      }) })),
      def, miners: this.minerManifest.miners,
      cnFirst: /(^|[\s,])(CN|China)\s*$/i.test(offer.geolocation || ''),
      extraArgs: this.minerArgsFor(offer.gpuName),
      foreground: this.cfg.launchMode === 'args',
    });
    // 下单前按最新行情重算出价：扫描结果可能是几分钟前的，行情一动就会出价偏低、刚租到就被顶
    if (offer.spot) {
      const fresh = this.bidPrice(offer.revenueHr, offer.minBid || 0);
      if (fresh !== null) offer.bid = Math.min(fresh, offer.listDph || fresh);
      offer.dph = offer.bid ?? offer.dph;
    }
    offer.used = true;
    this.lastRentAt = Date.now();
    const tag = by === 'auto' ? '自动' : '手动';
    try {
      const r = await this.vast.rent(offer.id, {
        image: this.cfg.image, disk: this.cfg.disk, label: this.rigLabel(offer.gpuName, def), onstart,
        mode: this.cfg.launchMode === 'args' ? 'args' : 'ssh',
        price: offer.spot ? offer.bid : null,
      });
      if (!r?.success || !r.new_contract) throw new Error(r?.msg || r?.error || JSON.stringify(r).slice(0, 160));
      const id = String(r.new_contract);
      this.st.managed[id] = {
        offerId: offer.id, machineId: offer.machineId, gpuName: offer.gpuName, numGpus: offer.numGpus,
        bid: offer.spot ? offer.dph : null, dphBase: offer.dph,
        expectedTh: offer.th, rentedAt: Date.now(), dph: offer.dph, belowSince: null, inetDown: offer.inetDown ?? null,
        spot: !!offer.spot, listDph: offer.listDph ?? null,
        sv: SCRIPT_VERSION, pools: poolIds, pool: def, mode: this.cfg.launchMode === 'args' ? 'args' : 'ssh',
      };
      // 台账从下单这一刻开始记：t_rent 必须是我们真正付钱的起点，不是部署成功那刻
      {
        const l = this.leaseOf(id, this.st.managed[id], { geolocation: offer.geolocation, host_id: offer.hostId ?? null });
        l.geo ||= offer.geolocation || '';
        l.pool = def;
      }
      this.save();
      if (by === 'auto') { this.rentTimes.push(Date.now()); this.save(); }
      // 出价/收入比要进日志：spot 的"清算比例"就是靠这批样本的中位数算出来的
      const ratio = offer.spot && offer.revenueHr > 0 ? `（出价/收入 ${(offer.dph / offer.revenueHr * 100).toFixed(0)}%）` : '';
      const line = this.minThPer01;
      const tp = this.thPer01Of(offer);
      const lineTxt = line && tp ? `｜${Math.round(tp).toLocaleString('en-US')} TH/$0.1h，今日线 ${Math.round(line)}，${tp >= line ? '过线' : '不过线'}` : '';
      this.log('success', `${tag}租用 ${offer.numGpus}×${offer.gpuName}（实例 ${id}）${offer.spot ? '竞价出价' : ''}$${offer.dph.toFixed(4)}/h${ratio}，挖 ${poolName(def)}，预计收益率 ${offer.roi.toFixed(1)}%${lineTxt}`);
      setTimeout(() => this.refreshVast(), 3000);
      return id;
    } catch (e) {
      // no_such_ask / not available = 这台机器在扫描后被别人抢先租走了，不是机器的问题，不拉黑
      if (/no_such_ask|not available|unavailable/i.test(e.message)) {
        this.offers = this.offers.filter(o => o.id !== offer.id);
        this.lastRentAt = 0;
    this.rentTimes = [];              // 最近一小时的自动租用时间点
    this.preemptCooldownUntil = 0;    // 竞价被收回后的冷静期
        this.log('info', `${offer.numGpus}×${offer.gpuName} $${offer.dph.toFixed(3)}/h 已被别人抢先租走${by === 'auto' ? '，换下一台' : ''}`);
        // 同一台机器 2 小时内第 2 次「刚被租走」：多半是一直挂在列表里、实际租不了的机器，屏蔽 2 小时，别再浪费下单机会
        if (offer.machineId) {
          const g = this.st.goneCount ||= {};
          const now = Date.now();
          for (const [k, v] of Object.entries(g)) if (now - v.t > 2 * 60 * MIN) delete g[k];
          const c = g[offer.machineId] = { n: (g[offer.machineId]?.n || 0) + 1, t: now };
          if (c.n >= 2) {
            this.st.blacklist[offer.machineId] = { until: now + 2 * 60 * MIN, reason: '反复租不到' };
            delete g[offer.machineId];
            this.log('info', `${offer.numGpus}×${offer.gpuName}（机器 ${offer.machineId}）反复出现在列表里却租不到，屏蔽 2 小时`);
          }
          this.save();
        }
        const err = new Error('这台机器刚被别人租走了，换一台试试');
        err.gone = true;
        throw err;
      }
      // GPU conflict = 下单前这台机器已被人占了（和 no_such_ask 同类）。不是机器坏了，不拉黑。
      if (/GPU conflict|already rented/i.test(e.message)) {
        this.offers = this.offers.filter(o => o.id !== offer.id);
        this.lastRentAt = 0;
    this.rentTimes = [];              // 最近一小时的自动租用时间点
    this.preemptCooldownUntil = 0;    // 竞价被收回后的冷静期
        this.log('info', `${offer.numGpus}×${offer.gpuName} 下单时已被占用（GPU conflict），换下一台`);
        const err = new Error('这台机器刚被别人租走了，换一台试试');
        err.gone = true;
        throw err;
      }
      // 429 限流：这是我们请求太快，不是机器问题。退避 5 分钟，不拉黑
      if (e.status === 429) {
        this.rentCooldownUntil = Date.now() + 5 * MIN;
        this._warnOnce('rent429', 'vast 提示请求过于频繁，暂停自动租用 5 分钟（不影响已租机器）');
        throw e;
      }
      // 竞价：扫描到下单之间 min_bid 涨了 → 出价被拒。这是出价问题，不是机器问题，不能拉黑
      if (offer.spot && /bid|price|too low|min_bid/i.test(e.message)) {
        this.offers = this.offers.filter(o => o.id !== offer.id);
        this.lastRentAt = 0;
    this.rentTimes = [];              // 最近一小时的自动租用时间点
    this.preemptCooldownUntil = 0;    // 竞价被收回后的冷静期
        this.log('info', `${offer.numGpus}×${offer.gpuName} 竞价出价 $${(offer.bid ?? 0).toFixed(4)}/h 低于当前最低价${by === 'auto' ? '，换下一台' : ''}（${e.message.slice(0, 80)}）`);
        const err = new Error('出价低于当前最低价，换一台试试');
        err.gone = true;
        throw err;
      }
      this.st.blacklist[offer.machineId] = { until: Date.now() + 6 * 60 * MIN, reason: '租用失败' };
      this.save();
      this.log('error', `${tag}租用 ${offer.gpuName}（offer ${offer.id}）失败：${e.message}`);
      throw e;
    }
  }

  rigLabel(gpuName, pool) { return `${LABEL}-${gpuKey(gpuName)} pool=${pool}`; }

  // 被顶时先提高出价保活：目标是「当前出价×1.1」与「入场价×1.1」的较大者，
  // 但不得超过 revenue/(1+目标ROI)；每实例每小时最多 maxBidRaises 次（默认 0 = 不追价）。
  //
  // 为什么默认 0：2026-10-27 复盘 20 次改价、9 台机器，**追价后恢复出算力的是 0 台**。
  // interruptible 是「房东随时可收回」，不是价高者得——容器被收回后加价不会复活。
  // 代码路径保留，是等 (c) 的对手价位数据攒够后能回放验证这条结论。
  async tryRaiseBid(x, m, now) {
    if (!x.spot) return false;
    m.bidRaises = (m.bidRaises || []).filter(t => now - t < 60 * MIN);
    const maxRaises = Number.isFinite(Number(this.cfg.maxBidRaises)) ? Number(this.cfg.maxBidRaises) : 0;
    // 刚租下还没出算力时 revenueHr=0，用"预期收入"算上限，否则永远无法改价
    const rev = Math.max(Number(x.revenueHr) || 0, Number(x.expRevenueHr) || 0);
    const upper = rev / (1 + this.cfg.targetProfitPct / 100);
    const cur = Number(x.dph) || 0;
    const target = Math.max(cur * 1.1, Number(x.minBid || 0) * 1.1);
    const viable = upper > 0 && target > cur && target <= upper;
    // 即使不追价也把「如果追会出什么价」算出来记下：以后有对手价位数据可以回放，
    // 不用为了验证再拿真钱去试。
    m.wouldRaise = { at: now, cur: +cur.toFixed(4), target: +target.toFixed(4), upper: +upper.toFixed(4), viable, maxRaises };
    if (m.bidRaises.length >= maxRaises || !viable) {
      if (maxRaises === 0 && !m.raiseOffLogged) {
        m.raiseOffLogged = true;
        this.save();
        this.log('info', `实例 ${x.id} 被顶：按当前开关不追价（若追会出 $${target.toFixed(4)}，上限 $${upper.toFixed(4)}），直接走销毁换下一台`);
      }
      return false;
    }
    try {
      await this.vast.setBidPrice(x.id, +target.toFixed(4));
      m.bidRaises.push(now);
      // 抬价成功就把「自己的出价」记为核价基准：m.bid 原来只在租用时写过一次，
      // 抬价后不更新，后续任何拿 m.bid 当「下单价」的比对都会把这次抬价当成平台改价。
      m.bid = +target.toFixed(4);
      m.dphBase = m.bid;
      delete m.priceDeviationPct;
      delete m.preemptedAt;
      this.save();
      this.log('warn', `实例 ${x.id} 被顶，出价 $${cur.toFixed(4)} → $${target.toFixed(4)}（上限 $${upper.toFixed(4)}，本小时第 ${m.bidRaises.length} 次，核价基准已跟随）`);
      return true;
    } catch (e) {
      this.log('warn', `实例 ${x.id} 改价失败：${e.message}（改为销毁）`);
      return false;
    }
  }

  // ---------- 切换矿池 ----------
  // 改 vast 标签 → 机器上的脚本 1 分钟内读到 pool=xxx 并改连新矿池；控制端等它在新矿池出算力
  async setPool(id, pool, { auto = false, reason = '' } = {}) {
    id = String(id);
    const i = this.rawInstances.find(x => String(x.id) === id);
    if (!i) throw new Error('这台机器已不在实例列表里');
    if (!POOLS[pool]) throw new Error('未知矿池');
    if (!this.poolConfigured(pool)) throw new Error(`${poolName(pool)} 还没填钱包地址`);
    const can = this.switchablePools(i);
    if (!can.length) throw new Error('这台机器是旧版脚本租的（或手动部署的），不支持切换矿池');
    if (!can.includes(pool) && pool === 'kryptex' && this.st.managed[id]?.sv === 2) throw new Error('这台是上一版程序租的，挖 Kryptex 用的 WildRig 不兼容（交不出份额），新租的机器才能切 Kryptex');
    if (!can.includes(pool)) throw new Error(`这台机器租的时候还没填 ${poolName(pool)} 钱包，脚本里没有它的参数，只能切到：${can.map(poolName).join('、')}`);
    if (this.busy.has(id)) throw new Error('这台机器正在处理中');
    const m = this.st.managed[id] ||= { rentedAt: i.start_date ? i.start_date * 1000 : Date.now(), gpuName: i.gpu_name, numGpus: i.num_gpus, machineId: i.machine_id, sv: 2, pools: can };
    const rp = this.rigPool(i);
    if (m.sw?.to === pool) throw new Error(`正在切换到 ${poolName(pool)}，请稍等`);
    if (!m.sw && rp.want === pool && rp.actual === pool) throw new Error(`已经在挖 ${poolName(pool)}`);
    this.busy.add(id);
    try {
      await this.vast.setLabel(id, this.rigLabel(i.gpu_name, pool));
      const from = m.sw?.from || rp.actual;
      i.label = this.rigLabel(i.gpu_name, pool);
      m.belowSince = null;
      if (!m.hashAt && !this.everHashed.has(id)) {
        // 还在部署、没出过算力：只是改了要挖的矿池，部署流程照常（矿工启动超时从现在重新计时）
        delete m.sw; m.pool = pool; m.poolSetAt = Date.now();
        this.save();
        this.log('info', `实例 ${id}（${i.num_gpus}×${i.gpu_name}）还在部署，改为部署完成后直接挖 ${poolName(pool)}`);
        return;
      }
      m.sw = { from, to: pool, at: Date.now(), auto, reason };
      m.pool = pool;
      this.save();
      this.log(auto ? 'warn' : 'info', `${auto ? '自动' : ''}切换实例 ${id}（${i.num_gpus}×${i.gpu_name}）：${poolName(from)} → ${poolName(pool)}${reason ? '（' + reason + '）' : ''}，约 1~2 分钟生效`);
    } catch (e) {
      this.log('error', `切换实例 ${id} 的矿池失败：${e.message}`);
      throw e;
    } finally { this.busy.delete(id); }
  }

  // 批量切换：把 from（不填 = 所有）矿池上可切换的机器都切到 to
  async switchAll(to, from = null) {
    let n = 0; const skipped = [];
    for (const x of this.instances()) {
      if (from && x.wantPool !== from) continue;
      if (x.wantPool === to && !x.switching) continue;
      if (!x.switchable.includes(to)) { skipped.push(x.id); continue; }
      try { await this.setPool(x.id, to); n++; } catch { skipped.push(x.id); }
    }
    return { switched: n, skipped };
  }

  // 检查进行中的切换：在新矿池出算力 = 成功；超时 = 失败并改回原矿池
  async checkSwitches(list) {
    const now = Date.now();
    for (const x of list) {
      const m = this.st.managed[x.id];
      if (!m?.sw) continue;
      const sw = m.sw;
      if (!m.hashAt && !this.everHashed.has(x.id)) {
        // 旧版本留下的：部署中的机器不按「切换」处理，避免超时后被改回原矿池
        delete m.sw; m.poolSetAt = Math.max(m.poolSetAt || 0, sw.at); this.save();
        continue;
      }
      // Kryptex 断开后 5 分钟内仍显示在线，所以要求是切换之后新建立的连接
      const kw = sw.to === 'kryptex' ? this.rigPool(this.rawInstances.find(i => String(i.id) === x.id) || { id: x.id }).kw : null;
      const fresh = sw.to !== 'kryptex' || (kw?.openedAt || 0) >= sw.at - 60_000;
      if (x.onPools?.[sw.to] && fresh) {
        const secs = Math.round((now - sw.at) / 1000);
        delete m.sw; m.poolSince = now; m.onPool = sw.to; this.save();
        this.log('success', `实例 ${x.id} 已在 ${poolName(sw.to)} 出算力（切换用时 ${Math.floor(secs / 60)}分${String(secs % 60).padStart(2, '0')}秒）`);
        continue;
      }
      if (now - sw.at < SWITCH_TIMEOUT_MIN * MIN) continue;
      // 超时：看它还在不在原矿池挖，判断是「机器没收到切换指令」还是「新矿池连不上」
      await this.fetchLogs(x.id, false).catch(() => {});
      const hint = this.logHint(x.id);
      const stillOld = sw.from && x.onPools?.[sw.from];
      const why = stillOld ? '机器没有响应切换（可能读不到自己的标签）' : `${SWITCH_TIMEOUT_MIN} 分钟内没在 ${poolName(sw.to)} 出算力`;
      m.swFail = { ...(m.swFail || {}), [sw.to]: now };
      delete m.sw;
      const back = sw.from && sw.from !== sw.to && this.poolConfigured(sw.from) ? sw.from : null;
      if (back) {
        m.pool = back;
        try { await this.vast.setLabel(x.id, this.rigLabel(x.gpuName, back)); } catch {}
      }
      if (sw.auto && m.failoverFrom === back) delete m.failoverFrom;
      this.st.switchFails = (this.st.switchFails || 0) + 1;
      this.save();
      this.log('error', `实例 ${x.id} 切换到 ${poolName(sw.to)} 失败：${why}${hint ? '。机器日志：' + hint : ''}${back ? `，已改回 ${poolName(back)}` : ''}`);
    }
  }

  // 矿池故障判断：接口连不上超过 N 分钟，或者在这个池挖的机器（≥2 台）有一半以上没算力
  poolHealth(list) {
    const now = Date.now();
    const out = {};
    for (const p of this.configuredPools()) {
      const rigs = list.filter(x => x.pool === p && x.wantPool === p && !x.switching && this.everHashed.has(x.id) && ACTIVE.has(x.status) && x.phase !== 'restarting');
      const dead = rigs.filter(x => !x.onPools?.[p]).length;
      const apiDown = this.poolApiDownMin(p);
      // 至少 3 台、六成以上同时没算力才算矿池故障（一两台机器自己出问题不算）
      const bad = apiDown >= this.cfg.failoverMinutes || (rigs.length >= 3 && dead / rigs.length >= 0.6);
      if (bad) { this.poolBadSince[p] ||= now; this.poolGoodSince[p] = null; }
      else { this.poolBadSince[p] = null; this.poolGoodSince[p] ||= now; }
      out[p] = {
        bad, apiDownMin: apiDown, rigs: rigs.length, dead,
        badMin: this.poolBadSince[p] ? (now - this.poolBadSince[p]) / MIN : 0,
        goodMin: this.poolGoodSince[p] ? (now - this.poolGoodSince[p]) / MIN : 0,
        why: apiDown >= this.cfg.failoverMinutes ? `接口连不上 ${Math.round(apiDown)} 分钟` : bad ? `${dead}/${rigs.length} 台机器没有算力` : '',
      };
    }
    return out;
  }

  // 故障转移：默认/主矿池坏了 → 把可切换的机器切到另一个矿池；主矿池恢复一段时间后切回
  async failover(list) {
    const health = this.health = this.poolHealth(list);
    if (!this.cfg.failover) return;
    const pools = this.configuredPools();
    if (pools.length < 2) return;
    const now = Date.now();
    for (const p of pools) {
      const other = pools.find(q => q !== p);
      const h = health[p], ho = health[other];
      // 切走
      if (h.bad && h.badMin >= this.cfg.failoverMinutes && !ho.bad) {
        // 只自动切 vast 的机器（本程序租的都是 vast；以后接入其他平台时，整组重启/重新租的代价大，不自动切）
        const rigs = list.filter(x => (x.provider || 'vast') === 'vast' && x.wantPool === p && !x.switching && x.switchable.includes(other) && !(this.st.managed[x.id]?.swFail?.[other] > now - 30 * MIN));
        if (rigs.length) {
          this.log('warn', `${poolName(p)} 故障（${h.why}），把 ${rigs.length} 台机器临时切到 ${poolName(other)}`);
          this.st.failovers.push({ t: now, from: p, to: other, n: rigs.length, why: h.why });
          if (this.st.failovers.length > 50) this.st.failovers.splice(0, this.st.failovers.length - 50);
          for (const x of rigs) {
            try { await this.setPool(x.id, other, { auto: true, reason: `${poolName(p)} 故障` }); this.st.managed[x.id].failoverFrom = p; } catch {}
          }
          this.save();
        }
      }
      // 切回：主矿池恢复后稳定一段时间（最近 6 小时每故障一次，等待时间翻倍：15 → 30 → 60… 最多 4 小时）
      const back = list.filter(x => this.st.managed[x.id]?.failoverFrom === p && !x.switching);
      if (back.length && !h.bad) {
        const recent = this.st.failovers.filter(f => f.from === p && now - f.t < 6 * 60 * MIN).length;
        const hold = Math.min(240, 15 * 2 ** Math.max(0, recent - 1));
        if (h.goodMin >= hold) {
          this.log('info', `${poolName(p)} 已恢复 ${Math.round(h.goodMin)} 分钟，把 ${back.length} 台机器切回`);
          for (const x of back) {
            const m = this.st.managed[x.id];
            if (x.wantPool === p) { delete m.failoverFrom; continue; }
            try { await this.setPool(x.id, p, { auto: true, reason: `${poolName(p)} 已恢复` }); delete m.failoverFrom; } catch {}
          }
          this.save();
        }
      }
    }
  }

  minerArgsFor(gpuName) {
    const extra = this.cfg.minerArgs || '';
    if (/RTX\s*50/i.test(gpuName) && !/pearlhash-kernel/.test(extra)) return `--pearlhash-kernel 2 ${extra}`.trim();
    return extra;
  }

  // 一键重启：vast 重启容器（数据保留），开机脚本会自动把矿工拉起来
  async reboot(id) {
    id = String(id);
    const inst = this.rawInstances.find(i => String(i.id) === id);
    if (!inst) throw new Error('这台机器已不在实例列表里');
    this.st.restarts ||= {};
    const last = this.st.restarts[id] || 0;
    if (Date.now() - last < 5 * MIN) throw new Error('5 分钟内刚重启过，请等它恢复');
    if (this.busy.has(id)) throw new Error('这台机器正在处理中');
    this.busy.add(id);
    try {
      await this.vast.reboot(id);
      this.st.restarts[id] = Date.now();
      const m = this.st.managed[id];
      if (m) m.belowSince = null;
      this.save();
      const x = this.instances().find(i => i.id === id);
      this.log('warn', `已重启实例 ${id}（${inst.num_gpus}×${inst.gpu_name}）${x?.healthMsg ? '：' + x.healthMsg : ''}`);
      setTimeout(() => this.refreshVast(), 3000);
    } catch (e) {
      this.log('error', `重启实例 ${id} 失败：${e.message}`);
      throw e;
    } finally { this.busy.delete(id); }
  }

  // 读取机器日志（vast request_logs）；同一台 3 分钟内只自动抓一次，手动查看 30 秒内只抓一次
  async fetchLogs(id, manual = true) {
    id = String(id);
    const cur = this.rigLogs.get(id);
    if (cur && Date.now() - cur.t < (manual ? 30_000 : 3 * MIN)) return cur;
    // tail 给大一点：v6/v7 的 stats 块每个约 100 行，300 行只够看到最后一个的半截
    const text = String(await this.vast.logs(id, 2000) || '');
    const v = { t: Date.now(), text: text.slice(-20000) };
    this.rigLogs.set(id, v);
    return v;
  }

  // 从日志里挑最能说明问题的一行：报错 > 矿工退出 > 最后一条 [prl] 进度
  logHint(id) {
    const v = this.rigLogs.get(String(id));
    if (!v || !v.text) return '';
    const lines = v.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find(l => /error|fail|denied|not found|cannot|unable|refused|timed out|exception|CUDA/i.test(l) && !/^\[prl\].*download /.test(l));
    const prl = [...lines].reverse().find(l => l.startsWith('[prl]'));
    return (err || prl || '').slice(0, 160);
  }

  async destroy(id, reason, blacklistMin = 0) {
    id = String(id);
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const inst = this.rawInstances.find(i => String(i.id) === id);
      await this.vast.destroy(id);
      if (blacklistMin && inst?.machine_id) this.st.blacklist[inst.machine_id] = { until: Date.now() + blacklistMin * MIN, reason };
      // 台账定终局（要在删 managed 之前：租约里有出价/份额等细节）
      const closed = this.closeLeaseFor(id, { reason });
      // 房东收回（不是价格问题）→ 计入房东统计，必要时拉黑整个房东的已知机器
      if (closed && closed.endReason === 'host_reclaim') this.recordHostReclaim(closed, inst);
      delete this.st.managed[id];
      // 竞价被收回 → 进入冷静期，别立刻再去同一个市场抢
      if (/竞价被抢占|竞价被收回/.test(reason)) {
        this.preemptCooldownUntil = Date.now() + (this.cfg.preemptCooldownMin || 5) * MIN;
      }
      this.save();
      this.log('warn', `已退租实例 ${id}（${inst ? `${inst.num_gpus}×${inst.gpu_name}` : ''}）：${reason}`);
      setTimeout(() => this.refreshVast(), 2000);
    } catch (e) {
      // 404 = 平台已经收走了（竞价被收回后常见）：这不是失败，只是本地记录没清。
      // 当成失败会让巡检每小时报一次假异常，也让人误以为退租链路坏了。
      if (e.status === 404) {
        this.closeLeaseFor(id, { reason: '平台侧已不存在（此前已被收回）' });
        delete this.st.managed[id];
        this.save();
        this.log('info', `实例 ${id} 在平台侧已不存在（此前已被收回），清理本地记录`);
        return;
      }
      this.log('error', `退租实例 ${id} 失败：${e.message}`);
      throw e;
    } finally { this.busy.delete(id); }
  }

  // ---------- 设置 ----------
  updateConfig(patch) {
    const next = { ...this.cfg };
    const num = (k, min, max) => {
      if (patch[k] === undefined || patch[k] === '') return;
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`「${k}」应在 ${min}~${max} 之间`);
      next[k] = v;
    };
    num('targetProfitPct', -50, 1000); num('stopLossPct', -100, 1000); num('maxInstances', 0, 200);
    num('maxHourlySpend', 0, 1000); num('minBalanceReserve', 0, 100000); num('stopLossMinutes', 1, 1440);
    num('bootTimeoutMinutes', 5, 120); num('hashLowPct', 30, 99); num('minerStartTimeoutMinutes', 3, 60); num('minRunwayHours', 1, 720); num('minReliability', 0, 1); num('minInetDown', 0, 100000);
    num('maxGpusPerMachine', 1, 16); num('minCuda', 0, 20); num('disk', 8, 200); num('scanIntervalSec', 60, 3600); num('scanRows', 20, 1000);
    num('failoverMinutes', 2, 60);
    num('spotBidFactor', 0.1, 1.5); // 允许 >1：出价可以高于收入（负 ROI），用于测「加价能否站住」
    num('spotBidBuffer', 0, 1); num('spotBidMultiplier', 1, 3); num('spotBidFloorRatio', 0, 1);
    num('rentMinIntervalMin', 1, 180); num('maxRentsPerHour', 1, 20); num('preemptCooldownMin', 0, 120);
    num('maxBidRaises', 0, 10);   // 0 = 不追价（默认）；>0 才允许被顶后加价保活
    num('dailyFailBudget', 0, 100); num('minBidStablePct', 0, 100);
    num('cruiseScanRows', 20, 200); num('windowScanRows', 20, 1000); num('chg6hPct', 1, 100); num('stairRatio', 0.5, 5); num('offerCacheMaxMin', 5, 240);
    if (patch.venueGuard !== undefined) {
      const v = patch.venueGuard;
      if (v === null) next.venueGuard = null;
      else if (typeof v !== 'object') throw new Error('「venueGuard」必须是对象或 null');
      else {
        const out = { ...(next.venueGuard || {}) };
        if (v.enabled !== undefined) out.enabled = !!v.enabled;
        if (v.inventoryCapPrl !== undefined) {
          const n = Number(v.inventoryCapPrl);
          if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('「venueGuard.inventoryCapPrl」应在 0~100000 之间');
          out.inventoryCapPrl = n;
        }
        next.venueGuard = out;
      }
    }
    // 实验参数覆盖：只允许挂在 pinned 机器上（作用域收窄），键名与范围都校验
    if (patch.expOverride !== undefined) {
      const o = patch.expOverride;
      if (o === null || o === '') next.expOverride = null;
      else if (typeof o !== 'object') throw new Error('「expOverride」必须是对象或 null');
      else {
        const lim = { targetProfitPct: [-50, 1000], stopLossPct: [-100, 1000], stopLossMinutes: [1, 1440], hashLowPct: [30, 99] };
        const out = {};
        for (const [k, [mn, mx]] of Object.entries(lim)) {
          if (o[k] === undefined || o[k] === '') continue;
          const v = Number(o[k]);
          if (!Number.isFinite(v) || v < mn || v > mx) throw new Error(`「expOverride.${k}」应在 ${mn}~${mx} 之间`);
          out[k] = v;
        }
        const tl = out.targetProfitPct ?? next.targetProfitPct;
        const sl = out.stopLossPct ?? next.stopLossPct;
        if (sl >= tl) throw new Error('expOverride：止损线必须低于目标收益率');
        next.expOverride = Object.keys(out).length ? out : null;
      }
    }
    num('minBalanceStop', 0, 1000); num('maxSourceStaleMin', 5, 1440);
    if (next.stopLossPct >= next.targetProfitPct) throw new Error('止损线必须低于目标收益率，否则会租了马上退');
    for (const k of ['poolUrl', 'image', 'minerArgs', 'proxy']) if (typeof patch[k] === 'string') next[k] = patch[k].trim();
    if (patch.launchMode === 'args' || patch.launchMode === 'ssh') next.launchMode = patch.launchMode;
    for (const k of ['autoRent', 'autoDestroy', 'includeNock', 'runwayGuard', 'failover', 'useSpot']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    if (typeof patch.includeNock === 'string') next.includeNock = patch.includeNock === 'true';
    if (typeof patch.nockAddress === 'string') {
      const n = patch.nockAddress.trim();
      if (n && !P.validNockAddress(n)) throw new Error('NOCK 地址格式不对（应为 Nockchain 钱包里的 base58 地址）');
      next.nockAddress = n;
    }
    if (typeof patch.wallet === 'string' && patch.wallet.trim() !== next.wallet) {
      const w = patch.wallet.trim();
      if (w && !P.validWallet(w)) throw new Error('钱包地址校验失败，请从 Pearl 钱包里复制完整地址');
      next.wallet = w;
    }
    if (typeof patch.kryptexWallet === 'string' && patch.kryptexWallet.trim() !== next.kryptexWallet) {
      const w = patch.kryptexWallet.trim();
      if (w && !P.validWallet(w)) throw new Error('Kryptex 钱包地址校验失败，请从 Pearl 钱包里复制完整地址（prl1 开头）');
      next.kryptexWallet = w;
    }
    if (typeof patch.revenueSource === 'string') {
      const ok = ['min', 'median', 'pearlhash', 'kryptex', 'whattomine', 'max'];
      if (!ok.includes(patch.revenueSource)) throw new Error(`revenueSource 只能是 ${ok.join(' / ')}`);
      next.revenueSource = patch.revenueSource;
    }
    if (typeof patch.defaultPool === 'string') {
      if (!POOLS[patch.defaultPool]) throw new Error('未知矿池');
      next.defaultPool = patch.defaultPool;
    }
    const walletOf = p => p === 'kryptex' ? next.kryptexWallet : next.wallet;
    if (!P.validWallet(walletOf(next.defaultPool))) {
      // 默认矿池的钱包被清空了：自动改用另一个填了钱包的矿池
      const alt = POOL_IDS.find(p => P.validWallet(walletOf(p)));
      if (alt && (patch.defaultPool === undefined || patch.defaultPool === this.cfg.defaultPool)) next.defaultPool = alt;
      else if (alt || patch.defaultPool !== undefined) throw new Error(`要把 ${poolName(next.defaultPool)} 设为默认矿池，先填它的钱包地址`);
    }
    if (typeof patch.vastApiKey === 'string' && patch.vastApiKey.trim() && !patch.vastApiKey.includes('•')) {
      next.vastApiKey = patch.vastApiKey.trim();
    }
    if (next.minerArgs && /[;&|`$<>\n]/.test(next.minerArgs)) throw new Error('矿工额外参数里不能有特殊符号');
    const changes = [];
    if (next.useSpot !== this.cfg.useSpot) changes.push(next.useSpot ? '开启竞价实例（可被抢占）' : '关闭竞价实例，只用按需实例');
    if (next.autoRent !== this.cfg.autoRent) changes.push(next.autoRent ? '开启自动租用' : '关闭自动租用');
    if (next.autoDestroy !== this.cfg.autoDestroy) changes.push(next.autoDestroy ? '开启自动退租' : '关闭自动退租');
    if (next.runwayGuard !== this.cfg.runwayGuard) changes.push(next.runwayGuard ? `开启续航保护（${next.minRunwayHours} 小时）` : '关闭续航保护');
    if (next.targetProfitPct !== this.cfg.targetProfitPct) changes.push(`目标收益率 ${next.targetProfitPct}%`);
    if (next.defaultPool !== this.cfg.defaultPool) changes.push(`默认矿池改为 ${poolName(next.defaultPool)}（之后新租的机器先挖它）`);
    if (next.wallet !== this.cfg.wallet) changes.push(`Pearlhash 钱包${next.wallet ? '已更新' : '已清空'}`);
    if (next.kryptexWallet !== this.cfg.kryptexWallet) changes.push(`Kryptex 钱包${next.kryptexWallet ? '已更新' : '已清空'}`);
    if (next.failover !== this.cfg.failover) changes.push(next.failover ? '开启矿池故障自动切换' : '关闭矿池故障自动切换');
    if (next.vastApiKey !== this.cfg.vastApiKey) changes.push('更新 API Key');
    const proxyChanged = next.proxy !== this.cfg.proxy;
    // 换了钱包：累计值属于旧钱包，重新开始计数，免得把新旧钱包的差额算成收益
    if (next.wallet !== this.cfg.wallet) { const L = this.ledgerOf('pearlhash'); L.prl.last = null; L.nock.last = null; }
    if (next.kryptexWallet !== this.cfg.kryptexWallet) { this.ledgerOf('kryptex').prl.last = null; }
    this.cfg = next;
    saveConfig(next);
    this.vast = new Vast(next.vastApiKey);
    this.log('info', `设置已保存${changes.length ? '：' + changes.join('，') : ''}`);
    if (changes.some(c => c.includes('API Key'))) { this.refreshVast(); this.scan(true); }
    if (changes.some(c => c.includes('Kryptex 钱包'))) { this.kx.earnedAt = 0; this.refreshKryptex().catch(() => {}); }
    if (changes.some(c => c.includes('钱包'))) this.repriceOffers();
    return { restartNeeded: proxyChanged };
  }

  // 钉住/取消钉住：pinned 的实例不会被 ROI 或算力规则退租
  setPinned(id, pinned = true) {
    id = String(id);
    const m = this.st.managed[id];
    if (!m) throw new Error('没有这台实例的托管记录');
    if (pinned) m.pinned = true; else delete m.pinned;
    this.save();
    this.log('info', `实例 ${id} ${pinned ? '已钉住（只做测量，不参与 ROI 淘汰）' : '已取消钉住'}`);
    return { id, pinned: !!m.pinned };
  }

  setAlias(id, name) {
    id = String(id);
    if (name) this.st.aliases[id] = String(name).slice(0, 64); else delete this.st.aliases[id];
    this.samples.delete(String(id));
    this.save();
  }

  // ---------- 汇总 ----------
  summary(list = this.instances()) {
    const active = list.filter(x => x.status === 'running' || x.phase === 'booting' || x.status === 'loading');
    const spendHr = active.reduce((a, x) => a + x.dph, 0);
    // 有实测算力用实测；部署中 / 未匹配矿工的机器用预期算力（面板上标注「含预估」）
    const estimated = active.filter(x => !(x.avgHs > 0) && (x.phase === 'booting' || x.phase === 'unmatched'));
    const revenueHr = active.reduce((a, x) => a + (x.avgHs > 0 ? x.revenueHr : estimated.includes(x) ? x.expRevenueHr : 0), 0);
    const hs = active.reduce((a, x) => a + (x.avgHs || 0), 0);
    const bal = this.account.vastBalance;
    return {
      count: active.length, mining: active.filter(x => x.phase === 'mining' || x.phase === 'loss').length,
      abnormal: list.filter(x => ['low', 'gpu'].includes(x.health) || ['nohash', 'offline', 'preempted'].includes(x.phase)).length,
      estimatedCount: estimated.length,
      spendHr, revenueHr, profitHr: revenueHr - spendHr,
      roi: spendHr > 0 && revenueHr > 0 ? (revenueHr - spendHr) / spendHr * 100 : null,
      totalHs: hs,
      prlPerDay: this.market.price ? revenueHr * 24 / this.market.price : 0,
      runwayHours: bal !== null && spendHr > 0 ? bal / spendHr : null,
    };
  }

  publicConfig() {
    const c = { ...this.cfg };
    c.vastApiKey = c.vastApiKey ? `${c.vastApiKey.slice(0, 4)}••••••${c.vastApiKey.slice(-4)}` : '';
    c.hasApiKey = !!this.cfg.vastApiKey;
    c.walletValid = P.validWallet(this.cfg.wallet);
    c.kryptexWalletValid = P.validWallet(this.cfg.kryptexWallet);
    c.effectiveDefaultPool = this.defaultPool;
    return c;
  }

  poolsSnapshot(list) {
    const health = this.health || this.poolHealth(list);
    return POOL_IDS.map(p => {
      const rigs = list.filter(x => x.pool === p && (ACTIVE.has(x.status) || x.phase === 'booting'));
      const sum = f => rigs.reduce((a, x) => a + (f(x) || 0), 0);
      const isKx = p === 'kryptex';
      return {
        id: p, name: poolName(p), fee: this.poolFee(p), minerFee: POOLS[p].minerFee || 0, miner: POOLS[p].miner, nock: POOLS[p].nock, perGpu: POOLS[p].perGpu, site: POOLS[p].site,
        wallet: this.walletFor(p) || '', configured: this.poolConfigured(p), isDefault: this.defaultPool === p,
        apiOk: this.poolConfigured(p) ? this.poolDataOk(p) : null,
        apiError: isKx ? this.kx.error : (this.workersOk ? null : this.market.error),
        poolHs: isKx ? this.kx.info?.poolHs ?? null : this.market.poolHs,
        rigs: rigs.length, hs: sum(x => x.avgHs), spendHr: sum(x => x.dph), revenueHr: sum(x => x.avgHs > 0 ? x.revenueHr : 0),
        usdPerThDay: this.usdHsHrFor(p) * 1e12 * 24,
        pending: isKx ? (this.kx.earned ? { prl: this.kx.earned.balance, paid: this.kx.earned.paid } : null)
          : { prl: this.account.prlPending, nock: this.account.nockPending },
        health: health[p] || null,
      };
    });
  }

  snapshot() {
    this.repriceOffers();
    const list = this.instances();
    const usd = this.usdHsHr;
    const now = Date.now();
    return {
      now,
      config: this.publicConfig(),
      defaults: DEFAULT_CONFIG,
      market: {
        ...this.market, usdPerThDay: usd * 1e12 * 24, fresh: this.marketFresh,
        defaultPool: this.defaultPool, defaultFee: this.effFee(this.defaultPool),
        revenueSource: this.cfg.revenueSource || 'min', sourceName: this.market.sourceName, sources: this.market.sources,
        prlPerThDay: this.market.price ? this.prlRate(this.defaultPool) * 1e12 * 24 / this.market.price : 0,
        nockPerThDay: this.market.price && this.market.nockPerPrl ? this.usdHsHrPrl * 1e12 * 24 / this.market.price * this.market.nockPerPrl : 0,
        nockBonusPct: POOLS[this.defaultPool]?.nock ? this.nockBonus * 100 : 0,
        nockPotentialPct: this.market.nockPerPrl > 0 && this.market.nockPrice > 0 && this.market.price > 0 ? this.market.nockPerPrl * this.market.nockPrice / this.market.price * 100 : null,
      },
      breakEvenPer01: usd > 0 ? 0.1 / (usd * 1e12) : null, // 每 $0.1/h 需要多少 TH/s 才保本
      targetPer01: usd > 0 ? 0.1 * (1 + this.cfg.targetProfitPct / 100) / (usd * 1e12) : null,
      account: this.account,
      summary: this.summary(list),
      budget: this.budget(list),
      preflight: this.preflight(),
      instances: list,
      offers: this.offers.slice(0, 80),
      offerStats: { ...this.offerStats, pausedUntil: this.scanPausedUntil > now ? this.scanPausedUntil : 0, pauseReason: this.scanPausedUntil > now ? this.pauseReason : null,
        usage: this.usageToday(), quota: this.st.searchQuota || null, quotaEst: this.st.quotaEst || null,
        // 额度分桶：巡航 40% / 窗口 60%；巡检要报这两个余量，而不是只说"额度用完了"
        buckets: this.quotaBuckets(), cacheAt: this.st.offersCache?.at || null, cacheRows: this.st.offersCache?.rows?.length || 0 },
      table: this.table,
      history: this.st.history.slice(-288),
      events: this.events.slice(0, 120),
      miners: this.minerManifest?.miners || null,      // 已 pin 的矿工（版本+sha256）
      blacklist: Object.entries(this.st.blacklist).filter(([, v]) => v.until > now).length,
      deployAvg: this.deployAverage(),
      // 租约台账：按型号/按房东的每机时净收益（决策口径，不是 ROI 均值）
      leases: this.leaseReport(),
      window: { ...(this.st.windowState || { active: false }), limits: this.effectiveLimits(), info: this.windowInfo() },
      l1: Object.fromEntries(Object.entries(this.st.l1ByModel || {}).map(([k, v]) => [k, { n: v.n, median: v.median }])),
      l1Host: Object.fromEntries(Object.entries(this.st.l1ByHost || {}).map(([k, v]) => [k, { n: v.n, median: v.median, machines: Object.entries(this.st.machineHost || {}).filter(([, h]) => String(h) === String(k)).map(([mid]) => mid) }])),
      venue: { health: this.st.venueHealth, guard: this.st.venueGuard, inventoryPrl: this.inventoryPrl(), capPrl: this.cfg.venueGuard?.inventoryCapPrl ?? 50 },
      pools: this.poolsSnapshot(list),
      compare: { h24: this.compare(24), d7: this.compare(24 * 7), all: this.compare(null) },
      failovers: this.st.failovers.slice(-10).reverse(),
      // 断网告警：连不上 vast 期间止损/自动退租/算力监控都会暂停，但机器照常计费
      netDown: {
        vastMin: this.vastFailSince ? (now - this.vastFailSince) / MIN : 0,
        pearlMin: this.market.updatedAt ? (now - this.market.updatedAt) / MIN : 0,
      },
    };
  }
}
