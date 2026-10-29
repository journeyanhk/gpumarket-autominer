// 决策逻辑测试（由 test/run.mjs 在临时目录里运行，不会碰你的 data 文件夹）
// 多矿池测试：钱包设置、租用脚本、手动切换、切换失败回退、Kryptex 算力判断、故障转移、收益账本
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href; // Windows 路径也能 import
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');
const W1 = 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4';
const W2 = 'prl1pg0put8k9w3r5tmrpsn6vt8r54stenf33tmr4z6sj6etnhepnmm992l909v';
fs.writeFileSync('data/config.json', JSON.stringify({
  vastApiKey: 'test-key', wallet: W1, autoRent: false, autoDestroy: true, targetProfitPct: 10, stopLossPct: -100,
  maxInstances: 10, maxHourlySpend: 50, minBalanceReserve: 0,
}));
const { Engine } = await import(U('src/engine.js'));
const { kryptexHost } = await import(U('src/pools.js'));
const MIN = 60000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const logs = [];

const e = new Engine();
// L1 折算（份额反推算力 ÷ 矿工自报）会整体压低报价；这些用例测的是别的逻辑，
// 所以这里把它设成 1，L1 本身由 lease-test 的「L1 按型号维护」一节覆盖。
e.cfg.l1Default = 1;
// 存活率/部署成本的折算由 lease-test 专门覆盖；这些用例测别的逻辑，先中性化
e.cfg.pSurviveDefault = 1; e.cfg.deployCostMin = 0;
e.cfg.onDemand = { ...(e.cfg.onDemand || {}), enabled: false };   // 按需腿由 lease-test 覆盖
e.log = (lv, msg) => logs.push(`[${lv}] ${msg}`);
await e.refreshMarket(); await e.refreshWildrig(); await e.refreshVast(); await e.refreshKryptex(); await e.scan(true);

console.log('— 钱包设置');
let err = null;
try { e.updateConfig({ kryptexWallet: 'prl1abc' }); } catch (x) { err = x.message; }
ok(err && /Kryptex 钱包地址校验失败/.test(err), '错误的 Kryptex 钱包被拒绝');
err = null; try { e.updateConfig({ defaultPool: 'kryptex' }); } catch (x) { err = x.message; }
ok(err && /先填它的钱包地址/.test(err), '没填钱包不能设为默认矿池');
const roiPh = e.offers[0]?.roi;
e.updateConfig({ kryptexWallet: W2 });
ok(e.cfg.kryptexWallet === W2 && e.configuredPools().join() === 'pearlhash,kryptex', 'Kryptex 钱包保存成功，两个矿池都可用');
await e.refreshKryptex();
ok(e.kx.info?.fee === 0.03, `读到 Kryptex 手续费 ${e.kx.info?.fee}`);
const rPh = e.usdHsHrFor('pearlhash'), rKx = e.usdHsHrFor('kryptex');
ok(Math.abs(rKx / e.prlRate('pearlhash') - 0.97 * 0.98 / 0.99) < 1e-9, 'Kryptex 收益按 3% 手续费 + SRBMiner 2% 开发费计算');
ok(rPh > rKx, `同样算力 Pearlhash 收益更高（$${(rPh * 1e12 * 24).toFixed(4)} vs $${(rKx * 1e12 * 24).toFixed(4)} /TH/天）`);
ok(kryptexHost('Texas, US') === 'prl-us.kryptex.network' && kryptexHost('Hong Kong, HK') === 'prl-hk.kryptex.network' && kryptexHost('Bavaria, DE') === 'prl-eu.kryptex.network' && kryptexHost('') === 'prl.kryptex.network', 'Kryptex 按机器地区选最近的服务器');

