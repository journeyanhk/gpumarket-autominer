// 决策逻辑测试（由 test/run.mjs 在临时目录里运行，不会碰你的 data 文件夹）
// 决策逻辑测试：伪造时间与样本，验证退租/止损/租用规则
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href; // Windows 路径也能 import
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');
fs.writeFileSync('data/config.json', JSON.stringify({
  vastApiKey: 'test-key', wallet: 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4',
  autoRent: true, autoDestroy: true, targetProfitPct: 30, stopLossPct: 0, maxInstances: 3, maxHourlySpend: 0.5,
  stopLossMinutes: 30, bootTimeoutMinutes: 20, minBalanceReserve: 1,
}));
const { Engine } = await import(U('src/engine.js'));
const MIN = 60000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const e = new Engine();
e.log = () => {};
await e.refreshMarket(); await e.refreshWildrig(); await e.refreshVast(); await e.scan(true);
ok(e.marketFresh && e.usdHsHr > 0, '行情就绪');
ok(e.offers.length > 0 && e.offers.every(o => o.th > 0), `扫描到 ${e.offers.length} 个可评估机器`);
ok(!e.offers.some(o => /A100/.test(o.gpuName)), '未知型号（A100）被排除');

// ---- 预算上限：maxHourlySpend=0.5，已有手动 5080 $0.266 → 只剩 $0.234
e.lastRentAt = 0;
await e.decide();
const rented1 = Object.values(e.st.managed)[0];
ok(rented1 && rented1.dph <= 0.234 + 1e-9, `第一次自动租用在剩余预算内（$${rented1?.dph}）`);
ok(!e.offers.find(o => o.id === rented1.offerId && !o.used), '已租的 offer 被标记，不会重复租');

// ---- 60 秒内不会连续租
const n1 = Object.keys(e.st.managed).length;
await e.decide();
ok(Object.keys(e.st.managed).length === n1, '60 秒内不连续下单');

// ---- 币价暴跌后：旧扫描结果不能再触发租用
globalThis.__price = 0.3;
await e.refreshMarket();
e.lastRentAt = 0;
await e.decide();
ok(Object.keys(e.st.managed).length === n1, '币价暴跌后按最新价重算，不再租用');
globalThis.__price = 1.85;
await e.refreshMarket();

// ---- 部署超时：托管实例 25 分钟无算力 → 退租并拉黑机器
await e.refreshVast();
const id1 = Object.keys(e.st.managed)[0];
e.st.managed[id1].rentedAt = Date.now() - 25 * MIN;
e.samples.set(Number(id1), [{ t: Date.now() - 60000, hs: 0 }]);
// 让矿池里看不到它
const realWorkers = e.workers; e.workers = new Map([...realWorkers].filter(([k]) => k !== 'v' + id1));
await e.decide();
ok(!e.st.managed[id1], '部署超时 25 分钟无算力 → 自动退租');
ok(Object.values(e.st.blacklist).some(b => b.reason.includes('部署超时')), '该机器被拉黑 24 小时');

// ---- 手动实例永远不会被自动退
await e.refreshVast();
e.samples.set(10000001, [{ t: Date.now() - 20 * MIN, hs: 0 }]);
await e.decide();
ok(e.rawInstances.some(i => i.id === 10000001), '手动租的 5080 不会被自动退租');

// ---- 止损：构造一台正在挖但亏损的托管机
const inst = { id: 777, label: 'prl-auto-RTX3090', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.2, actual_status: 'running', intended_status: 'running', start_date: Date.now() / 1000 - 3600, machine_id: 4242 };
const fakeList = () => { e.rawInstances = [...e.rawInstances.filter(i => i.id !== 777), inst]; };
fakeList();
e.st.managed['777'] = { rentedAt: Date.now() - 60 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4242, expectedTh: 130 };
const mk = (minAgo, hs) => ({ t: Date.now() - minAgo * MIN, hs });
e.samples.set(777, [mk(14, 130e12), mk(9, 130e12), mk(4, 130e12), mk(0.5, 130e12)]);
e.workers.set('v777', { hs: 130e12, gpus: [{ name: 'RTX 3090', hs: 130e12 }] });
const origRefresh = e.refreshVast.bind(e); e.refreshVast = async () => {};
let x = e.instances().find(i => i.id === '777');
ok(x.roi < 0, `亏损机器收益率 ${x.roi.toFixed(1)}%`);
await e.autoDestroy(e.instances());
ok(e.st.managed['777']?.belowSince > 0, '跌破止损 → 开始计时，但不立即退租');
e.st.managed['777'].belowSince = Date.now() - 31 * MIN;
// 收益回升 → 计时取消
inst.dph_total = 0.1; fakeList();
await e.autoDestroy(e.instances());
ok(e.st.managed['777'] && !e.st.managed['777'].belowSince, '收益率回到止损线以上 → 止损计时取消');
inst.dph_total = 0.2; fakeList();
await e.autoDestroy(e.instances());
e.st.managed['777'].belowSince = Date.now() - 31 * MIN;
let destroyed = null;
e.vast.destroy = async id => { destroyed = id; return { success: true }; };
await e.autoDestroy(e.instances());
ok(destroyed === '777', '持续低于止损线 31 分钟 → 自动退租');

