// 核心引擎：行情 → 市场扫描 → 自动租用部署 → 实时利润监控 → 自动退租
import { Vast } from './vast.js';
import * as P from './pearl.js';
import { gpuKey, hashrateTable } from './gpus.js';
import { buildOnstart, workerName, SCRIPT_VERSION } from './onstart.js';
import { POOLS, POOL_IDS, poolName, minerTarget, fetchKryptexInfo, fetchKryptexWorkers, fetchKryptexEarned } from './pools.js';
import { loadConfig, saveConfig, loadState, saveState, appendLog, DEFAULT_CONFIG } from './store.js';
import { loadManifest } from './miners.js';

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
    this.scanPausedUntil = this.st.scanPause?.until > Date.now() ? this.st.scanPause.until : 0; // 额度暂停跨重启保留
    this.pauseReason = this.scanPausedUntil ? this.st.scanPause.reason : null;
    this.lastRentAt = 0;
    this.busy = new Set();
    this.everHashed = new Set();
    this.rigLogs = new Map(); // instanceId -> { t, text }
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
    return P.usdPerHsHour({ usd: m.price, networkHs: m.networkHs, blockTime: m.blockTime, reward: m.reward, fee: this.effFee(pool) });
  }
  // 竞价出价：收入 × 系数，但绝不超过「按目标收益率仍然划算」的上限；
  // 入场价已经高于上限的机器直接返回 null（宁可不租，也不在亏损区抢机器）。
  bidPrice(revenueHr, minBid = 0) {
    if (!(revenueHr > 0)) return null;
    const maxPay = revenueHr / (1 + this.cfg.targetProfitPct / 100);
    // 不能贴着 min_bid 出：那是最低价，任何一个更高出价都会把你顶掉（实测 1 秒）。
    const buffer = Math.min(1, Math.max(0, Number(this.cfg.spotBidBuffer ?? 0.1)));
    const floor = minBid * (1 + buffer);
    if (floor > maxPay) return null; // 加完缓冲仍超过目标 ROI 的上限 → 不租
    const want = revenueHr * Math.min(0.99, Math.max(0.1, Number(this.cfg.spotBidFactor) || 0.75));
    return +Math.min(maxPay, Math.max(floor, want)).toFixed(4);
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
    this.log('info', '程序启动');
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
    if (price.status === 'fulfilled' && chain.status === 'fulfilled' && this.market.reward) this.market.updatedAt = Date.now();
    // 偶尔一次超时很正常（数据 15 秒后会再拉），连续 3 次失败才记日志，恢复时再记一条
    this._mktFail = errs.length ? (this._mktFail || 0) + 1 : 0;
    if (this._mktFail === 3) this.log('warn', `Pearlhash 连续 3 次获取失败：${errs.join('；')}（网络不稳定时可在设置里填代理）`);
    if (!errs.length && this._mktFailLogged) this.log('info', 'Pearlhash 数据已恢复');
    this._mktFailLogged = this._mktFail >= 3 || (this._mktFailLogged && errs.length > 0);
    this.market.error = errs.length ? errs.join('；') : null;
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
  track(pool, coin, value) {
    if (!Number.isFinite(value)) return;
    const c = this.ledgerOf(pool)[coin];
    if (c.last != null && value > c.last) c.acc += value - c.last;
    c.last = value;
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
        if (m?.preemptedAt && i.actual_status === 'running') { delete m.preemptedAt; this.save(); }
        if (m?.spot) this.noteSpotStatus(i, m);
      }
      // 已不存在的托管实例清理掉
      const ids = new Set(this.rawInstances.map(i => String(i.id)));
      for (const id of Object.keys(this.st.managed)) {
        if (!ids.has(id) && Date.now() - this.st.managed[id].rentedAt > 3 * MIN) {
          this.log('warn', `实例 ${id} 已不在 vast 列表中（可能被手动销毁或被平台回收）`);
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
      const firstHashAt = arr.find(s => s.hs > 0 && s.t > resetAt)?.t ?? null;
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
      else if (m?.spot && (i.intended_status === 'stopped' || (i.actual_status && !ACTIVE.has(i.actual_status)))) phase = 'preempted';
      else if (!ACTIVE.has(i.actual_status) && i.actual_status) phase = i.intended_status === 'stopped' ? 'stopped' : 'offline';
      else if (!everSeen) phase = managed ? 'booting' : 'unmatched';
      else if (useHs === 0) phase = 'nohash';
      else if (roi !== null && roi < this.cfg.stopLossPct) phase = 'loss';
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
        spot: !!m?.spot, listDph: m?.listDph ?? null,
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
    return u;
  }

  // 当前应该隔多久扫一次（毫秒）以及原因
  scanPlan() {
    const now = Date.now();
    const base = this.cfg.scanIntervalSec * 1000;
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
    // 额度分摊：vast 告诉了剩余额度就用它；否则用自己学到的每日额度
    const msLeft = this.nextUtcMidnight() - now;
    let remaining = null, src = '';
    if (this.st.quotaEst) { remaining = Math.max(0, this.st.quotaEst * 0.9 - this.usageToday().rows); src = '按学到的每日额度'; }
    if (remaining != null) {
      const scansLeft = Math.floor(remaining / rows) - 1; // 留一次给手动扫描
      if (scansLeft <= 0) return { interval: msLeft, why: `今日额度快用完（${src}），等 ${new Date(now + msLeft).toLocaleTimeString('zh-CN', { hour12: false })} 重置` };
      const pace = msLeft / scansLeft;
      return { interval: Math.max(base, pace), why: pace > base ? `${src}：剩 ${scansLeft} 次，均匀分摊到重置前` : '' };
    }
    return { interval: base, why: '' };
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
      try { raw = await this.vast.searchOffers(this.cfg, meta, sq.names); }
      catch (e) {
        // 万一 vast 不接受按型号过滤：本次改用全量搜索，之后不再用精准搜索
        if (sq.mode !== 'focused' || e.status === 429 || !(e.status >= 400 && e.status < 500)) throw e;
        this.focusedOff = true;
        this.log('warn', `vast 不接受按型号精准搜索（${e.message.slice(0, 80)}），改回全量搜索`);
        sq = { mode: 'broad' };
        raw = await this.vast.searchOffers(this.cfg, meta);
      }
      this.learnVastNames(raw);
      const u = this.usageToday();
      u.requests++; u.rows += raw.length;
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
          this.log('warn', `vast 今日搜索额度已用完（今天本程序搜了 ${u.requests} 次、${u.rows} 条${this.st.quotaEst ? `，估计每日额度约 ${this.st.quotaEst} 条` : ''}），${new Date(until).toLocaleString('zh-CN', { hour12: false })} 恢复。已租机器照常监控`);
        } else {
          this.scanPausedUntil = Date.now() + 2 * MIN;
          this.pauseReason = 'rate';
          this._warnOnce('rate429', 'vast 提示请求太频繁，2 分钟后再扫描');
        }
      } else this.log('error', `扫描 vast 市场失败：${e.message}`);
    }
  }

  // 精准搜索：只搜「有算力数据、按当前币价有可能达到目标收益率」的型号。
  // vast 的型号名要原样匹配，所以从全量搜索结果里学；每 6 次搜索做一次全量，发现新型号
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
    if (ref) { o.th = ref.effective * o.numGpus; o.source = ref.source; o.autoOk = ref.autoOk; }
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
    const usd = this.usdHsHr;
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
    const usd = this.usdHsHr;
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
      const offer = this.priceOffer({
        id: o.id, machineId: o.machine_id, gpuName: o.gpu_name, numGpus: o.num_gpus || 1,
        th: ref.effective * (o.num_gpus || 1), dph: listDph, listDph, bid: null, spotSkip: false,
        spot: this.cfg.useSpot, minBid: Number(o.min_bid ?? o.dph_total) || 0,
        reliability: o.reliability2 ?? o.reliability,
        geolocation: o.geolocation || '', inetDown: o.inet_down, cuda: o.cuda_max_good,
        source: ref.source, autoOk: ref.autoOk,
        blacklisted: bl && bl.until > now ? bl.reason : null,
      }, usd);
      offer.thPer01 = offer.th / (offer.dph / 0.1);
      out.push(offer);
    }
    out.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
    this.offers = out.slice(0, 150);
    this.offerStats = {
      total: raw.length, known, profitable: out.filter(x => x.roi !== null && x.roi >= this.cfg.targetProfitPct).length,
      scannedAt: now, error: null,
    };
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
    if (this.cfg.autoDestroy) await this.autoDestroy(list);
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
      // 0b) 竞价被抢占：stopped 期间磁盘仍计费，别等它自己回来 —— 5 分钟内销毁，且不算机器问题（不拉黑）
      if (x.phase === 'preempted') {
        if (!m.preemptedAt) {
          m.preemptedAt = now; this.save();
          this.log('warn', `实例 ${x.id} 竞价被抢占（stopped，磁盘仍在计费），${PREEMPT_DESTROY_MIN} 分钟内销毁`);
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
      // 3) 止损：实时收益率持续低于止损线（行情数据不新鲜、或出算力不满 10 分钟时不判断）
      if (!this.marketFresh) continue;
      if (!x.firstHashAt || now - x.firstHashAt < (POOLS[x.pool]?.perGpu ? 10 : KX_WARMUP_MIN) * MIN) continue;
      if (x.roi !== null && x.roi < this.cfg.stopLossPct) {
        if (!m.belowSince) { m.belowSince = now; this.save(); this.log('warn', `实例 ${x.id} 收益率 ${x.roi.toFixed(1)}% 跌破止损线 ${this.cfg.stopLossPct}%，开始计时`); }
        else if (now - m.belowSince > this.cfg.stopLossMinutes * MIN) {
          await this.destroy(x.id, `收益率 ${x.roi.toFixed(1)}% 持续 ${this.cfg.stopLossMinutes} 分钟低于止损线 ${this.cfg.stopLossPct}%`, 60);
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
    return why;
  }

  budget(list) {
    const active = list.filter(x => ACTIVE.has(x.status) || x.phase === 'booting');
    const spend = active.reduce((a, x) => a + x.dph, 0);
    return {
      count: active.length, spend,
      roomCount: this.cfg.maxInstances - active.length,
      roomSpend: this.cfg.maxHourlySpend - spend,
      roomBalance: (this.account.vastBalance ?? 0) - this.cfg.minBalanceReserve,
      spendCapByRunway: this.cfg.runwayGuard ? Math.max(0, ((this.account.vastBalance ?? 0) - this.cfg.minBalanceReserve) / this.cfg.minRunwayHours) : null, // null = 续航保护已关闭
    };
  }

  async autoRent(list) {
    if (Date.now() - this.lastRentAt < 60_000) return;
    const why = this.preflight();
    if (why.length) { this._warnOnce('pre', `自动租用暂停：${why.join('、')}`); return; }
    const plan = this.scanPlan();
    if (Date.now() - this.offerStats.scannedAt > Math.min(60 * MIN, Math.max(10 * MIN, (plan.interval || 0) * 2))) return;
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
      o.dph <= b.roomSpend);
    const affordable = candidates.filter(o => b.spend + o.dph <= spendCap);
    if (candidates.length && !affordable.length) {
      this._warnOnce('runway', `余额 $${this.account.vastBalance.toFixed(2)} 只够每小时花 $${spendCap.toFixed(2)}（续航 ${this.cfg.minRunwayHours} 小时），现在已花 $${b.spend.toFixed(2)}/h，停止新租；充值后会自动继续`);
      return;
    }
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
        expectedTh: offer.th, rentedAt: Date.now(), dph: offer.dph, belowSince: null, inetDown: offer.inetDown ?? null,
        spot: !!offer.spot, listDph: offer.listDph ?? null,
        sv: SCRIPT_VERSION, pools: poolIds, pool: def, mode: this.cfg.launchMode === 'args' ? 'args' : 'ssh',
      };
      this.save();
      this.log('success', `${tag}租用 ${offer.numGpus}×${offer.gpuName}（实例 ${id}）${offer.spot ? '竞价出价' : ''}$${offer.dph.toFixed(4)}/h，挖 ${poolName(def)}，预计收益率 ${offer.roi.toFixed(1)}%`);
      setTimeout(() => this.refreshVast(), 3000);
      return id;
    } catch (e) {
      // no_such_ask / not available = 这台机器在扫描后被别人抢先租走了，不是机器的问题，不拉黑
      if (/no_such_ask|not available|unavailable/i.test(e.message)) {
        this.offers = this.offers.filter(o => o.id !== offer.id);
        this.lastRentAt = 0;
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
      // 竞价：扫描到下单之间 min_bid 涨了 → 出价被拒。这是出价问题，不是机器问题，不能拉黑
      if (offer.spot && /bid|price|too low|min_bid/i.test(e.message)) {
        this.offers = this.offers.filter(o => o.id !== offer.id);
        this.lastRentAt = 0;
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
    const text = String(await this.vast.logs(id, 300) || '');
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
      delete this.st.managed[id];
      this.save();
      this.log('warn', `已退租实例 ${id}（${inst ? `${inst.num_gpus}×${inst.gpu_name}` : ''}）：${reason}`);
      setTimeout(() => this.refreshVast(), 2000);
    } catch (e) {
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
    num('failoverMinutes', 2, 60); num('spotBidFactor', 0.1, 1); num('spotBidBuffer', 0, 1);
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
        usage: this.usageToday(), quota: this.st.searchQuota || null, quotaEst: this.st.quotaEst || null },
      table: this.table,
      history: this.st.history.slice(-288),
      events: this.events.slice(0, 120),
      miners: this.minerManifest?.miners || null,      // 已 pin 的矿工（版本+sha256）
      blacklist: Object.entries(this.st.blacklist).filter(([, v]) => v.until > now).length,
      deployAvg: this.deployAverage(),
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
