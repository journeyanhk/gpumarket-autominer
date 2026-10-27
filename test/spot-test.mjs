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

console.log('— 出价算法边界（利润带公式）');
// 目标 20% → 上限 = 收入/1.2；下限 = 收入×0.7；目标出价 = 入场价×1.25
e.cfg.targetProfitPct = 20; e.cfg.spotBidFloorRatio = 0.7; e.cfg.spotBidMultiplier = 1.25;
ok(e.bidPrice(0.30, 0) === 0.21, `入场价 0 → 按下限 $${e.bidPrice(0.30, 0)}（收入×0.7）`);
ok(e.bidPrice(0.30, 0.10) === 0.21, `入场价×1.25 低于下限 → 仍出 $${e.bidPrice(0.30, 0.10)}`);
ok(e.bidPrice(0.30, 0.19) === 0.2375, `入场价×1.25 落在带内 → 出 $${e.bidPrice(0.30, 0.19)}`);
ok(e.bidPrice(0.30, 0.25) === null, '入场价×1.25 超过利润上限 → 不租（不把利润让给房东）');
e.cfg.targetProfitPct = 12;
ok(Math.abs(e.bidPrice(0.30, 0.19) - 0.2375) < 1e-9, '目标 12% 时上限更宽，出价仍按 1.25 倍');
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

console.log('— 出价系数可以 >1（负 ROI 实验）');
ok(e.updateConfig({ spotBidFactor: 1.05 }).restartNeeded === false, 'factor=1.05 被接受（允许高于收入出价）');
ok((() => { try { e.updateConfig({ spotBidFactor: 1.6 }); return false; } catch { return true; } })(), 'factor=1.6 越界被拒');
// 想出价高于收入（负 ROI）只能靠负目标：上限 = 收入/(1+目标)
e.cfg.targetProfitPct = -5; e.cfg.spotBidFloorRatio = 0.7; e.cfg.spotBidMultiplier = 1.25;
const bidOver = e.bidPrice(0.10, 0.0842);  // 入场价 1.25 倍刚好触到上限
ok(Math.abs(bidOver - 0.1053) < 1e-3, `目标 −5%、入场 $0.10 → 出价 $${bidOver}（高于收入，ROI −5%）`);
e.cfg.targetProfitPct = 0; e.cfg.spotBidFactor = 0.75;
e.updateConfig({ spotBidFactor: 0.75, targetProfitPct: 0, stopLossPct: -20 }); // 一起改回：止损必须 < 目标

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

console.log('— 刚租下的状态噪音不能判成抢占（实测误杀 2×3070）');
e.offers = []; await e.scan(true);
const pickG = e.offers.filter(o => !o.spotSkip && o.roi !== null && o.roi >= 30)[0];
e.lastRentAt = 0;
const idG = await e.rent(pickG, 'manual');
await e.refreshVast();
// 刚租下 30 秒：intended 短暂变 stopped、actual 还是 loading
e.st.managed[idG].rentedAt = Date.now() - 0.5 * MIN;
globalThis.__instanceStatus(idG, 'loading', 'stopped');
await e.refreshVast();
let xG = e.instances().find(i => i.id === String(idG));
ok(xG?.phase !== 'preempted', `租下 30 秒 + intended=stopped + actual=loading → phase=${xG?.phase}（不能判抢占）`);
// 4 分钟后仍是这个组合 → 才是真的被收回
e.st.managed[idG].rentedAt = Date.now() - 4 * MIN;
await e.refreshVast();
xG = e.instances().find(i => i.id === String(idG));
ok(xG?.phase === 'preempted', `同样的组合但已过 3 分钟 → phase=${xG?.phase}（这才算收回）`);
delete e.st.managed[idG];

console.log('— 租用节流：抢占冷静期 / 最小间隔 / 每小时上限');
{
  const g = new Engine(); g.log = () => {};
  g.cfg.rentMinIntervalMin = 10; g.cfg.maxRentsPerHour = 3; g.cfg.preemptCooldownMin = 5;
  g.rentTimes = []; g.preemptCooldownUntil = 0;
  ok(g.rentAllowed().ok === true, '干净状态下允许租');
  g.preemptCooldownUntil = Date.now() + 3 * MIN;
  ok(g.rentAllowed().ok === false && /冷静期/.test(g.rentAllowed().why), '竞价被收回后进入冷静期（不再立刻补）');
  g.preemptCooldownUntil = 0;
  g.rentTimes = [Date.now() - 2 * MIN];
  ok(g.rentAllowed().ok === false && /不足 10 分钟/.test(g.rentAllowed().why), '距上次租用不足最小间隔 → 拦');
  g.rentTimes = [Date.now() - 20 * MIN, Date.now() - 15 * MIN, Date.now() - 11 * MIN];
  ok(g.rentAllowed().ok === false && /本小时已租 3 台/.test(g.rentAllowed().why), '每小时上限 3 台 → 拦');
  g.rentTimes = [Date.now() - 70 * MIN];
  ok(g.rentAllowed().ok === true, '超过 1 小时的旧记录不再计数');
}