// ---- 刚出算力不满 10 分钟：即使亏损也不判止损
const inst2 = { ...inst, id: 778, machine_id: 4343 };
e.rawInstances.push(inst2);
e.st.managed['778'] = { rentedAt: Date.now() - 8 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4343, expectedTh: 130 };
e.samples.set(778, [mk(3, 0), mk(2, 130e12), mk(1, 130e12)]);
e.workers.set('v778', { hs: 130e12, gpus: [] });
await e.autoDestroy(e.instances());
ok(!e.st.managed['778'].belowSince, '出算力不满 10 分钟不判断止损');
x = e.instances().find(i => i.id === '778');
ok(Math.abs(x.avgHs - 130e12) < 1, '均值不把部署阶段的 0 算进去');

// ---- 掉线：之前有算力、最近 10 分钟连续为 0
const inst3 = { ...inst, id: 779, machine_id: 4444, dph_total: 0.05 };
e.rawInstances.push(inst3);
e.st.managed['779'] = { rentedAt: Date.now() - 60 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4444 };
e.samples.set(779, [mk(14, 130e12), ...Array.from({ length: 22 }, (_, k) => mk(10.5 - k * 0.5, 0))]);
e.workers.delete('v779');
destroyed = null;
await e.autoDestroy(e.instances());
ok(destroyed === '779', '矿工掉线超过 10 分钟 → 自动退租');

