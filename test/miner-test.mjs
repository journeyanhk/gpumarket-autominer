// 矿工白名单测试：清单校验、pin 是否进了开机脚本、下载校验是否真的会拦下错包。
// 不联网：所有哈希都在本地算，shell 片段用 bash 真跑一遍。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href;
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');

const M = await import(U('src/miners.js'));
const O = await import(U('src/onstart.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

console.log('— 清单本身');
const man = M.loadManifest();
const bins = Object.keys(man.miners);
ok(bins.length >= 2 && bins.includes('wr') && bins.includes('srb'), `清单里有 ${bins.join('、')}`);
ok(bins.every(b => /^[a-f0-9]{64}$/.test(man.miners[b].sha256)), '每个矿工都有 64 位 sha256');
ok(man.miners.wr.exec === 'wildrig-multi' && man.miners.srb.exec === 'SRBMiner-MULTI', '可执行文件名与上游约定一致（find 才找得到）');
ok(bins.every(b => man.miners[b].url.includes(`/${man.miners[b].version}/`)), '下载地址里的版本号与 pin 的版本一致');
ok(bins.every(b => new URL(man.miners[b].url).host === 'github.com'), '只从 GitHub Release 下载');

console.log('— 清单会被拒绝的情况');
const bad = (mut, re) => {
  const copy = JSON.parse(JSON.stringify(man));
  mut(copy);
  return throws(() => {
    const errs = M.validateManifest(copy);
    if (errs.length) throw new Error(errs.join('；'));
  }, re);
};
ok(bad(m => { m.miners.wr.sha256 = 'abc'; }, /sha256/), 'sha256 位数不对 → 拒绝');
ok(bad(m => { m.miners.wr.url = 'http://github.com/x/releases/download/1/a.tar.gz'; }, /url/), '非 https 地址 → 拒绝');
ok(bad(m => { m.miners.wr.url = 'https://evil.example.com/releases/download/1/a.tar.gz'; }, /可信主机/), '非 GitHub 主机 → 拒绝');
ok(bad(m => { m.miners.wr.url = "https://github.com/a'b/releases/download/1/a.tar.gz"; }, /url/), '带引号的地址（shell 注入）→ 拒绝');
ok(bad(m => { m.miners.wr.exec = 'wildrig; rm -rf /'; }, /exec/), '可执行文件名含空格/分号 → 拒绝');
ok(bad(m => { m.miners = {}; }, /为空/), '清单里一个矿工都没有 → 校验失败');
ok(M.validateManifest((() => { const c = JSON.parse(JSON.stringify(man)); delete c.miners.srb; return c; })()).length === 0, '只 pin 了部分矿工是合法的（那个矿池就不能用）');

console.log('— 开机脚本');
const pools = [
  { id: 'pearlhash', bin: 'wr', cmd: '--algo pearlhash --url stratum+ssl://p:1 --user w --worker $W' },
  { id: 'kryptex', bin: 'srb', cmd: '--algorithm pearlhash --pool prl.kryptex.network:7048 --wallet w.$W' },
];
const script = O.buildOnstart({ pools, def: 'pearlhash', miners: man.miners, foreground: true });
ok(bins.every(b => script.includes(`SHA=${man.miners[b].sha256}`)), '两个矿工的 sha256 都写进了脚本');
ok(bins.every(b => script.includes(`F=${man.miners[b].exec}`)), '包内可执行文件名写进了脚本');
ok(script.includes('[ "$(sha256sum "$D/$i.part" 2>/dev/null | cut -d" " -f1)" = "$SHA" ]'), '每个下载候选包在解压前都要过 sha256');
ok(script.includes('|| wget -q -T 15 -t 1 -O $D/$i.part "$U") && [ "$(sha256sum'), '下载完成后立刻校验，没有「先解压再看」的旁路');
ok(script.includes('没有下载源通过 sha256 校验'), '全部源都不对时给出明确失败原因');
ok(script.includes('command -v sha256sum'), '机器上没有 sha256sum 时拒绝执行（fail-closed）');
ok(/while true; do sleep 300; stats/.test(script) && script.includes('http://127.0.0.1:21555/'), 'v7：每 5 分钟采样一次（SRBMiner API 21555）');
ok(script.includes('tr -d "\\n\\r"'), 'v7：JSON 压成单行，保证一行可解析');
ok(O.SCRIPT_VERSION === 7, '脚本版本号 7（v7：stats 把 JSON 压成单行，否则日志里只有 "{"）');

console.log('— 没 pin 就不许租');
ok(throws(() => O.buildOnstart({ pools, def: 'pearlhash', miners: { wr: man.miners.wr } }), /srb.*没有 pin|没有 pin/), '缺 srb 的 pin → 直接抛错（不会降级）');
ok(throws(() => O.buildOnstart({ pools, def: 'pearlhash', miners: { ...man.miners, wr: { ...man.miners.wr, sha256: 'x' } } }), /sha256/), 'sha256 不合法 → 抛错');

console.log('— 本地文件校验');
const tmp = path.join(dir, 'tmp-miner-pkg.tar.gz');
fs.writeFileSync(tmp, 'pretend this is a tarball');
const good = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
ok(await M.verifyFileSha256(tmp, good), '内容一致 → 通过');
ok(!(await M.verifyFileSha256(tmp, '0'.repeat(64))), '内容被换过 → 拒绝');
ok(!(await M.verifyFileSha256(tmp, 'not-a-hash')), '哈希格式不对 → 拒绝（不会当成通过）');
fs.rmSync(tmp);

console.log('— shell 片段真的能判对错');
const sh = path.join(dir, 'tmp-hash.txt');
fs.writeFileSync(sh, 'payload');
const hex = crypto.createHash('sha256').update('payload').digest('hex');
const run = sha => execFileSync('bash', ['-c', `V=$(sha256sum ${sh} | cut -d" " -f1); [ "$V" = "${sha}" ] && echo ok || echo bad`]).toString().trim();
ok(run(hex) === 'ok', 'bash 用同样的写法能认出正确的包');
ok(run('0'.repeat(64)) === 'bad', 'bash 用同样的写法会拒绝错误的包');
fs.rmSync(sh);

console.log('— 端到端：真实 bash + 真包（review #8）');
{
  const rig = path.join(dir, 'rig');
  const build = (name, body) => {
    const d = path.join(dir, `pkg-${name}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'wildrig-multi'), body);
    const tar = path.join(dir, `${name}.tar.gz`);
    execFileSync('tar', ['czf', tar, '-C', d, 'wildrig-multi']);
    return tar;
  };
  const goodTar = build('good', '#!/bin/sh\necho good-miner\n');
  const badTar = build('bad', '#!/bin/sh\necho TAMPERED\n');
  const goodSha = crypto.createHash('sha256').update(fs.readFileSync(goodTar)).digest('hex');

  const full = O.buildOnstart({ pools, def: 'pearlhash', miners: man.miners, foreground: true });
  // 从生成的脚本里抽出 ensure() 和日志函数，原样跑（只把 /root/prl 换成临时目录）
  const i0 = full.indexOf('ensure(){');
  const i1 = full.indexOf('"; }', i0);
  const ensureFn = full.slice(i0, i1 + 4).replaceAll('/root/prl', () => '$RIG');
  const logFns = [...new Set(full.split('\n').filter(l => /^\s*(out|log)\(\)\{/.test(l)))]
    .map(l => l.replaceAll('/root/prl', () => '$RIG')); // 日志也要写到临时目录，否则会去写 /root
  const harness = (urls) => [
    `RIG=${JSON.stringify(rig)}`,
    ...logFns,
    ensureFn.replace(/^\s+wr\) F=.*$/m, `  wr) F=wildrig-multi; SHA=${goodSha}; URLS="${urls}";;`),
    'ensure wr; echo "EXIT=$?"',
  ].join('\n');

  const clean = () => fs.rmSync(rig, { recursive: true, force: true });
  clean();

  // 1) 镜像先返回被篡改的包、后返回真包：只能接受真包
  const out1 = execFileSync('bash', ['-c', harness(`file://${badTar} file://${goodTar}`)], { cwd: dir, encoding: 'utf8' });
  ok(/EXIT=0/.test(out1), '混合源（先篡改后真包）→ 最终成功');
  ok(fs.existsSync(path.join(rig, 'wr')), '产出了 wr 软链');
  ok(fs.readFileSync(path.join(rig, 'wr'), 'utf8').includes('good-miner'), '软链指向真包里的二进制（不是被篡改的那个）');
  ok(!fs.readFileSync(path.join(rig, 'wr'), 'utf8').includes('TAMPERED'), '被篡改的包没有被解压使用');

  // 2) 只有被篡改的包：必须失败，而且不留下任何可执行文件
  clean();
  const out2 = execFileSync('bash', ['-c', harness(`file://${badTar}`)], { cwd: dir, encoding: 'utf8' });
  ok(/EXIT=1/.test(out2), '只有篡改包 → ensure 返回 1');
  const bootLog = fs.existsSync(path.join(rig, 'boot.log')) ? fs.readFileSync(path.join(rig, 'boot.log'), 'utf8') : '';
  ok(/没有下载源通过 sha256 校验/.test(bootLog + out2), '失败原因写进 boot.log：没有下载源通过 sha256 校验');
  ok(!fs.existsSync(path.join(rig, 'wr')), '没有产出 wr 软链（不会执行来路不明的二进制）');
}

console.log('— 引擎在清单不可用时不租');
const { Engine } = await import(U('src/engine.js'));
const e = new Engine();
e.log = () => {};
e.minerManifest = null;
e.minerError = '模拟：清单损坏';
ok(e.preflight().some(w => /矿工清单不可用/.test(w)), 'preflight 直接把「清单不可用」列成拦截原因');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);