console.log('— 租用：脚本带上两个矿池');
const cap = [];
const realRent = e.vast.rent.bind(e.vast);
e.vast.rent = async (oid, b) => { cap.push(b); return realRent(oid, b); };
const offA = e.offers.find(o => /US/.test(o.geolocation)) || e.offers[0];
const idA = await e.rent(offA, 'manual');
const ob = cap.at(-1);
ok(/ pool=pearlhash$/.test(ob.label), `标签带默认矿池：${ob.label}`);
ok(/pearlhash\) echo "wr --algo pearlhash --url stratum\+ssl:\/\/pool\.pearlhash\.xyz:9443 --user prl1p\S+ --worker \$W"/.test(ob.onstart), '脚本含 Pearlhash 参数（WildRig）');
ok(new RegExp(`kryptex\\) echo "srb --disable-cpu --algorithm pearlhash --pool prl-[a-z]+\\.kryptex\\.network:7048 --wallet ${W2}\\.\\$W --api-enable --api-port 21555"`).test(ob.onstart), '脚本含 Kryptex 参数（SRBMiner + 本地 API 21555）');
ok(/srb\) F=SRBMiner-MULTI; SHA=[a-f0-9]{64}; URLS="https:\/\/github\.com\/doktor83\/SRBMiner-Multi\/releases\/download\/3\.8\.0\/SRBMiner-Multi-3-8-0-Linux\.tar\.gz/.test(ob.onstart), 'SRBMiner 用的是清单 pin 的 3.8.0（不是「GitHub 最新版」）');
ok(/DEF='pearlhash'/.test(ob.onstart) && /pool=\[a-z\]\*/.test(ob.onstart), '脚本默认挖 Pearlhash，并每分钟读标签');
const mA = e.st.managed[idA];
ok(mA.sv === 8 && mA.pools.join() === 'pearlhash,kryptex' && mA.pool === 'pearlhash', '记录了脚本版本（v8：sha256 + 5 分钟份额采样，只挑 shares/hashrate 等字段避开日志截断）和可切换的矿池');

// 让它开机并在 Pearlhash 出算力
await wait(22000);
await e.refreshVast(); await e.refreshMarket(); await e.refreshKryptex();
let xA = e.instances().find(x => x.id === idA);
ok(xA.pool === 'pearlhash' && xA.onPools.pearlhash && xA.phase === 'mining', `新机器在 Pearlhash 挖矿（${xA.phase}）`);

console.log('— 上一版脚本（v2，WildRig 挖 Kryptex）');
mA.sv = 2;
err = null; try { await e.setPool(idA, 'kryptex'); } catch (x) { err = x.message; }
ok(/WildRig 不兼容/.test(err || ''), 'v2 脚本租的机器不能切 Kryptex，提示原因');
ok(e.instances().find(x => x.id === idA).switchable.join() === 'pearlhash', 'v2 机器可切换列表只剩 Pearlhash');
mA.sv = 3;
console.log('— 手动切换到 Kryptex');
err = null; try { await e.setPool(idA, 'pearlhash'); } catch (x) { err = x.message; }
ok(/已经在挖/.test(err || ''), '切到当前矿池 → 提示已经在挖');
err = null; try { await e.setPool('10000001', 'kryptex'); } catch (x) { err = x.message; }
ok(/不支持切换矿池/.test(err || ''), '手动部署的旧机器不能切换');
globalThis.__switchDelay = 3;
await e.setPool(idA, 'kryptex');
ok(globalThis.__labels.at(-1)[1].endsWith('pool=kryptex'), '调用 vast 改标签为 pool=kryptex');
xA = e.instances().find(x => x.id === idA);
ok(xA.phase === 'switching' && xA.switching.to === 'kryptex' && xA.switching.from === 'pearlhash', '面板显示「切换中」');
await e.autoDestroy(e.instances());
ok(e.rawInstances.some(i => String(i.id) === idA), '切换过程中不会被判掉线退租');
await wait(4000);
await e.refreshMarket(); await e.refreshKryptex();
await e.checkSwitches(e.instances());
xA = e.instances().find(x => x.id === idA);
ok(!xA.switching && xA.pool === 'kryptex' && e.st.managed[idA].poolSince > 0, `机器在 Kryptex 出算力 → 切换完成（${xA.pool}）`);
ok(logs.some(l => /已在 Kryptex 出算力/.test(l)), '日志记录切换完成');
ok(Math.abs(xA.revenueHr / xA.avgHs - e.usdHsHrFor('kryptex')) < 1e-30 || xA.avgHs === 0, '这台机器的收益按 Kryptex 费率计算');
ok(xA.health === null && /爬升/.test(xA.healthMsg), `Kryptex 前 30 分钟不判断算力偏低（${xA.healthMsg}）`);
ok(!/张卡在挖/.test(xA.healthMsg), 'Kryptex 没有逐卡数据，不会误报掉卡');