// ---- 设置校验
try { e.updateConfig({ stopLossPct: 40, targetProfitPct: 30 }); ok(false, '止损高于目标应被拒绝'); } catch { ok(true, '止损线 ≥ 目标收益率 被拒绝'); }
try { e.updateConfig({ wallet: 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac5' }); ok(false, '错误钱包应被拒绝'); } catch { ok(true, '抄错一位的钱包地址被拒绝'); }
try { e.updateConfig({ minerArgs: '--x; rm -rf /' }); ok(false, '注入应被拒绝'); } catch { ok(true, '矿工参数里的危险符号被拒绝'); }
const pc = e.publicConfig();
ok(!pc.vastApiKey.includes('test-key'), 'API Key 在面板里是打码的');

// ---- NOCK
const P = await import(U('src/pearl.js'));
const ratio = P.nockPerPrl([{ epoch_label: '2026-10-18 09:00:00 UTC .. 2026-10-18 10:00:00 UTC', amount: 0.07068133183781625, share: 0.000004501587452660985 }], [{ epoch_label: '2026-10-18 09:00-10:00', amount: 0.0295, share: 0.000005 }]);
ok(Math.abs(ratio - 0.3758) < 0.001, `NOCK/PRL 比例反推正确（${ratio.toFixed(4)}）`);
e.refreshVast = origRefresh;
await e.refreshMarket();
ok(e.nockBonus === 0, '矿池未登记 NOCK 地址 → NOCK 不计入利润');
globalThis.__nockAddr = 'ArK1pS8pZcG8u8p3Yh6v7Q9nLmWx2Tt4Rr5Ee6Dd7Cc8Bb9Aa1Zz2Yy3Xx4Ww5Vv';
await e.refreshMarket();
const base = e.usdHsHrPrl;
ok(e.nockBonus > 0.003 && e.nockBonus < 0.005, `已登记 → NOCK 加成 ${(e.nockBonus * 100).toFixed(2)}%`);
ok(Math.abs(e.usdHsHr - base * (1 + e.nockBonus)) < 1e-25, '总收益 = PRL × (1 + NOCK 加成)');
e.updateConfig({ includeNock: false });
ok(e.nockBonus === 0, '关闭「计入 NOCK」开关后不计入');
e.updateConfig({ includeNock: true, nockAddress: globalThis.__nockAddr });
let captured = null;
e.vast.rent = async (id, b) => { captured = b; return { success: true, new_contract: 999 }; };
e.lastRentAt = 0; e.offers.forEach(o => (o.used = false));
await e.rent(e.offers.find(o => o.autoOk), 'manual');
ok(captured.onstart.includes('--user prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4@nock=' + globalThis.__nockAddr), '新租机器的矿池用户名带 @nock=地址');
try { e.updateConfig({ nockAddress: 'abc0OIl' }); ok(false, '错误 NOCK 地址应被拒绝'); } catch { ok(true, '错误格式的 NOCK 地址被拒绝'); }
const snap = e.snapshot();
ok(snap.market.nockPerThDay > 0 && snap.account.nockPending === 0.0295, `面板数据含 NOCK（每 TH 日产 ${snap.market.nockPerThDay.toFixed(5)} NOCK）`);

// ---- 算力健康 & 重启
{
  const e2 = new Engine();
  e2.log = () => {};

  await e2.refreshMarket(); await e2.refreshVast();
  e2.setAlias("10000001", "5080");
  const now = Date.now();
  const fill = (id, hsFn, mins = 12) => e2.samples.set(Number(id), Array.from({ length: mins * 2 }, (_, k) => ({ t: now - (mins * 60 - k * 30) * 1000, hs: hsFn(k) })));
  // 5080：真实情况 96 TH/s（预期 195）
  fill(10000001, () => 96.4e12);
  e2.everHashed.add('10000001');
  e2.workers.set('5080', { hs: 96.4e12, gpus: [{ name: 'RTX 5080', hs: 96.4e12 }] });
  let x = e2.instances().find(i => i.id === '10000001');
  ok(x.health === 'low' && /49%/.test(x.healthMsg), `单卡掉到一半 → 判为「算力偏低」（${x.healthMsg}）`);
  // 正常机器
  e2.workers.set('5080', { hs: 200e12, gpus: [{ name: 'RTX 5080', hs: 200e12 }] });
  fill(10000001, () => 200e12);
  x = e2.instances().find(i => i.id === '10000001');
  ok(x.health === 'ok', `算力正常（${Math.round(x.hashRatio * 100)}%）→ 不报警`);
  // 2 卡机器，一张卡 45%
  e2.rawInstances.push({ id: 880, label: 'prl-auto-RTX4090', gpu_name: 'RTX 4090', num_gpus: 2, dph_total: 0.4, actual_status: 'running', start_date: now / 1000 - 3600, machine_id: 8800 });
  e2.st.managed['880'] = { rentedAt: now - 60 * MIN, gpuName: 'RTX 4090', numGpus: 2, machineId: 8800 };
  e2.workers.set('v880', { hs: 450e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }, { name: 'RTX 4090', hs: 140e12 }] });
  fill(880, () => 450e12);
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === 'gpu' && x.gpus.filter(g => !g.ok).length === 1, `多卡机器单卡偏弱 → 判为「显卡异常」（${x.healthMsg}）`);
  // 掉卡：2 卡只报了 1 张
  e2.workers.set('v880', { hs: 310e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }] });
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === 'gpu' && /1\/2/.test(x.healthMsg), `掉卡 → ${x.healthMsg}`);
  // 刚开始挖 2 分钟：不判
  e2.samples.set(880, [{ t: now - 2 * MIN, hs: 100e12 }, { t: now - MIN, hs: 100e12 }]);
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === null, '刚出算力不满 3 分钟 → 不判断（算力爬升期）');
  // 坏机器不参与校准
  fill(880, () => 450e12);
  e2.workers.set('v880', { hs: 450e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }, { name: 'RTX 4090', hs: 140e12 }] });
  e2.lastCalib.clear();
  e2.calibrate(e2.instances());
  ok(!e2.st.calib.RTX4090, '算力异常的机器不会拉低实测参考值');

  // 重启
  let rebootedId = null;
  e2.vast.reboot = async id => { rebootedId = id; return { success: true }; };
  await e2.reboot('880');
  ok(rebootedId === '880' && e2.st.restarts['880'] > 0, '一键重启调用了 vast 重启接口');
  e2.workers.delete('v880');
  e2.recordSamples();
  x = e2.instances().find(i => i.id === '880');
  ok(x.phase === 'restarting', '重启后、矿工上线前 → 状态为「重启中」');
  let destroyed2 = null;
  e2.vast.destroy = async id => { destroyed2 = id; return { success: true }; };
  e2.st.managed['880'].rentedAt = now - 120 * MIN;
  await e2.autoDestroy(e2.instances());
  ok(destroyed2 === null, '重启恢复期内不会被自动退租');
  try { await e2.reboot('880'); ok(false, '5 分钟内重复重启应被拒绝'); } catch { ok(true, '5 分钟内不能重复重启'); }
  // 恢复期过了还没算力 → 按部署超时退租
  e2.st.restarts['880'] = now - 25 * MIN;
  e2.samples.set(880, [...Array.from({ length: 10 }, (_, k) => ({ t: now - (40 - k) * MIN, hs: 450e12 })), ...Array.from({ length: 48 }, (_, k) => ({ t: now - (24 - k * 0.5) * MIN, hs: 0 }))]);
  x = e2.instances().find(i => i.id === '880');
  ok(x.avgHs === 0 && x.phase === 'nohash', '重启后的均值不混入重启前的算力');
  await e2.autoDestroy(e2.instances());
  ok(destroyed2 === '880', '重启后超过 20 分钟仍无算力 → 自动退租');
}

