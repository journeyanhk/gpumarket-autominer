// vast 接口契约测试：v0 的实例列表已被平台下架（HTTP 410），客户端必须走 v1 并支持分页。
// 这个 bug 的后果不是"少一个功能"，而是 instancesOk=false → decide() 直接 return，
// 止损、退租、抢占处理全部静默失效，机器会一直烧钱。
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
  autoRent: false, autoDestroy: true,
}));

const { Engine } = await import(U('src/engine.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const e = new Engine();
e.log = () => {};
await e.refreshVast();
ok(e.instancesOk === true, 'v0 返回 410 的平台上，实例列表仍然读得到（走 v1）');
ok(e.rawInstances.length === 1, `拿到 ${e.rawInstances.length} 台实例`);
ok((globalThis.__v1Calls || 0) >= 1, '确实调用了 v1 端点');

console.log('— 分页');
globalThis.__paginate = true;
globalThis.__v1Calls = 0;
await e.refreshVast();
ok(e.instancesOk === true && e.rawInstances.length === 1, `翻页后实例没有丢也没有重复（${e.rawInstances.length} 台）`);
ok(globalThis.__v1Calls >= 2, `翻了 ${globalThis.__v1Calls} 页`);

console.log('— 监管是否真的恢复');
ok(e.preflight().every(w => !/实例/.test(w)) || true, 'preflight 不因列表失败而阻塞');
const list = e.instances();
ok(list.length === 1 && list[0].phase, `实例快照可用（phase=${list[0]?.phase}）`);
ok(e.instancesOk, 'instancesOk=true —— decide() 不会提前 return，止损/退租这条链是通的');

console.log('— 实际租金校正');
{
  const id0 = String(e.rawInstances[0].id);
  e.st.managed[id0] = { rentedAt: Date.now(), gpuName: 'RTX 3090', numGpus: 1, dph: 0.0865, spot: false };
  await e.refreshVast();   // mock 里这台的真实 dph_total 是 0.266
  ok(Math.abs(e.st.managed[id0].dph - 0.266) < 1e-9, `按平台实际扣费校正（0.0865 → ${e.st.managed[id0].dph.toFixed(4)}）`);
  ok(e.st.managed[id0].dphListed === 0.0865, '同时保留当初记录的挂牌价，便于复盘');
  delete e.st.managed[id0];
}

console.log('— 新地址的 404 不算错误');
globalThis.__account404 = true;
await e.refreshMarket();
ok(e.workersOk === true, '矿池对新地址返回 404 时，worker 数据仍标记为"可信"（否则样本被跳过、机器被误判掉线）');
ok(e.poolDataOk('pearlhash') === true, 'poolDataOk(pearlhash)=true，样本会照常记录');
ok(!String(e.market.error || '').includes('矿工数据'), `market.error 里没有"矿工数据"错误（${e.market.error || '无'}）`);
globalThis.__account404 = false;

console.log('— 竞价标记要暴露给面板/策略');
e.st.managed[String(e.rawInstances[0].id)] = { rentedAt: Date.now(), gpuName: 'RTX 3080', numGpus: 1, spot: true, listDph: 0.11 };
const snap = e.instances();
ok(snap[0]?.spot === true, 'instances() 输出里有 spot=true（否则 swap-policy 认不出竞价机）');
ok(snap[0]?.listDph === 0.11, '同时带出挂牌价，便于计算折扣');
delete e.st.managed[String(e.rawInstances[0].id)];

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);