console.log('— 平台 stop：actual 还是 created（实测确认的组合）');
e.offers = []; await e.scan(true);
const pickD = e.offers.filter(o => !o.spotSkip && o.roi !== null && o.roi >= 30)[0];
e.lastRentAt = 0;
const idD = await e.rent(pickD, 'manual');
await e.refreshVast();
e.st.managed[idD].rentedAt = Date.now() - 4 * MIN;   // 新规则：intended=stopped 要在租下 3 分钟后才算
globalThis.__instanceStatus(idD, 'created', 'stopped', 'Successfully loaded image');
await e.refreshVast();
x = e.instances().find(i => i.id === String(idD));
ok(x?.phase === 'preempted', `intended=stopped + actual=created → phase=${x?.phase}（否则永远没有分支去销毁它，存储费一直计）`);
await e.decide();
ok(e.st.managed[idD]?.preemptedAt > 0, '进入 5 分钟销毁倒计时');
e.st.managed[idD].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[idD], '已销毁，不再收存储费');

console.log('— 抖动不能重置抢占计时（实测 bug：5 分钟销毁永不触发）');
e.offers = []; await e.scan(true);
const pickE = e.offers.filter(o => !o.spotSkip && o.roi !== null && o.roi >= 30)[0];
e.lastRentAt = 0;
const idE = await e.rent(pickE, 'manual');
await e.refreshVast();
globalThis.__preempt(idE);
await e.refreshVast();
await e.decide();
ok(e.st.managed[idE]?.preemptedAt > 0, '检测到抢占并开始计时');
const t0 = e.st.managed[idE].preemptedAt;
// 宿主把容器拉起来（但没有算力）：计时必须保留
globalThis.__instanceStatus(idE, 'running', 'running');
await e.refreshVast();
ok(e.st.managed[idE]?.preemptedAt === t0, '短暂 running 不清计时（清了下一次抖动就白等 5 分钟）');
// 再抖回 exited：计时仍是旧的，且应立刻销毁
globalThis.__instanceStatus(idE, 'exited', 'running');
await e.refreshVast();
e.st.managed[idE].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[idE], '计时已过 → 立刻销毁（不用再等 5 分钟）');

console.log('— 矿池旧算力不能清掉抢占计时（实测第二次踩坑）');
e.offers = []; await e.scan(true);
const pickF = e.offers.filter(o => !o.spotSkip && o.roi !== null && o.roi >= 30)[0];
e.lastRentAt = 0;
const idF = await e.rent(pickF, 'manual');
await e.refreshVast();
globalThis.__preempt(idF);
await e.refreshVast();
await e.decide();
const tF = e.st.managed[idF]?.preemptedAt;
ok(tF > 0, '开始计时');
// 实例已被收回（exited），但矿池仍有旧算力样本：计时不能清
e.workers.set('v' + idF, { hs: 130e12, gpus: [{ name: 'RTX 3090', hs: 130e12 }] });
e.workersOk = true;
e.recordSamples();
ok(e.st.managed[idF]?.preemptedAt === tF, '实例已 exited 时，矿池报的旧算力不清计时');
// 实例真的回到 running：才清（先 refreshVast 让 rawInstances 反映新状态）
globalThis.__instanceStatus(idF, 'running', 'running');
await e.refreshVast();
e.recordSamples();
ok(!e.st.managed[idF]?.preemptedAt, '实例回到 running 且矿池有算力 → 清计时（真恢复）');
delete e.st.managed[idF];