// ---- 被抢租 & 续航保护
{
  const e3 = new Engine();
  e3.log = () => {};
  e3.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: true });
  await e3.refreshMarket(); await e3.refreshWildrig(); await e3.refreshVast(); await e3.scan(true);
  e3.account.vastBalance = 50; // 50-2=48 → 续航 12h 上限 $4/h
  e3.st.blacklist = {}; e3.st.managed = {};
  const tried = [];
  let n = 0;
  e3.vast.rent = async id => {
    tried.push(id);
    if (n++ === 0) { const err = new Error('HTTP 400：error 404/3603: no_such_ask  Instance type by id ' + id + ' is not available.'); throw err; }
    return { success: true, new_contract: 7000 + n };
  };
  e3.lastRentAt = 0;
  await e3.decide();
  ok(tried.length >= 2 && tried.length <= 8, `第一台被抢走 → 同一轮立刻换下一台（试了 ${tried.length} 台）`);
  ok(tried.length - 1 >= 2 && tried.length - 1 <= 5, `一轮把达标的都租下（这轮租了 ${tried.length - 1} 台，上限 5）`);
  ok(Object.keys(e3.st.blacklist).length === 0, '被抢走的机器不拉黑');
  ok(!e3.offers.some(o => o.id === tried[0]), '被抢走的 offer 从列表里移除');
  ok(!!e3.st.managed['7002'], '第二台租用成功并纳入管理');

  // 续航：余额 8.32，保留 2 → 6.32/12 = $0.527/h
  const e4 = new Engine();
  const logs = [];
  e4.log = (l, m) => logs.push(m);
  e4.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: true });
  await e4.refreshMarket(); await e4.refreshWildrig(); await e4.refreshVast(); await e4.scan(true);
  e4.account.vastBalance = 8.32;
  e4.st.blacklist = {}; e4.st.managed = {};
  let rents = [];
  e4.vast.rent = async (id) => { rents.push(id); return { success: true, new_contract: 9000 + rents.length }; };
  const spend0 = e4.budget(e4.instances()).spend;
  const dphOf = Object.fromEntries(e4.offers.map(o => [o.id, o.dph]));
  for (let k = 0; k < 5; k++) { e4.lastRentAt = 0; await e4.decide(); e4.budget = ((orig) => (l) => { const b = orig.call(e4, l); const add = rents.reduce((a, id) => a + dphOf[id], 0); return { ...b, spend: b.spend + add, roomSpend: b.roomSpend - add, count: b.count + rents.length, roomCount: b.roomCount - rents.length }; })(Object.getPrototypeOf(e4).budget); }
  const total = spend0 + rents.reduce((a, id) => a + dphOf[id], 0);
  ok(total <= 6.32 / 12 + 1e-9, `余额 $8.32 时连续 5 轮总花费不超过续航上限 $0.527/h（已有 $${spend0.toFixed(3)} + 新租 ${rents.length} 台 = $${total.toFixed(3)}）`);
  e4.account.vastBalance = 2.5; // 0.5/12 = $0.04/h
  e4.lastRentAt = 0; const before = rents.length; await e4.decide();
  ok(rents.length === before && logs.some(m => /续航/.test(m)), '余额不够续航 12 小时 → 停止新租并提示');
}

