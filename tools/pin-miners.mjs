#!/usr/bin/env node
// 矿工版本 pin 工具。升级矿工唯一被允许的方式：
//   node tools/pin-miners.mjs --check      # 看看上游有没有新版本 / 清单里的哈希还对不对（不写文件）
//   node tools/pin-miners.mjs --bump wr    # 把某个矿工 pin 到最新版（会真的下载并复算 sha256）
// 之后人工 review `git diff miners/manifest.json` 再提交。
//
// 安全约定：
//   - 只接受 GitHub Release 资产；
//   - 新哈希必须与 GitHub 返回的 digest 一致，并且本地下载复算一致，两个来源都过才写；
//   - 写盘前用 src/miners.js 的 validateManifest 再校验一遍。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadManifest, validateManifest, MANIFEST_PATH } from '../src/miners.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GH = 'https://api.github.com';
// 未认证只有 60 次/小时，容易撞限流；可以给 GITHUB_TOKEN 提高配额（只需要公共读）
const AUTH = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const headers = () => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'prl-autominer-pin',
  ...(AUTH ? { Authorization: `Bearer ${AUTH}` } : {}),
});

const argv = process.argv.slice(2);
const has = k => argv.includes(`--${k}`);
const arg = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

async function ghRelease(repo, tag) {
  const url = tag ? `${GH}/repos/${repo}/releases/tags/${tag}` : `${GH}/repos/${repo}/releases/latest`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`GitHub ${r.status}：${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// 挑 Linux 包：跳过 hiveos / custom 变体，优先 tar.gz/tar.xz
function pickLinuxAsset(assets, preferred) {
  const list = (assets || []).filter(a => /linux/i.test(a.name) && /\.tar\.(gz|xz)$/i.test(a.name) && !/hive|custom|\.md5/i.test(a.name));
  if (preferred) {
    const hit = list.find(a => a.name === preferred);
    if (hit) return hit;
  }
  return list[0] || null;
}

async function downloadSha256(url) {
  const tmp = path.join(os.tmpdir(), `pin-${crypto.randomUUID()}.tar`);
  const r = await fetch(url, { headers: { 'User-Agent': 'prl-autominer-pin' } }); // 资产下载：不带 token，避免把凭据发给对象存储
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const h = crypto.createHash('sha256');
  await new Promise((ok, bad) => {
    const out = fs.createWriteStream(tmp);
    const body = r.body;
    body.on('data', c => h.update(c));
    body.on('error', bad);
    body.pipe(out);
    out.on('error', bad);
    out.on('finish', ok);
  });
  const size = fs.statSync(tmp).size;
  fs.rmSync(tmp, { force: true });
  return { sha256: h.digest('hex'), size };
}

function save(man, file) {
  const errors = validateManifest(man);
  if (errors.length) throw new Error(`写盘前校验失败：${errors.join('；')}`);
  man.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(man, null, 2) + '\n');
}

const man = loadManifest();
const file = MANIFEST_PATH;
const bins = Object.keys(man.miners);

if (has('check')) {
  let bad = 0;
  for (const bin of bins) {
    const m = man.miners[bin];
    try {
      const rel = await ghRelease(m.repo);
      const asset = pickLinuxAsset(rel.assets, m.file);
      if (!asset) { console.log(`  ! ${bin} 最新发行版里没找到 Linux 包`); bad++; continue; }
      const digest = String(asset.digest || '').replace(/^sha256:/, '');
      const newest = rel.tag_name !== m.version;
      const digestMismatch = digest && digest !== m.sha256;
      const sameAsset = asset.name === m.file;
      const state = newest ? `有新版本 ${rel.tag_name}` : (sameAsset ? '已是最新' : `同名版本但文件名变了（${asset.name}）`);
      if (digestMismatch) bad++;
      console.log(`  ${newest || digestMismatch ? '!' : '✓'} ${bin} pin=${m.version} ${state}${digestMismatch ? ' · 且 digest 与清单不一致！' : ''}`);
    } catch (e) {
      console.log(`  ! ${bin} 检查失败：${e.message}`);
      bad++;
    }
  }
  console.log(bad ? `\n有 ${bad} 项需要处理（用 --bump <bin> 升级）` : '\n全部与上游一致');
  process.exit(bad ? 1 : 0);
}

const bump = arg('bump');
if (bump) {
  const m = man.miners[bump];
  if (!m) { console.error(`清单里没有 ${bump}`); process.exit(2); }
  const rel = await ghRelease(m.repo);
  if (rel.tag_name === m.version && !has('force')) {
    console.log(`${bump} 已经是 ${m.version}（要强制重算加 --force）`);
    process.exit(0);
  }
  const asset = pickLinuxAsset(rel.assets, m.file);
  if (!asset) { console.error('最新发行版里没有 Linux tar 包'); process.exit(2); }
  const ghDigest = String(asset.digest || '').replace(/^sha256:/, '');
  const local = await downloadSha256(asset.browser_download_url);
  if (ghDigest && ghDigest !== local.sha256) {
    console.error(`哈希冲突：GitHub digest=${ghDigest} 本地复算=${local.sha256}，拒绝写入`);
    process.exit(3);
  }
  Object.assign(m, {
    version: rel.tag_name,
    file: asset.name,
    url: asset.browser_download_url,
    sha256: local.sha256,
    pinnedAt: new Date().toISOString().slice(0, 10),
    pinnedBy: ghDigest ? 'digest+recompute' : 'recompute',
  });
  save(man, file);
  console.log(`${bump} → ${rel.tag_name}\n  ${asset.name}  ${(local.size / 1048576).toFixed(1)} MB\n  sha256=${local.sha256}\n\n记得 review 并提交 miners/manifest.json（必要时同步 README 的版本说明）`);
  process.exit(0);
}

console.log(`用法：
  node tools/pin-miners.mjs --check           检查 pin 是否落后于上游、digest 是否一致
  node tools/pin-miners.mjs --bump <bin>      升级到最新版（bin: ${bins.join(' / ')}）
清单文件：${path.relative(ROOT, file)}`);