#!/usr/bin/env node
// 补齐 config.json 里缺失的键（只补，不改已存在的值）。
// 用途：引擎启动时如果报"配置缺 N 个键"，跑这个脚本再重启即可。
//   node tools/fix-config.mjs            # 预览
//   node tools/fix-config.mjs --write    # 实际写入（会先备份 config.json.bak）
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, missingConfigKeys, DATA_DIR } from '../src/store.js';

const file = path.join(DATA_DIR, 'config.json');
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

const miss = missingConfigKeys(saved);
if (!miss.length) {
  console.log('配置完整，无需补键');
  process.exit(0);
}
console.log(`缺 ${miss.length} 个键：`);
for (const k of miss) console.log('  -', k);

if (!process.argv.includes('--write')) {
  console.log('\n（预览模式；加 --write 才会写入）');
  process.exit(0);
}

// 只把**缺失路径**从默认值里补回来，已有值一律不动
function put(obj, defaults, parts) {
  const [k, ...rest] = parts;
  if (rest.length === 0) { if (!(k in obj)) obj[k] = structuredClone(defaults[k]); return; }
  if (obj[k] == null || typeof obj[k] !== 'object') obj[k] = {};
  put(obj[k], defaults[k], rest);
}
for (const k of miss) put(saved, DEFAULT_CONFIG, k.split('.'));

fs.copyFileSync(file, `${file}.bak`);
fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
console.log(`\n已写入 ${file}（备份 ${file}.bak）。重启引擎生效。`);