// ---- 续航保护开关 / 部署计时 / 镜像源顺序
{
  const e5 = new Engine();
  e5.log = () => {};
  e5.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: false });
  await e5.refreshMarket(); await e5.refreshWildrig(); await e5.refreshVast(); await e5.scan(true);
  e5.account.vastBalance = 2.5; // 开着保护时只能花 $0.04/h
  e5.st.blacklist = {};
  const rents = [];
  e5.vast.rent = async (id) => { rents.push(id); return { success: true, new_contract: 9500 + rents.length }; };
  e5.lastRentAt = 0; await e5.decide();
  const nOff = rents.length;
  ok(nOff >= 1 && e5.offers.filter(o => rents.includes(o.id)).reduce((a, o) => a + o.dph, 0) <= 0.5 + 1e-9, `关闭续航保护 → 余额少也照常租（${nOff} 台，合计不超过余额减保留金额 $0.5）`);
  ok(e5.snapshot().budget.spendCapByRunway === null, '关闭时面板拿到 null（不是 0）');
  e5.updateConfig({ runwayGuard: true });
  e5.lastRentAt = 0; await e5.decide();
  ok(rents.length === nOff, '重新打开续航保护 → 停止新租');

  // 部署计时：租下 → 容器 running → 出算力
  const id = String(9500 + 1);
  for (const k of Object.keys(e5.st.managed)) if (k !== id) delete e5.st.managed[k];
  const m = e5.st.managed[id];
  m.rentedAt = Date.now() - 7 * MIN;
  e5.rawInstances.push({ id: +id, label: 'prl-auto-x', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.1, actual_status: 'loading', start_date: Date.now() / 1000, machine_id: 1 });
  let x = e5.instances().find(i => i.id === id);
  ok(x.deploy && !x.deploy.runningAt, '拉镜像阶段：还没有 runningAt');
  e5.rawInstances.find(i => i.id === +id).actual_status = 'running';
  const realInst = e5.vast.instances; e5.vast.instances = async () => e5.rawInstances;
  await e5.refreshVast();
  ok(e5.st.managed[id].runningAt > 0, '容器开机 → 记录 runningAt');
  e5.st.managed[id].runningAt = Date.now() - 2 * MIN;
  e5.workers.set('v' + id, { hs: 130e12, gpus: [{ name: 'RTX 3090', hs: 130e12 }] });
  e5.workersOk = true;
  e5.recordSamples();
  const st = e5.st.deployStats.at(-1);
  ok(st && Math.round(st.total / 60) === 7 && Math.round(st.pull / 60) === 5 && Math.round(st.miner / 60) === 2, `出算力 → 记录部署用时（共 ${Math.round(st.total)}s，镜像 ${Math.round(st.pull)}s，矿工 ${Math.round(st.miner)}s）`);
  ok(e5.snapshot().deployAvg?.n >= 1, '面板拿到平均部署时间');
  e5.vast.instances = realInst;

  const O = await import(U('src/onstart.js'));
  const PL = [{ id: 'pearlhash', bin: 'wr', cmd: '--algo pearlhash --url stratum+ssl://p:1 --user w --worker $W' }];
  const cn = O.buildOnstart({ pools: PL, def: 'pearlhash', wildrigUrl: 'https://github.com/x.tar.xz', cnFirst: true });
  const us = O.buildOnstart({ pools: PL, def: 'pearlhash', wildrigUrl: 'https://github.com/x.tar.xz', cnFirst: false });
  ok(/URLS="https:\/\/ghfast/.test(cn) && /URLS="https:\/\/github/.test(us), '国内机器先走镜像源，海外机器先走 GitHub');
  // 租用时按地区选择
  let cap = null; e5.vast.rent = async (oid, b) => { cap = b; return { success: true, new_contract: 9600 }; };
  e5.lastRentAt = 0;
  await e5.rent({ ...e5.offers[0], geolocation: 'Guangdong, CN', used: false }, 'manual');
  ok(/wr\) F=wildrig-multi; URLS="https:\/\/ghfast/.test(cap.onstart), '「Guangdong, CN」被识别为国内机器');
}

