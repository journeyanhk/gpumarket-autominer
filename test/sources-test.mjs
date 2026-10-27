// 多源收入密度测试：三个来源差 20%+，选错源就把负收益看成正收益。
// 这些数字取自 2026-10-27 02:42 UTC 的实测（Pearlhash / Kryptex / WhatToMine）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href;
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');

const { pickDensity, densityOf } = await import(U('src/sources.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const S = {
  pearlhash: { usd: 1.77, networkHs: 91.30e18, blockTime: 152.1, reward: 2218.82 },
  kryptex: { usd: 1.77, networkHs: 88.46e18, blockTime: 194.0, reward: 2218.75 },
  whattomine: { usd: 1.77, networkHs: 88.51e18, blockTime: 154.0, reward: 2218.72 },
};

console.log('— 单源公式');
ok(Math.abs(densityOf({ ...S.kryptex, fee: 0.01 }) - 0.01957) < 2e-4, `Kryptex 口径 $${densityOf({ ...S.kryptex, fee: 0.01 }).toFixed(5)}/TH·天`);
ok(Math.abs(densityOf({ ...S.pearlhash, fee: 0.01 }) - 0.02419) < 2e-4, `Pearlhash 口径 $${densityOf({ ...S.pearlhash, fee: 0.01 }).toFixed(5)}/TH·天`);

console.log('— 选源策略');
const min = pickDensity(S, 'min');
ok(min.src === 'kryptex' && Math.abs(min.density - 0.01957) < 2e-4, `min → ${min.src} $${min.density.toFixed(5)}（最保守）`);
const max = pickDensity(S, 'max');
ok(max.src === 'whattomine' && max.density > min.density, `max → ${max.src} $${max.density.toFixed(5)}`);
const med = pickDensity(S, 'median');
ok(med.density >= min.density && med.density <= max.density, `median 落在区间内（$${med.density.toFixed(5)}）`);
ok(pickDensity(S, 'pearlhash').src === 'pearlhash', '可以强制指定单一路径');
ok(pickDensity(S, 'kryptex').density < pickDensity(S, 'pearlhash').density, '保守源确实低于乐观源（这正是门槛落在分歧区间的原因）');

console.log('— 退化情况');
ok(pickDensity({}, 'min').density === 0, '没有源 → 0（fail-closed）');
ok(pickDensity({ pearlhash: S.pearlhash }, 'min').src === 'pearlhash', '只剩一个源时就用它');
ok(pickDensity({ pearlhash: { ...S.pearlhash, reward: 0 } }, 'min').density === 0, '字段缺失 → 0，不编数');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);