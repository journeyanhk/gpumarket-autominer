// 单位锚点测试（离线）：锚点文件本身要能被断言，而不是只在工具里打印。
// 判据：①每个锚点有 source 与 ratio；②ratio ∈ [0.8,1.25]；③每卡算力表用到的算法要么有锚点、要么显式 pending。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] || process.cwd();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const file = path.join(root, 'tools', 'unit-anchors.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const anchors = data.anchors || {};

console.log('— 锚点文件：每个算法一条，带来源与比值');
{
  ok(Object.keys(anchors).length >= 3, `锚点 ${Object.keys(anchors).length} 个（≥3）`);
  for (const [algo, a] of Object.entries(anchors)) {
    ok(!!a.source, `${algo} 有独立来源`);
    if (a.status === 'pending') { ok(true, `${algo} 标记 pending（该算法的币只能 watch）`); continue; }
    ok(a.ratio >= 0.8 && a.ratio <= 1.25, `${algo} ratio=${a.ratio} ∈ [0.8, 1.25]`);
    ok(a.anchorHashrate > 0, `${algo} 记录了锚点原始值（可离线复算）`);
  }
}

console.log('— 每卡算力表覆盖：用到的算法必须"有锚点 或 显式 pending"');
{
  // 算力表在 src/m3/hashrate.js（会随 src 一起复制到测试副本），不从 tools 里正则抠
  const { CARD_HASHRATE_TH } = await import(pathToFileURL(path.join(root, 'src', 'm3', 'hashrate.js')).href);
  const algos = Object.keys(CARD_HASHRATE_TH).filter(a => a !== 'pearl');
  ok(algos.length >= 4, `算力表含 ${algos.length} 个算法`);
  const missing = algos.filter(a => !anchors[a]);
  ok(missing.length === 0, `全部有锚点条目${missing.length ? `（缺 ${missing.join('、')}）` : ''}`);
  // 未标 pending 且有锚点的算法，其 ratio 必须已通过
  const bad = algos.filter(a => anchors[a] && anchors[a].status !== 'pending' && !(anchors[a].ratio >= 0.8 && anchors[a].ratio <= 1.25));
  ok(bad.length === 0, `无锚点失败的算法${bad.length ? `（${bad.join('、')}）` : ''}`);
}

console.log('— 反例：范围启发式不是单位测试');
{
  // 用户的 RVN $0.0101 落在 [1e-4,1] 内，但如果单位错 10 倍它依然"通过"——说明范围过滤无效
  const inRange = (v) => v >= 1e-4 && v <= 1;
  ok(inRange(0.0101) && inRange(0.101), '同一个数错 10 倍仍落在范围里 → 范围过滤拦不住单位错误');
}

console.log(fail ? `\n锚点测试失败：${fail} 项` : `\n锚点测试通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