// ---- vast 每日搜索额度（按条数计）
{
  const e6 = new Engine();
  e6.log = () => {};
  e6.updateConfig({ autoRent: true, maxInstances: 50, maxHourlySpend: 100, scanRows: 100, scanIntervalSec: 300 });
  e6.st.searchUsage = null; e6.st.quotaEst = null; e6.st.searchQuota = null; e6.st.scanPause = null;
  e6.scanPausedUntil = 0;
  await e6.refreshMarket(); await e6.refreshVast();
  await e6.scan(true);
  ok(globalThis.__lastLimit === 100, `每次只取 ${globalThis.__lastLimit} 条（原来是 1000）`);
  ok(e6.usageToday().requests === 1 && e6.usageToday().rows > 0, `今日用量被记录（${e6.usageToday().requests} 次 / ${e6.usageToday().rows} 条）`);

  // 额度用完
  globalThis.__quotaLeft = 0;
  globalThis.__quotaReset = Date.now() + 5 * 3600e3;
  const usedBefore = e6.usageToday().rows;
  await e6.scan(true).catch(() => {});
  ok(e6.pauseReason === 'quota' && Math.abs(e6.scanPausedUntil - globalThis.__quotaReset) < 2000, '额度用完 → 暂停到 vast 给的重置时间');
  ok(e6.st.quotaEst === usedBefore, `学到每日额度估计值（${e6.st.quotaEst} 条）`);
  let msg = '';
  try { await e6.scan(true); } catch (err) { msg = err.message; }
  ok(/额度已用完/.test(msg), '额度用完时点「立即扫描」→ 直接提示恢复时间，不再请求 vast');
  const e7 = new Engine(); e7.log = () => {};
  ok(e7.pauseReason === 'quota' && e7.scanPausedUntil > Date.now(), '重启程序后仍记得暂停，不会再撞一次上限');
  globalThis.__quotaLeft = null;

  // 普通的「请求太频繁」只等 2 分钟
  e6.scanPausedUntil = 0; e6.pauseReason = null;
  globalThis.__rateLimited = true;
  await e6.scan(true);
  ok(e6.pauseReason === 'rate' && e6.scanPausedUntil - Date.now() < 2.1 * MIN, '普通 429 只暂停 2 分钟');
  e6.scanPausedUntil = 0; e6.pauseReason = null;

  // 调度
  e6.st.quotaEst = 3000;
  e6.st.searchUsage = { day: e6.utcDay(), requests: 0, rows: 0 };
  let plan = e6.scanPlan();
  const expect = (e6.nextUtcMidnight() - Date.now()) / (Math.floor(2700 / 100) - 1);
  ok(Math.abs(plan.interval - Math.max(300e3, expect)) < 5000, `按每日额度 3000 条分摊：约每 ${Math.round(plan.interval / 60000)} 分钟扫一次`);
  e6.updateConfig({ autoRent: false });
  ok(e6.scanPlan().interval >= 15 * MIN, '自动租用关闭时 15 分钟扫一次');
  e6.updateConfig({ autoRent: true, maxInstances: 1 });
  ok(e6.scanPlan().skip === true, '已租满台数 → 跳过扫描，不浪费额度');
  e6.updateConfig({ maxInstances: 50 });
  globalThis.__sendQuotaHeaders = true; globalThis.__quotaLeft = 1500;
  const estBefore = e6.st.quotaEst;
  await e6.scan(true);
  ok(e6.st.quotaEst === estBefore && e6.st.rateLimitHeaders?.limit === 5000, 'X-RateLimit 响应头只记录，不再当成每日额度（今早把 30 当成每日额度导致停扫）');
  globalThis.__sendQuotaHeaders = false; globalThis.__quotaLeft = null;

  // 配置升级：旧默认值换新，自己改过的不动
  const fs2 = await import('node:fs');
  const cfgPath = dir + '/data/config.json';
  const saved = JSON.parse(fs2.readFileSync(cfgPath, 'utf8'));
  fs2.writeFileSync(cfgPath, JSON.stringify({ ...saved, minInetDown: 20, scanIntervalSec: 600, configVersion: undefined }));
  const S2 = await import(U('src/store.js') + '?v=' + Date.now());
  const c2 = S2.loadConfig();
  ok(c2.minInetDown === 200 && c2.scanIntervalSec === 600 && c2.configVersion === 2, '配置升级：带宽仍是旧默认 20 → 升到 200；扫描间隔用户改过（600）保持不变');
}

// ---- 回归：今早 RTX 3080 Ti 租下 4 分钟就被判「掉线 10 分钟」误杀
{
  const e8 = new Engine();
  e8.log = () => {};
  await e8.refreshMarket(); await e8.refreshVast();
  const now = Date.now();
  e8.rawInstances.push({ id: 7777, label: 'prl-auto-RTX3080TI', gpu_name: 'RTX 3080 Ti', num_gpus: 1, dph_total: 0.135, actual_status: 'running', start_date: now / 1000 - 300, machine_id: 777 });
  e8.st.managed['7777'] = { rentedAt: now - 4.5 * MIN, gpuName: 'RTX 3080 Ti', numGpus: 1, machineId: 777 };
  // 矿工已经连上矿池但算力还是 0，每 15 秒采一次，采了 4 分钟（17 个样本）
  e8.workers.set('v7777', { hs: 0, gpus: [{ name: 'RTX 3080 Ti', hs: 0 }] });
  e8.samples.set(7777, Array.from({ length: 17 }, (_, k) => ({ t: now - (4 * 60 - k * 15) * 1000, hs: 0 })));
  let killed = null; e8.vast.destroy = async id => { killed = id; return { success: true }; };
  let x = e8.instances().find(i => i.id === '7777');
  ok(x.phase === 'booting', `矿工连上但还没出算力 → 算「部署中」而不是「无算力」（${x.phase}）`);
  await e8.autoDestroy(e8.instances());
  ok(killed === null, '租下 4 分钟、17 个零样本 → 不会被误判掉线退租');
  // 真掉线：之前出过算力，之后连续 11 分钟为 0
  e8.samples.set(7777, [{ t: now - 20 * MIN, hs: 120e12 }, { t: now - 11.5 * MIN, hs: 120e12 }, ...Array.from({ length: 44 }, (_, k) => ({ t: now - (11 * 60 - k * 15) * 1000, hs: 0 }))]);
  e8.everHashed.add('7777');
  x = e8.instances().find(i => i.id === '7777');
  await e8.autoDestroy(e8.instances());
  ok(killed === '7777', `真正掉线 11 分钟 → 退租（${x.phase}）`);
  // 掉线才 6 分钟（采样很密）→ 不退
  killed = null;
  e8.samples.set(7777, [{ t: now - 7 * MIN, hs: 120e12 }, ...Array.from({ length: 24 }, (_, k) => ({ t: now - (6 * 60 - k * 15) * 1000, hs: 0 }))]);
  await e8.autoDestroy(e8.instances());
  ok(killed === null, '掉线 6 分钟（24 个样本）→ 不退，按时间而不是样本数判断');
  // 断网告警数据
  e8.vastFailSince = now - 5 * MIN;
  ok(Math.round(e8.snapshot().netDown.vastMin) === 5, '面板拿到「连不上 vast 已 5 分钟」');
}

