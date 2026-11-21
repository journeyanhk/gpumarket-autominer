#!/usr/bin/env node
// Gate 到账监控：轮询 PEARL 余额，达到可卖线就退出并打印（不自动下单，交给人/主 Agent 决策）。
// 用法：node watch-gate.mjs [--target 1.85] [--minutes 45] [--interval 90]
import fs from 'node:fs';
import crypto from 'node:crypto';

const ENV = '/data/prl-automine/.secrets/gate.env';
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
  if (!line.includes('=')) continue;
  const i = line.indexOf('=');
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const KEY = env.GATE_API_KEY, SECRET = env.GATE_API_SECRET;
const HOST = 'https://api.gateio.ws';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TARGET = arg('--target', 1.85);
const MINUTES = arg('--minutes', 45);
const INTERVAL = arg('--interval', 90) * 1000;

const sha512 = s => crypto.createHash('sha512').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha512', k).update(s).digest('hex');

async function g(path, query = '') {
  const t = Math.floor(Date.now() / 1000).toString();
  const payload = `GET\n${path}\n${query}\n${sha512('')}\n${t}`;
  const sig = hmac(SECRET, payload);
  const r = await fetch(HOST + path + (query ? '?' + query : ''), {
    headers: { KEY, Timestamp: t, SIGN: sig, Accept: 'application/json' },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 160)}`);
  return JSON.parse(txt);
}

const started = Date.now();
let last = null;
while (Date.now() - started < MINUTES * 60000) {
  try {
    const accts = await g('/api/v4/spot/accounts');
    const pearl = accts.find(a => a.currency === 'PEARL');
    const usdt = accts.find(a => a.currency === 'USDT');
    const avail = Number(pearl?.available ?? 0);
    const ts = new Date().toISOString().slice(11, 19);
    if (avail !== last) {
      console.log(`[${ts}] PEARL 可用 ${avail.toFixed(6)} | USDT ${Number(usdt?.available ?? 0).toFixed(2)}`);
      last = avail;
    }
    if (avail >= TARGET) {
      console.log(`READY ${avail.toFixed(6)} >= ${TARGET}`);
      process.exit(0);
    }
  } catch (e) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] 查询失败：${e.message}`);
  }
  await new Promise(r => setTimeout(r, INTERVAL));
}
console.log(`TIMEOUT 等待 ${MINUTES} 分钟仍未到 ${TARGET}（最后 ${last ?? '—'}）`);
process.exit(3);