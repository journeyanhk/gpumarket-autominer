#!/usr/bin/env node
// 盈亏线计算器（只读）：把「链上产出」折算成「每 TH 每天收入」和每张卡的盈亏线租金。
//
// 数据源刻意做了三路交叉（review #6）：原来只用 Pearlhash 一家，而它既是收益仲裁者又是成本计算器。
//   - Pearlhash : 自己的 /api/chain-info + /api/pool-wallet-txs（coinbase 的 receivedGrains）
//   - Kryptex   : pool.kryptex.com/prl/api/v1/pool/info（net_hashrate / block_time / block_reward）
//   - WhatToMine: whattomine.com/coins.json 的 Pearl 条目
// 三路的全网算力实测会差 10~20%，所以输出里同时给「中位数」和「最大分歧」，不要只看一个数。
//
// 用法：
//   node tools/breakeven.mjs                        # 拉三路实时数据，打印盈亏线表
//   node tools/breakeven.mjs --json                 # 机器可读
//   node tools/breakeven.mjs --price 1.74 --network 96e18 --blocktime 166 --reward 2221 --source pearlhash
//                                                   # 断网/回放：手填一个源
//   node tools/breakeven.mjs --loop 300 --csv data/breakeven.csv
//                                                   # 每 5 分钟记一行（M1.5 的行情记录器）
//
// 只依赖项目自带的 src/pearl.js / src/gpus.js，保证「算盈亏」和「程序决策」用同一套公式。
import fs from 'node:fs';
import path from 'node:path';
import { fetchPrice, POOL_FEE } from '../src/pearl.js';
import { hashrateTable } from '../src/gpus.js';

const argv = process.argv.slice(2);
const has = k => argv.includes(`--${k}`);
const val = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const num = (k, d = null) => {
  const v = val(k);
  if (v === null) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) { console.error(`参数 --${k} 不是数字：${v}`); process.exit(2); }
  return n;
};
const json = has('json');
const FEE = num('fee', POOL_FEE); // 统一按这个池费折算，否则「3% vs 1%」会被误读成数据源分歧
const loopSec = num('loop', 0);
const csvPath = val('csv');

const fmt = (n, d = 4) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const median = a => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- 三个数据源 ----------
const SOURCES = [
  {
    id: 'pearlhash', label: 'Pearlhash',
    async load() {
      const [chain, txs] = await Promise.all([
        fetch('https://pearlhash.xyz/api/chain-info', { headers: { Accept: 'application/json' } }).then(r => r.json()),
        fetch('https://pearlhash.xyz/api/pool-wallet-txs?page=1', { headers: { Accept: 'application/json' } }).then(r => r.json()),
      ]);
      const cb = (txs?.transactions || []).find(t => t.type === 'coinbase' && t.receivedGrains > 0);
      if (!(chain?.networkhashps > 0)) throw new Error('chain-info 缺 networkhashps');
      if (!cb) throw new Error('没找到最新 coinbase');
      return {
        networkHs: chain.networkhashps,
        blockTime: chain.avg_block_time_s > 0 ? chain.avg_block_time_s : 166,
        reward: cb.receivedGrains / 1e8,
        height: chain.blocks,
      };
    },
  },
  {
    id: 'kryptex', label: 'Kryptex', commission: 0.03,
    async load() {
      const r = await fetch('https://pool.kryptex.com/prl/api/v1/pool/info', { headers: { Accept: 'application/json' } }).then(x => x.json());
      if (!(Number(r?.net_hashrate) > 0)) throw new Error('pool/info 缺 net_hashrate');
      return {
        networkHs: Number(r.net_hashrate),
        blockTime: Number(r.block_time) || 166,
        reward: Number(r.block_reward),
        height: r.height ?? null,
      };
    },
  },
  {
    id: 'whattomine', label: 'WhatToMine',
    async load() {
      const r = await fetch('https://whattomine.com/coins.json', { headers: { Accept: 'application/json' } }).then(x => x.json());
      const c = r?.coins?.Pearl;
      if (!(Number(c?.nethash) > 0)) throw new Error('coins.json 里没有 Pearl.nethash');
      return {
        networkHs: Number(c.nethash),
        blockTime: Number(c.block_time) || 166,
        reward: Number(c.block_reward),
        height: null,
      };
    },
  },
];

const usdPerThDay = ({ price, networkHs, blockTime, reward, fee }) => {
  if (!(price > 0 && networkHs > 0 && blockTime > 0 && reward > 0)) return 0;
  return (3600 / blockTime) * reward / networkHs * (1 - fee) * price * 1e12 * 24;
};

// 价格：默认用 Pearlhash 的报价（它在净值里是最保守的一个），可以用 --price 覆盖
async function resolvePrice() {
  const fixed = num('price');
  if (fixed) return { usd: fixed, src: '手动' };
  const p = await fetchPrice();
  return { usd: p.usd, src: 'Pearlhash' };
}

// 手动模式：只算一个源
function manualSource() {
  const network = num('network');
  const blockTime = num('blocktime');
  const reward = num('reward');
  const id = val('source') || 'manual';
  if (!(network > 0 && blockTime > 0 && reward > 0)) return null;
  return { id, label: `${id}（手填）`, ok: true, networkHs: network, blockTime, reward, height: null };
}

