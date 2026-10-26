// 矿工二进制白名单：只认 miners/manifest.json 里 pin 过的「版本 + sha256」。
// 上游的做法是「从 3 个第三方镜像并行下载，谁先下完用谁，只检查 tar 结构」——等于给 root 权限开了后门。
// 这里的原则：镜像可以加速传输，但每个候选包在解压前都必须过 sha256；全部失败则不执行任何二进制。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(ROOT, 'miners', 'manifest.json');

const SHA256_RE = /^[a-f0-9]{64}$/;
const URL_RE = /^https:\/\/[^\s'"]+$/;
const EXEC_RE = /^[A-Za-z0-9._-]+$/;
// 只允许从 GitHub Release（含其重定向到的对象存储）下载源码包
const TRUSTED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export function validateManifest(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['清单不是对象'];
  if (data.schema !== 1) errors.push(`schema 必须是 1（当前 ${data.schema}）`);
  const miners = data.miners;
  if (!miners || typeof miners !== 'object' || !Object.keys(miners).length) errors.push('miners 为空');
  for (const [bin, m] of Object.entries(miners || {})) {
    const at = `miners.${bin}`;
    if (!m || typeof m !== 'object') { errors.push(`${at} 不是对象`); continue; }
    if (!m.name) errors.push(`${at}.name 缺失`);
    if (!m.version) errors.push(`${at}.version 缺失`);
    if (!SHA256_RE.test(String(m.sha256 || ''))) errors.push(`${at}.sha256 必须是 64 位小写 hex`);
    if (!EXEC_RE.test(String(m.exec || ''))) errors.push(`${at}.exec 只允许字母数字和 ._-`);
    if (!URL_RE.test(String(m.url || ''))) { errors.push(`${at}.url 必须是 https 且不含引号/空格`); continue; }
    let u;
    try { u = new URL(m.url); } catch { errors.push(`${at}.url 无法解析`); continue; }
    if (!TRUSTED_HOSTS.has(u.hostname)) errors.push(`${at}.url 不在可信主机内（${u.hostname}）`);
    if (!u.pathname.includes('/releases/download/')) errors.push(`${at}.url 必须是 Release 资产地址`);
    if (m.file && !EXEC_RE.test(String(m.file))) errors.push(`${at}.file 含不允许的字符`);
  }
  return errors;
}

export function loadManifest(file = MANIFEST_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到矿工清单 ${path.relative(ROOT, file) || file}：${e.code || e.message}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`矿工清单不是合法 JSON：${e.message}`); }
  const errors = validateManifest(data);
  if (errors.length) throw new Error(`矿工清单不合法：${errors.join('；')}`);
  return { ...data, file };
}

// 取某个矿工的 pin；没有就抛（调用方负责转成可读的 preflight 文案）
export function minerFor(bin, manifest) {
  const m = manifest?.miners?.[bin];
  if (!m) throw new Error(`矿工 ${bin} 没有 pin 版本（miners/manifest.json）`);
  return m;
}

export function sha256FileSync(file) {
  const h = crypto.createHash('sha256');
  const buf = fs.readFileSync(file);
  h.update(buf);
  return h.digest('hex');
}

export async function verifyFileSha256(file, expected) {
  if (!SHA256_RE.test(String(expected || ''))) return false;
  const h = crypto.createHash('sha256');
  await new Promise((ok, bad) => {
    const s = fs.createReadStream(file);
    s.on('data', c => h.update(c));
    s.on('error', bad);
    s.on('end', ok);
  });
  // 用 timingSafeEqual 没有意义（不是密钥比较），直接比 hex
  return h.digest('hex') === expected;
}

export function shortSha(sha) {
  return String(sha || '').slice(0, 12);
}