// ---- 回归：挖了 20 小时的 2080 Ti，vast 短暂报告离线就被按「部署超时」立刻退租
{
  const e10 = new Engine();
  const lg = []; e10.log = (lv, m) => lg.push(m);
  await e10.refreshMarket(); await e10.refreshVast();
  const now = Date.now();
  e10.rawInstances.push({ id: 5688, label: 'prl-auto-RTX2080TI', gpu_name: 'RTX 2080 Ti', num_gpus: 2, dph_total: 0.163, actual_status: 'offline', intended_status: 'running', status_msg: 'success, running vastai/base-image', start_date: now / 1000 - 20 * 3600, machine_id: 5688 });
  e10.st.managed['5688'] = { rentedAt: now - 20 * 60 * MIN, runningAt: now - 20 * 60 * MIN + 30000, hashAt: now - 20 * 60 * MIN + 90000, gpuName: 'RTX 2080 Ti', numGpus: 2, machineId: 5688 };
  let killed = null; e10.vast.destroy = async id => { killed = id; return { success: true }; };
  await e10.autoDestroy(e10.instances());
  ok(killed === null && e10.st.managed['5688'].offlineSince, '出过算力的机器刚报离线 → 不退租，开始计时');
  e10.rawInstances[e10.rawInstances.length - 1].actual_status = 'running';
  await e10.autoDestroy(e10.instances());
  ok(killed === null && !e10.st.managed['5688'].offlineSince, '恢复在线 → 清掉离线计时');
  e10.rawInstances[e10.rawInstances.length - 1].actual_status = 'offline';
  await e10.autoDestroy(e10.instances());
  e10.st.managed['5688'].offlineSince = now - 11 * MIN;
  await e10.autoDestroy(e10.instances());
  ok(killed === '5688' && lg.some(l => /离线超过 10 分钟/.test(l)) && !lg.some(l => /部署超时/.test(l)), '连续离线 11 分钟 → 退租，原因写「离线」而不是「部署超时」');
  // 程序重启后内存里的出算力记录丢了：有 hashAt 就不算部署中
  const e11 = new Engine(); e11.log = () => {};
  await e11.refreshMarket(); await e11.refreshVast();
  e11.rawInstances.push({ id: 5689, label: 'prl-auto-RTX2080TI', gpu_name: 'RTX 2080 Ti', num_gpus: 2, dph_total: 0.163, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 20 * 3600, machine_id: 5689 });
  e11.st.managed['5689'] = { rentedAt: now - 20 * 60 * MIN, hashAt: now - 20 * 60 * MIN + 90000, gpuName: 'RTX 2080 Ti', numGpus: 2, machineId: 5689 };
  let k2 = null; e11.vast.destroy = async id => { k2 = id; return { success: true }; };
  const x11 = e11.instances().find(i => i.id === '5689');
  await e11.autoDestroy(e11.instances());
  ok(x11.phase !== 'booting' && k2 === null, `程序重启后矿池暂时没数据 → 不会被当成部署中误杀（${x11.phase}）`);
}

