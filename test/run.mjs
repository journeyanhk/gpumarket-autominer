// 运行全部测试：先把程序复制到系统临时目录，再在副本里跑（测试会清空 data，绝不能在你正在用的目录里直接跑）
// 所有外部接口（vast / Pearlhash / Kryptex / GitHub / CoinGecko）都由 test/mock.mjs 模拟，不会真的租机器或花钱
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let failed = 0;
for (const t of ['logic-test.mjs', 'pool-test.mjs', 'miner-test.mjs', 'spot-test.mjs', 'price-test.mjs', 'vast-test.mjs', 'sources-test.mjs']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-test-'));
  for (const f of ['server.js', 'package.json', 'src', 'public', 'miners']) fs.cpSync(path.join(root, f), path.join(tmp, f), { recursive: true });
  console.log(`\n=== ${t}（临时目录 ${tmp}）`);
  const r = spawnSync(process.execPath, ['--import', path.join(here, 'mock.mjs'), path.join(here, t), tmp], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 组测试失败` : '\n全部测试通过');
process.exit(failed ? 1 : 0);