console.log('— Kryptex 算力判断（30 分钟后）');
globalThis.__kxRatio = 0.5; globalThis.__kxOpenedAgoMin = 40;
await e.refreshKryptex(); await e.refreshMarket();
const arrA = e.samples.get(Number(idA));
for (const s of arrA) s.t -= 35 * MIN;
e.st.managed[idA].poolSince = Date.now() - 40 * MIN;
for (let k = 0; k < 6; k++) arrA.push({ t: Date.now() - k * MIN, hs: e.workerFor(idA).hs });
arrA.sort((a, b) => a.t - b.t);
xA = e.instances().find(x => x.id === idA);
ok(xA.health === 'low' && /30 分钟均值/.test(xA.healthMsg), `30 分钟后算力只有一半 → 标为偏低（${xA.healthMsg}）`);
globalThis.__kxRatio = 1; globalThis.__kxOpenedAgoMin = null;

console.log('— 切换失败：机器读不到标签');
globalThis.__labelBroken = true;
await e.setPool(idA, 'pearlhash');
e.st.managed[idA].sw.at = Date.now() - 9 * MIN;
await e.refreshMarket(); await e.refreshKryptex();
await e.checkSwitches(e.instances());
xA = e.instances().find(x => x.id === idA);
ok(!xA.switching && xA.wantPool === 'kryptex', '超时 8 分钟 → 判定失败，改回原矿池 Kryptex');
ok(globalThis.__labels.at(-1)[1].endsWith('pool=kryptex'), '标签也改回 pool=kryptex');
ok(logs.some(l => /切换到 Pearlhash 失败：机器没有响应切换/.test(l)), '日志说明原因：机器没有响应切换');
globalThis.__labelBroken = false;

console.log('— 批量切换');
globalThis.__switchDelay = 0;
const offB = e.offers.find(o => !o.used && o.id !== offA.id);
const idB = await e.rent(offB, 'manual');
await wait(22000);
await e.refreshVast(); await e.refreshMarket(); await e.refreshKryptex();
const r = await e.switchAll('pearlhash');
ok(r.switched === 1, `「全部切到 Pearlhash」只切了需要切的 1 台（跳过 ${r.skipped.length} 台不支持的）`);
await e.refreshMarket(); await e.refreshKryptex(); await e.checkSwitches(e.instances());
ok(e.instances().filter(x => x.switchable.length).every(x => x.pool === 'pearlhash' && !x.switching), '两台新机器都在 Pearlhash');

console.log('— 故障转移');
e.updateConfig({ failover: true, failoverMinutes: 5 });
globalThis.__pearlDown = true;
await e.refreshMarket();
e.phFailSince = Date.now() - 6 * MIN;
let list = e.instances();
await e.failover(list);       // 第一次：发现故障，开始计时
e.poolBadSince.pearlhash = Date.now() - 6 * MIN;
await e.failover(e.instances());
const fo = e.instances().filter(x => x.switchable.length);
ok(fo.every(x => x.wantPool === 'kryptex' && x.switching?.auto), `Pearlhash 接口断了 6 分钟 → ${fo.length} 台机器自动切到 Kryptex`);
ok(fo.every(x => e.st.managed[x.id].failoverFrom === 'pearlhash'), '记住它们是从 Pearlhash 转移过来的');
ok(logs.some(l => /Pearlhash 故障（接口连不上/.test(l)), '日志记录故障原因');
await e.refreshKryptex(); await e.checkSwitches(e.instances());
// 恢复：15 分钟内不切回，满 15 分钟切回
globalThis.__pearlDown = false;
await e.refreshMarket();
await e.failover(e.instances());
ok(e.instances().filter(x => x.switchable.length).every(x => x.wantPool === 'kryptex'), 'Pearlhash 刚恢复 → 先不切回（防止来回切）');
e.poolGoodSince.pearlhash = Date.now() - 16 * MIN;
await e.failover(e.instances());
ok(e.instances().filter(x => x.switchable.length).every(x => x.wantPool === 'pearlhash'), '恢复满 15 分钟 → 自动切回 Pearlhash');
ok(Object.values(e.st.managed).every(m => !m.failoverFrom), '转移标记已清除');
await e.refreshMarket(); await e.checkSwitches(e.instances());

