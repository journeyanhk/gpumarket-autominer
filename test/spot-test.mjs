// 竞价（spot）最小补丁的测试：搜索用 bid、下单带出价、被抢占后按「需销毁」处理。
// 全部走 test/mock.mjs，不联网、不花钱。
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
ok(e.offers.length > 0 && e.offers.every(o => o.spot && o.bid > 0), `扫到 ${e.offers.length} 台竞价机，每台都有出价`);
ok(e.offers.every(o => Math.abs(o.dph - o.bid) < 1e-9), 'ROI 用的是「出价」，不是挂牌价');
ok(e.offers.every(o => o.bid <= o.revenueHr / 1.3 + 1e-6), '出价不超过「目标收益率 30%」允许的上限（rev/1.3）');
ok(e.offers.every(o => o.listDph >= o.bid), '挂牌价 ≥ 出价（挂牌价只是展示）');

console.log('— 出价算法边界');
ok(e.bidPrice(0.30, 0) === 0.225, `收入 $0.30/h、系数 0.75 → 出价 $${e.bidPrice(0.30, 0)}`);
ok(e.bidPrice(0.30, 0.5) === null, '入场价高于「目标 ROI 允许的上限」→ 不出价（宁可不租）');
e.cfg.spotBidFactor = 0.7;
ok(e.bidPrice(0.30, 0.222) === 0.222, '入场价高于目标出价但仍在上限内 → 按入场价出');
e.cfg.spotBidFactor = 0.75;
e.cfg.targetProfitPct = 100;
ok(e.bidPrice(0.30, 0) === 0.15, `目标 100% 时上限收紧到 rev/2（$${e.bidPrice(0.30, 0)}）`);
e.cfg.targetProfitPct = 30;

console.log('— 下单带出价');
const pick = e.offers.find(o => o.roi >= 30 && o.bid < o.listDph - 1e-6) || e.offers.find(o => o.roi >= 30);
let body = null;
const realRent = e.vast.rent.bind(e.vast);
e.vast.rent = async (oid, b) => { body = b; return realRent(oid, b); };
e.lastRentAt = 0;
const id = await e.rent(pick, 'manual');
ok(body.price === pick.bid && body.price < pick.listDph, `下单 price=${body.price} = 出价（挂牌价 ${pick.listDph}，按需租要多付）`);
ok(e.st.managed[id]?.spot === true, '托管记录标了 spot');
ok(logs.some(l => /竞价出价/.test(l)), '日志区分了竞价租用');

console.log('— 被抢占 → 按需销毁');
ok(e.st.managed[id] && e.st.managed[id].hashAt == null, '还在部署（还没出算力）');
// 先让它出算力，才会走「抢占」而不是「部署失败」分支
await e.refreshVast();
e.rawInstances.find(i => String(i.id) === String(id)).actual_status = 'running';
e.everHashed.add(String(id));
e.st.managed[id].hashAt = Date.now() - 30 * MIN;
e.st.managed[id].runningAt = Date.now() - 40 * MIN;
await e.refreshVast();
globalThis.__preempt(id);
await e.refreshVast();
let x = e.instances().find(i => i.id === String(id));
ok(x?.phase === 'preempted', `被抢占后 phase=${x?.phase}（不是 offline，也不是 mining）`);
await e.decide();
ok(e.st.managed[id]?.preemptedAt > 0, '开始计时，并写进状态（重启后也知道）');
ok(logs.some(l => /竞价被抢占.*磁盘仍/.test(l)), '日志写明「stopped 期间磁盘仍在计费」');
e.st.managed[id].preemptedAt = Date.now() - 6 * MIN;
await e.decide();
ok(!e.st.managed[id], '超过 5 分钟 → 已销毁');
ok(Object.values(e.st.blacklist).length === 0, '被抢占不拉黑机器（不是机器的问题）');

console.log('— 关掉竞价就回到按需');
e.updateConfig({ useSpot: false });
await e.scan(true);
ok(globalThis.__lastType === 'on-demand', '关闭后搜索回到 on-demand');
ok(e.offers.every(o => o.spot === false && o.dph === o.listDph), '按需模式的 ROI 用挂牌价计算');
const cfg = e.publicConfig();
ok(cfg.useSpot === false && cfg.spotBidFactor === 0.75, '面板能拿到 useSpot / spotBidFactor');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);