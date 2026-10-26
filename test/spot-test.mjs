// 竞价（spot）监督逻辑的测试：搜索/定价/下单/被收回/被拒单。
// 全部走 test/mock.mjs，不联网、不花钱。
//
// 这里刻意用「状态注入」而不是只测 stopped：vast 对 outbid 的真实返回组合还没在真机验证过，
// 所以测试要能摆出 stopped / exited / offline 各种组合，证明监督逻辑不会把它们当成「机器坏了」。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href;
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');
fs.writeFileSync('data/config.json', JSON.stringify({
  vastApiKey: 'test-key', wallet: 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4',
  autoRent: false, autoDestroy: true, targetProfitPct: 30, stopLossPct: 0, maxInstances: 3, maxHourlySpend: 1,
  stopLossMinutes: 30, bootTimeoutMinutes: 20, minBalanceReserve: 1,
  useSpot: true, spotBidFactor: 0.75,
}));

const { Engine } = await import(U('src/engine.js'));
const MIN = 60000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const e = new Engine();
const logs = [];
e.log = (lvl, msg) => logs.push(`${lvl} ${msg}`);
await e.refreshMarket(); await e.refreshVast(); await e.scan(true);

console.log('— 搜索与定价');
ok(globalThis.__lastType === 'bid', '开着 useSpot 时搜索用 type=bid（原来写死 on-demand，根本租不到竞价机）');
ok(globalThis.__lastQuery?.min_bid && !globalThis.__lastQuery?.dph_total, 'spot 搜索按 min_bid 过滤，不再用挂牌价 dph_total（review #4）');
const priced = e.offers.filter(o => !o.spotSkip);
ok(priced.length > 0 && priced.every(o => o.spot && o.bid > 0), `扫到 ${e.offers.length} 台，其中 ${priced.length} 台可出价`);
ok(priced.every(o => Math.abs(o.dph - o.bid) < 1e-9), 'ROI 用的是「出价」，不是挂牌价');
ok(priced.every(o => o.bid <= o.revenueHr / 1.3 + 1e-6), '出价不超过「目标收益率 30%」允许的上限（rev/1.3）');
ok(priced.every(o => o.listDph >= o.bid), '挂牌价 ≥ 出价（挂牌价只是展示）');
ok(e.offers.filter(o => o.spotSkip).every(o => o.bid === null && o.roi === null), '入场价高于上限的机器保留但不参与出价（不再从列表里消失）');

console.log('— 出价算法边界');
ok(e.bidPrice(0.30, 0) === 0.225, `收入 $0.30/h、系数 0.75 → 出价 $${e.bidPrice(0.30, 0)}`);
ok(e.bidPrice(0.30, 0.5) === null, '入场价高于「目标 ROI 允许的上限」→ 不出价（宁可不租）');
e.cfg.spotBidFactor = 0.5;
ok(e.bidPrice(0.30, 0.20) === 0.22, `入场价 $0.20 + 10% 缓冲 = $${e.bidPrice(0.30, 0.20)}（贴着地板会被秒顶）`);
ok(e.bidPrice(0.30, 0.24) === null, '加完缓冲超过目标 ROI 上限 → 不租');
e.cfg.spotBidFactor = 0.75;
e.cfg.targetProfitPct = 100;
ok(e.bidPrice(0.30, 0) === 0.15, `目标 100% 时上限收紧到 rev/2（$${e.bidPrice(0.30, 0)}）`);
e.cfg.targetProfitPct = 30;

console.log('— 状态不同的机器不会在两次 tick 之间闪烁（review #7）');
const scannedOffers = e.offers;
const synth = { id: 999001, machineId: 999, gpuName: 'RTX 4090', numGpus: 1, th: 0, dph: 10, listDph: 10, spot: true, minBid: 10, bid: null, spotSkip: false, roi: null };
e.priceOffer(synth, e.usdHsHr);
ok(synth.spotSkip === true && synth.bid === null && synth.roi === null, 'priceOffer：入场价太高 → spotSkip + roi=null');
e.offers = [synth];
e.repriceOffers();
ok(e.offers.length === 1 && e.offers[0].spotSkip, 'repriceOffers 也保留它（不会上一 tick 有、这一 tick 没）');
e.offers = scannedOffers; // 还原扫描结果，后面还要真的下单

console.log('— 下单带出价');
const pick = e.offers.filter(o => o.roi !== null && o.roi >= 30 && o.bid < o.listDph - 1e-6)[0]
  || e.offers.filter(o => o.roi !== null && o.roi >= 30)[0];
let body = null;
const realRent = e.vast.rent.bind(e.vast);
e.vast.rent = async (oid, b) => { body = b; return realRent(oid, b); };
e.lastRentAt = 0;
const idA = await e.rent(pick, 'manual');
ok(body.price === pick.bid, `下单 price=${body.price} = 出价（挂牌价 ${pick.listDph}）`);
ok(e.st.managed[idA]?.spot === true, '托管记录标了 spot');
ok(logs.some(l => /竞价出价/.test(l)), '日志区分了竞价租用');