// 两边都坏：不切
globalThis.__pearlDown = true; globalThis.__kryptexDown = true;
await e.refreshMarket(); await e.refreshKryptex();
e.phFailSince = Date.now() - 10 * MIN; e.kx.failSince = Date.now() - 10 * MIN;
e.poolBadSince = { pearlhash: Date.now() - 10 * MIN, kryptex: Date.now() - 10 * MIN };
const nLabels = globalThis.__labels.length;
await e.failover(e.instances());
ok(globalThis.__labels.length === nLabels, '两个矿池都连不上 → 不乱切');
globalThis.__pearlDown = false; globalThis.__kryptexDown = false;
await e.refreshMarket(); await e.refreshKryptex();

// 关闭开关：不切
e.updateConfig({ failover: false });
e.phFailSince = Date.now() - 10 * MIN; e.poolBadSince = { pearlhash: Date.now() - 10 * MIN };
await e.failover(e.instances());
ok(globalThis.__labels.length === nLabels, '关闭「故障自动切换」后不会切');
e.phFailSince = null;

console.log('— 收益账本');
globalThis.__kxEarned = 5;
e.kx.earnedAt = 0; await e.refreshKryptex();
const L0 = JSON.parse(JSON.stringify(e.st.ledger));
globalThis.__kxEarned = 7.5;
e.kx.earnedAt = 0; await e.refreshKryptex();
ok(Math.abs(e.st.ledger.kryptex.prl.acc - (L0.kryptex?.prl.acc || 0) - 2.5) < 1e-9, 'Kryptex 累计收益从 5 → 7.5 PRL，记 +2.5');
// 打款造成的计数回落（老口径的坑）：acc 不变、高水位不被拉低
globalThis.__kxEarned = 1;
e.kx.earnedAt = 0; await e.refreshKryptex();
ok(Math.abs(e.st.ledger.kryptex.prl.acc - (L0.kryptex?.prl.acc || 0) - 2.5) < 1e-9, '打款造成的回落不进 acc（曾经在这里把同一笔重复计入）');
ok(e.st.ledger.kryptex.prl.resets >= 1, '回落被记成 resets（口径问题的报警信号）');
// 单调口径（paid + balance）继续增长 → 正常累加
globalThis.__kxEarned = 7.9;
e.kx.earnedAt = 0; await e.refreshKryptex();
ok(Math.abs(e.st.ledger.kryptex.prl.acc - (L0.kryptex?.prl.acc || 0) - 2.9) < 1e-9, '单调口径继续增长时正常累加（+0.4）');
// 租金记到机器所在的矿池
await e.setPool(idB, 'kryptex'); await e.refreshKryptex(); await e.checkSwitches(e.instances());
list = e.instances();
const before = { ph: e.ledgerOf('pearlhash').spend, kx: e.ledgerOf('kryptex').spend };
e._accrueAt = Date.now() - 60_000;
e.accrue(list);
const dphB = list.find(x => x.id === idB).dph, dphOthersPh = list.filter(x => x.pool === 'pearlhash' && x.id !== idB && (x.status === 'running' || x.phase === 'booting')).reduce((a, x) => a + x.dph, 0);
ok(Math.abs(e.ledgerOf('kryptex').spend - before.kx - dphB / 60) < 1e-6, 'Kryptex 机器 1 分钟的租金记到 Kryptex');
ok(Math.abs(e.ledgerOf('pearlhash').spend - before.ph - dphOthersPh / 60) < 1e-6, '其余机器的租金记到 Pearlhash');
const cmp = e.compare(null);
ok(cmp.kryptex && cmp.kryptex.prl >= 2.9 && cmp.kryptex.spend > 0 && cmp.kryptex.usd > 0, `对比数据：Kryptex 实际 ${cmp.kryptex.prl.toFixed(2)} PRL，租金 $${cmp.kryptex.spend.toFixed(4)}`);
// 换钱包后不把差额算成收益
globalThis.__kxEarned = 500;
e.updateConfig({ kryptexWallet: W1 });
e.kx.earnedAt = 0; await e.refreshKryptex();
ok(Math.abs(e.st.ledger.kryptex.prl.acc - (L0.kryptex?.prl.acc || 0) - 2.9) < 1e-9, '换 Kryptex 钱包后重新起算，不会把新钱包余额当成收益');