async function collect() {
  const price = await resolvePrice();
  const manual = manualSource();
  const rows = manual ? [manual] : [];
  const errors = [];
  if (!manual) {
    const results = await Promise.allSettled(SOURCES.map(s => s.load()));
    results.forEach((r, i) => {
      const s = SOURCES[i];
      if (r.status === 'fulfilled') rows.push({ id: s.id, label: s.label, ok: true, ...r.value });
      else { errors.push(`${s.label}：${r.reason?.message || r.reason}`); rows.push({ id: s.id, label: s.label, ok: false, error: r.reason?.message }); }
    });
  }
  for (const r of rows) if (r.ok) r.usdPerThDay = usdPerThDay({ price: price.usd, fee: FEE, ...r, fee: FEE });
  const good = rows.filter(r => r.ok && r.usdPerThDay > 0);
  const densities = good.map(r => r.usdPerThDay);
  const med = median(densities);
  const spread = med > 0 ? (Math.max(...densities) - Math.min(...densities)) / med * 100 : null;
  for (const r of good) r.vsMedianPct = med > 0 ? (r.usdPerThDay - med) / med * 100 : null;
  return { price, rows, med, spread, errors, good };
}

function gpuRows(densityPerDay) {
  return hashrateTable().map(g => {
    const breakEvenHr = g.effective * densityPerDay / 24; // TH × ($/TH·天) ÷ 24h
    return {
      key: g.key, name: g.name, th: g.effective, source: g.source, autoOk: g.autoOk,
      usdDay: breakEvenHr * 24, breakEvenHr,
    };
  });
}

function printReport({ price, rows, med, spread, errors, good }) {
  console.log('');
  console.log(`PRL 盈亏线 · ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · 价格 $${fmt(price.usd, 3)}（${price.src}）· 统一按 ${(FEE * 100).toFixed(1)}% 池费折算`);
  console.log('');
  console.log('  数据源            全网算力      出块    区块奖励    $/TH·天   相对中位数');
  for (const r of rows) {
    if (!r.ok) { console.log(`  ${r.label.padEnd(16)} 不可用：${String(r.error).slice(0, 60)}`); continue; }
    console.log(`  ${r.label.padEnd(16)} ${(r.networkHs / 1e18).toFixed(2).padStart(6)} EH/s ${fmt(r.blockTime, 1).padStart(7)}s ${fmt(r.reward, 2).padStart(10)} ${fmt(r.usdPerThDay, 5).padStart(9)}   ${r.vsMedianPct == null ? '' : (r.vsMedianPct >= 0 ? '+' : '') + r.vsMedianPct.toFixed(1) + '%'}`);
  }
  if (good.length > 1) console.log(`\n  三路分歧 ${fmt(spread, 1)}%（${good.length} 个源）；中位数 $${fmt(med, 5)} / TH·天`);
  else if (good.length === 1) console.log(`\n  只有一个源可用，无法交叉验证：$${fmt(med, 5)} / TH·天`);
  if (errors.length) for (const e of errors) console.log(`  警告：${e}`);

  const density = med || 0;
  const rowsGpu = gpuRows(density);
  console.log('');
  console.log('  型号                TH/s   收入$/天   盈亏线$/h  来源');
  for (const r of rowsGpu) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.th).padStart(5)} ${fmt(r.usdDay, 2).padStart(9)} ${fmt(r.breakEvenHr, 4).padStart(10)}  ${r.source}${r.autoOk ? '' : '（不参与自动租用）'}`);
  }
  console.log('');
  console.log('  说明：盈亏线 = 当前币价/算力下这台机器每小时最多能付的租金；超过就是亏。');
  console.log('        不含 NOCK 合并挖矿加成、矿工开发费、存储与出网费用；竞价实例应在盈亏线以下出价。');
  if (good.length > 1) console.log(`        三路差异按中位数折算；某一路偏离 >10% 时先单独核对该路再决策。`);
  console.log(`        Kryptex 实际池费 3%：用它挖时把上面的收入 × ${((1 - 0.03) / (1 - FEE)).toFixed(4)}。`);
}

function csvLine({ price, rows, med, spread }) {
  const cols = [new Date().toISOString(), price.usd.toFixed(6)];
  for (const s of SOURCES) {
    const r = rows.find(x => x.id === s.id);
    cols.push(r?.ok ? r.usdPerThDay.toFixed(8) : '');
  }
  cols.push(med ? med.toFixed(8) : '', spread == null ? '' : spread.toFixed(2));
  return cols.join(',');
}

async function once() {
  const res = await collect();
  if (!res.med) {
    console.error('三路都拿不到数据，算不出收入密度。');
    for (const e of res.errors) console.error(`  - ${e}`);
    console.error('可以用 --price / --network / --reward / --blocktime 手填后再算。');
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...res, gpus: gpuRows(res.med) }, null, 2));
  else printReport(res);
  if (csvPath) {
    const file = path.resolve(csvPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = `ts,price_usd,${SOURCES.map(s => s.id).join(',')},median,spread_pct\n`;
    if (!fs.existsSync(file)) fs.writeFileSync(file, header);
    fs.appendFileSync(file, csvLine(res) + '\n');
    if (!json) console.log(`  已追加一行到 ${file}`);
  }
  if (res.errors.length && !json) process.exitCode = 3;
}

if (loopSec && loopSec < 30) { console.error('--loop 至少 30 秒（别把矿池接口打成 DDoS）'); process.exit(2); }

if (!loopSec) {
  await once();
} else {
  console.log(`每 ${loopSec}s 记录一次行情${csvPath ? ` → ${csvPath}` : '（建议加 --csv 落盘）'}，Ctrl-C 结束`);
  for (;;) {
    try { await once(); } catch (e) { console.error(`本轮失败：${e.message}`); }
    await new Promise(ok => setTimeout(ok, loopSec * 1000));
  }
}