console.log('— 钉住的测量锚点不参与 ROI 淘汰');
e.offers = []; await e.scan(true);
const pickJ = e.offers.filter(o => !o.spotSkip && o.roi !== null)[0];
e.lastRentAt = 0; e.rentCooldownUntil = 0;
const idJ = await e.rent(pickJ, 'manual');
await e.refreshVast();
globalThis.__instanceStatus(idJ, 'running');
await e.refreshVast();
e.setPinned(idJ, true);
const mJ = e.st.managed[idJ];
mJ.hashAt = Date.now() - 60 * MIN;
e.everHashed.add(String(idJ));
const realInstancesJ = e.instances.bind(e);
e.instances = () => realInstancesJ().map(i => i.id === String(idJ)
  ? { ...i, phase: 'mining', roi: -40, health: 'low', hashRatio: 0.5, firstHashAt: Date.now() - 60 * MIN }
  : i);
await e.autoDestroy(e.instances());
ok(e.st.managed[idJ]?.pinned === true, 'pinned 标记仍然存在（ROI −40%、算力 50% 也没被退租）');
e.setPinned(idJ, false);
await e.autoDestroy(e.instances());
ok(!e.st.managed[idJ], '取消钉住后，ROI −40% 立刻按止损退租');
e.instances = realInstancesJ;

console.log('— 台数上限要算上"抢占待销毁"');
{
  const f = new Engine(); f.log = () => {};
  f.rawInstances = [{ id: 1, actual_status: 'running', label: '', gpu_name: 'RTX 3080', num_gpus: 1, dph_total: 0.1, machine_id: 1 },
                    { id: 2, actual_status: 'exited', label: '', gpu_name: 'RTX 3080', num_gpus: 1, dph_total: 0.1, machine_id: 2 }];
  f.st.managed = { 1: { rentedAt: Date.now(), spot: false, pool: 'kryptex', hashAt: Date.now() }, 2: { rentedAt: Date.now(), spot: true, pool: 'pearlhash', preemptedAt: Date.now() } };
  f.everHashed.add('1'); f.everHashed.add('2');
  const b = f.budget(f.instances());
  ok(b.count === 2, `预算把抢占待销毁的实例也计入台数（count=${b.count}）`);
  ok(b.roomCount === (f.cfg.maxInstances - 2), `剩余额度 = 上限 - 2（roomCount=${b.roomCount}）`);
}

console.log('— 下单异常分类：GPU conflict / 429 都不该拉黑');
e.offers = []; await e.scan(true);
const pickH = e.offers.filter(o => !o.spotSkip && o.roi !== null)[0];
const realRentH = e.vast.rent.bind(e.vast);
e.lastRentAt = 0;
e.vast.rent = async () => { const err = new Error('HTTP 400：GPU conflict: requesting already rented gpus {1}'); err.status = 400; throw err; };
let errH = null;
try { await e.rent(pickH, 'manual'); } catch (x2) { errH = x2; }
ok(errH?.gone === true, 'GPU conflict → 当作"被别人租走"（gone），不重试同一台');
ok(!Object.values(e.st.blacklist).length, 'GPU conflict 不拉黑机器');
e.lastRentAt = 0;
e.vast.rent = async () => { const err = new Error('HTTP 429：API requests too frequent'); err.status = 429; throw err; };
try { await e.rent(pickH, 'manual'); } catch {}
ok(e.rentCooldownUntil > Date.now(), '429 → 设置 5 分钟退避');
ok(!Object.values(e.st.blacklist).length, '429 不拉黑机器（是我们的请求太快）');
e.vast.rent = realRentH;

console.log('— 竞价机算力长期偏低 → 退租（不拉黑）');
e.offers = []; await e.scan(true);
const pickI = e.offers.filter(o => !o.spotSkip && o.roi !== null)[0];
e.lastRentAt = 0; e.rentCooldownUntil = 0;
const idI = await e.rent(pickI, 'manual');
await e.refreshVast();
globalThis.__instanceStatus(idI, 'running');
await e.refreshVast();
const mI = e.st.managed[idI];
mI.hashAt = Date.now() - 40 * MIN;
e.everHashed.add(String(idI));
// 伪造"算力只有预期一半"的健康判定
const realInstances = e.instances.bind(e);
e.instances = () => realInstances().map(i => i.id === String(idI)
  ? { ...i, phase: 'mining', health: 'low', hashRatio: 0.56, firstHashAt: Date.now() - 40 * MIN, spot: true }
  : i);
await e.autoDestroy(e.instances());
ok(!e.st.managed[idI], '竞价机算力只有 56% 且已出算力 40 分钟 → 已退租');
ok(!Object.values(e.st.blacklist).length, '退租但不拉黑机器（是卡的问题，可以再试别的机器）');
e.instances = realInstances;

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