console.log('— 默认矿池');
e.updateConfig({ defaultPool: 'kryptex' });
e.repriceOffers();
const o1 = e.offers.find(o => o.id === e.offers[0].id);
ok(e.defaultPool === 'kryptex' && Math.abs(e.usdHsHr - e.usdHsHrFor('kryptex')) < 1e-30, '默认改成 Kryptex → 市场收益率按 Kryptex 算');
ok(roiPh == null || o1.roi < roiPh + 1e-9, '同一台机器的预计收益率变低（3% 手续费、无 NOCK）');
{ const rr = e.vast.rent.bind(e.vast); e.vast.rent = async (oid, b) => { cap.push(b); return rr(oid, b); }; }
const offC = e.offers.find(o => !o.used);
let idC; try { idC = await e.rent(offC, 'manual'); } catch (x) { console.log('    rent error:', x.message, e.preflight()); }
ok(/ pool=kryptex$/.test(cap.at(-1).label) && /DEF='kryptex'/.test(cap.at(-1).onstart), '新租的机器默认挖 Kryptex');
await e.refreshVast();
e.updateConfig({ kryptexWallet: '' });
ok(e.cfg.defaultPool === 'pearlhash', '清空 Kryptex 钱包 → 默认矿池自动改回 Pearlhash');
const snap = e.snapshot();
ok(snap.pools.length === 2 && snap.pools.find(p => p.id === 'pearlhash').isDefault && snap.compare.all, '面板数据含矿池列表和收益对比');
err = null; try { await e.setPool(idC, 'kryptex'); } catch (x) { err = x.message; }
ok(/还没填钱包/.test(err || ''), 'Kryptex 钱包清空后不能再切过去');

console.log('— 快速启动模式（args）');
{
  const B = globalThis.__lastRentBody;
  ok(B.runtype === 'args' && B.onstart === 'bash' && B.args[0] === '-c' && /exec bash run\.sh$/.test(B.args[1]), '默认用 args 模式：容器直接 bash -c 运行脚本，最后前台运行 run.sh');
  ok(!/nohup bash run\.sh/.test(B.args[1]), 'args 模式下不再后台运行（否则容器会退出）');
  e.updateConfig({ launchMode: 'ssh' });
  { const rr = e.vast.rent.bind(e.vast); e.vast.rent = async (oid, b) => { cap.push(b); return rr(oid, b); }; }
  await e.rent(e.offers.find(o => !o.used), 'manual');
  const B2 = globalThis.__lastRentBody;
  ok(B2.runtype === 'ssh_proxy' && /nohup bash run\.sh/.test(B2.onstart) && !B2.args, '切回 SSH 模式：脚本作为 onstart 后台运行');
  e.updateConfig({ launchMode: 'args' });
}
console.log('— Kryptex 刚连上时的算力换算');
{
  e.updateConfig({ kryptexWallet: W2 });
  const inst = { id: 4545, label: 'prl-auto-RTX3090 pool=kryptex', gpu_name: 'RTX 3090', num_gpus: 1 };
  const exp = e.thFor('RTX 3090').effective * 1e12;
  e.kx.workers = new Map([['v4545', { live: true, hs: exp * 4 / 30, hs30: exp * 4 / 30, openedAt: Date.now() - 4 * MIN, gpus: [] }]]);
  let rp = e.rigPool(inst);
  ok(Math.abs(rp.w.hs / exp - 1) < 0.02 && rp.w.est, `连上 4 分钟、30 分钟均值只有 ${(4 / 30 * 100).toFixed(0)}% → 换算回 ${(rp.w.hs / exp * 100).toFixed(0)}% 预期`);
  e.kx.workers = new Map([['v4545', { live: true, hs: exp, hs30: exp, openedAt: Date.now() - 2 * MIN, gpus: [] }]]);
  rp = e.rigPool(inst);
  ok(rp.w.hs <= exp * 1.3 + 1, '断线重连后均值偏高 → 最多按预期 × 1.3 算，不会虚高');
  e.kx.workers = new Map([['v4545', { live: true, hs: exp * 0.9, hs30: exp * 0.9, openedAt: Date.now() - 40 * MIN, gpus: [] }]]);
  rp = e.rigPool(inst);
  ok(rp.w.hs === exp * 0.9 && !rp.w.est, '连上满 30 分钟 → 直接用 30 分钟均值');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