// ---- 精准搜索 + 屏蔽反复租不到的机器
{
  const e12 = new Engine(); const lg = []; e12.log = (l, m) => lg.push(m);
  e12.updateConfig({ targetProfitPct: 20 });
  await e12.refreshMarket(); await e12.refreshVast();
  globalThis.__quotaLeft = null; e12.scanPausedUntil = 0; e12.st.vastNames = {}; e12.scanN = 0;
  await e12.scan(true);
  ok(!globalThis.__lastQuery.gpu_name && e12.offerStats.mode === '全量搜索' && Object.keys(e12.st.vastNames || {}).length > 0, `第一次全量搜索，学到 vast 的型号名（${Object.keys(e12.st.vastNames || {}).length} 个）`);
  await e12.scan(true);
  const q = globalThis.__lastQuery.gpu_name?.in || [];
  ok(q.length > 0 && q.every(n => e12.thFor(n)?.autoOk) && /精准搜索/.test(e12.offerStats.mode), `之后只搜能达标的已知型号（${e12.offerStats.mode}：${q.slice(0, 4).join('、')}…）`);
  for (let k = 0; k < 5; k++) await e12.scan(true);
  ok(!globalThis.__lastQuery.gpu_name, '每 6 次做一次全量搜索，发现新型号');
  const realSearch = e12.vast.searchOffers.bind(e12.vast);
  e12.scanN = 1; e12.vast.searchOffers = async (f, m, names) => { if (names) { const er = new Error('HTTP 400：bad gpu_name'); er.status = 400; throw er; } return realSearch(f, m); };
  await e12.scan(true);
  ok(e12.focusedOff && e12.offerStats.mode === '全量搜索' && e12.offers.length > 0 && lg.some(m => /改回全量搜索/.test(m)), 'vast 不接受精准搜索 → 当次自动改用全量，之后不再用');
  e12.vast.searchOffers = realSearch;
  const o = e12.offers[0];
  e12.st.goneCount = {}; e12.st.blacklist = {};
  e12.vast.rent = async id => { throw new Error('HTTP 400：no_such_ask Instance type by id ' + id + ' is not available.'); };
  try { await e12.rent({ ...o }, 'auto'); } catch {}
  ok(!e12.st.blacklist[o.machineId], '第一次租不到：当作被抢走，不屏蔽');
  try { await e12.rent({ ...o }, 'auto'); } catch {}
  ok(e12.st.blacklist[o.machineId]?.reason === '反复租不到' && lg.some(m => /反复出现在列表里却租不到/.test(m)), '同一台 2 小时内第 2 次租不到 → 屏蔽 2 小时');
}

// ---- 开机后矿工迟迟不上线：抓日志 + 提前退租
{
  const e9 = new Engine();
  e9.log = () => {};
  e9.updateConfig({ minerStartTimeoutMinutes: 8 });
  await e9.refreshMarket(); await e9.refreshVast();
  const now = Date.now();
  e9.rawInstances.push({ id: 8888, label: 'prl-auto-RTX3080', gpu_name: 'RTX 3080', num_gpus: 1, dph_total: 0.109, actual_status: 'running', start_date: now / 1000 - 700, machine_id: 888 });
  e9.st.managed['8888'] = { rentedAt: now - 6 * MIN, runningAt: now - 5 * MIN, gpuName: 'RTX 3080', numGpus: 1, machineId: 888 };
  let killed = null, reason = '';
  const realDestroy = e9.destroy.bind(e9);
  e9.vast.destroy = async id => { killed = id; return { success: true }; };
  e9.log = (l, msg) => { if (/已退租实例 8888/.test(msg)) reason = msg; };
  globalThis.__logReqs = 0;
  await e9.autoDestroy(e9.instances());
  ok(globalThis.__logReqs === 1 && killed === null, '开机 5 分钟还没上线 → 自动抓机器日志，但先不退租');
  const x = e9.instances().find(i => i.id === '8888');
  ok(/CUDA error 999/.test(x.logHint), `卡片上显示日志里的关键报错（${x.logHint}）`);
  await e9.autoDestroy(e9.instances());
  ok(globalThis.__logReqs === 1, '3 分钟内不重复抓日志');
  e9.st.managed['8888'].runningAt = now - 9 * MIN;
  await e9.autoDestroy(e9.instances());
  ok(killed === '8888' && /8 分钟矿工仍未上线：.*CUDA error 999/.test(reason), `开机 9 分钟仍未上线 → 提前退租，原因附带日志（${reason.slice(0, 80)}…）`);
  ok(Object.values(e9.st.blacklist).some(b => /矿工仍未上线/.test(b.reason)), '这台机器被拉黑 24 小时');
  // 只有进度没有报错时，摘要取最后一条 [prl] 进度
  globalThis.__logText = `[prl] 01:00:00 worker=v2
[prl] 01:00:00 download https://github.com/x
[prl] 01:02:00 download https://ghfast.top/https://github.com/x
`;
  e9.rigLogs.clear();
  await e9.fetchLogs('8888');
  ok(/ghfast/.test(e9.logHint('8888')), `没有报错时显示最后一步进度（${e9.logHint('8888')}）`);
  globalThis.__logText = undefined;
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