console.log('— 开机阶段被收回（还没出算力，review #1）');
const nBoot = logs.length;
await e.refreshVast();
ok(logs.slice(nBoot).some(l => /spot 状态变化/.test(l)), '记录了 spot 实例的原始状态元组（真机语义待验证，review #2b）');
let x = e.instances().find(i => i.id === String(idA));
ok(x?.phase === 'booting', `租下时 phase=${x?.phase}`);
globalThis.__preempt(idA);
await e.refreshVast();
x = e.instances().find(i => i.id === String(idA));
ok(x?.phase === 'preempted', `被收回后 phase=${x?.phase}（不能走 booting 超时，否则白付 20 分钟磁盘费还拉黑 24h）`);
await e.decide();
ok(e.st.managed[idA]?.preemptedAt > 0, '开始 5 分钟计时');
ok(!Object.values(e.st.blacklist).length, '还没销毁时也不该提前拉黑');
e.st.managed[idA].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[idA], '超过 5 分钟 → 已销毁');
ok(!Object.values(e.st.blacklist).length, '开机阶段被抢不拉黑（黑名单必须为空）');

console.log('— vast 返回 exited（状态组合未知，review #2）');
e.offers = []; await e.scan(true);
const pickB = e.offers.filter(o => !o.spotSkip && o.roi >= 30)[0];
e.lastRentAt = 0;
const idB = await e.rent(pickB, 'manual');
await e.refreshVast();
globalThis.__instanceStatus(idB, 'running');
await e.refreshVast();
e.everHashed.add(String(idB));
e.st.managed[idB].hashAt = Date.now() - 20 * MIN;
e.st.managed[idB].runningAt = Date.now() - 30 * MIN;
const nExit = logs.length;
globalThis.__instanceStatus(idB, 'exited', 'running', 'bid too low');
await e.refreshVast();
ok(logs.slice(nExit).some(l => /spot 状态变化.*exited/.test(l)), '状态元组变化写进了事件日志');
x = e.instances().find(i => i.id === String(idB));
ok(x?.phase === 'preempted', `actual_status=exited → phase=${x?.phase}（不是 offline）`);
e.st.managed[idB].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[idB], 'exited 的 spot 实例同样 5 分钟内销毁');
ok(!Object.values(e.st.blacklist).length, 'exited 不拉黑机器（不是机器坏了）');

console.log('— 平台 stop：actual 还是 created（实测确认的组合）');
e.offers = []; await e.scan(true);
const pickD = e.offers.filter(o => !o.spotSkip && o.roi !== null && o.roi >= 30)[0];
e.lastRentAt = 0;
const idD = await e.rent(pickD, 'manual');
await e.refreshVast();
globalThis.__instanceStatus(idD, 'created', 'stopped', 'Successfully loaded image');
await e.refreshVast();
x = e.instances().find(i => i.id === String(idD));
ok(x?.phase === 'preempted', `intended=stopped + actual=created → phase=${x?.phase}（否则永远没有分支去销毁它，存储费一直计）`);
await e.decide();
ok(e.st.managed[idD]?.preemptedAt > 0, '进入 5 分钟销毁倒计时');
e.st.managed[idD].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[idD], '已销毁，不再收存储费');

console.log('— 出价被拒（min_bid 在下单前涨了，review #3）');
e.offers = []; await e.scan(true);
const pickC = e.offers.filter(o => !o.spotSkip && o.roi >= 30)[0];
e.lastRentAt = 0;
globalThis.__bidError = true;
let err = null;
try { await e.rent(pickC, 'manual'); } catch (x2) { err = x2; }
ok(err && err.gone === true && /最低价/.test(err.message), `下单被拒 → 抛「出价低于最低价」（${err?.message}）`);
ok(!Object.values(e.st.blacklist).length, '出价问题是出价问题，不拉黑机器');
ok(!e.offers.some(o => o.id === pickC.id), '这台机器从列表里移除，换下一台');
ok(e.lastRentAt === 0, '不占用 60 秒的租用冷却');

console.log('— 关掉竞价就回到按需');
e.updateConfig({ useSpot: false });
await e.scan(true);
ok(globalThis.__lastType === 'on-demand', '关闭后搜索回到 on-demand');
ok(globalThis.__lastQuery?.dph_total && !globalThis.__lastQuery?.min_bid, '按需模式按挂牌价过滤');
ok(e.offers.every(o => o.spot === false && o.dph === o.listDph), '按需模式的 ROI 用挂牌价计算');
const cfg = e.publicConfig();
ok(cfg.useSpot === false && cfg.spotBidFactor === 0.75, '面板能拿到 useSpot / spotBidFactor');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);