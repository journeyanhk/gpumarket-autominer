#!/usr/bin/env node
// 盈亏线计算器（只读）：把矿池/链上数据折算成「每 TH 每天收入」和每张卡的盈亏线租金。
//
// 用途：在任何实盘决策之前先把生意算清楚。ROI 的分子完全由这个数决定，
//       分母（租金）才是市场里去挑的东西。
//
// 用法：
//   node tools/breakeven.mjs                       # 拉实时数据
//   node tools/breakeven.mjs --json                # 机器可读输出
//   node tools/breakeven.mjs --price 1.75 --network 96e18 --reward 2221.39 --blocktime 165 --fee 0.01
//                                                 # 断网/回放时用手填参数
//
// 只依赖项目自带的 src/pearl.js（同一套公式，避免"算盈亏"和"程序决策"两套口径）。
import { fetchPrice, fetchChain, fetchBlockReward, usdPerHsHour, POOL_FEE } from '../src/pearl.js';
import { hashrateTable } from '../src/gpus.js';

const argv = process.argv.slice(2);
const has = k => argv.includes(`--${k}`);
const val = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const num = (k, d = null) => {
  const v = val(k);
  if (v === null) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`参数 --${k} 不是数字：${v}`);
    process.exit(2);
  }
  return n;
};

const fee = num('fee', POOL_FEE);
const json = has('json');

async function resolveInputs() {
  const errors = [];
  let price = num('price');
  let chain = null;
  let reward = num('reward');
  const blockTime = num('blocktime');
  const networkHs = num('network');

  if (price === null) {
    try { price = (await fetchPrice()).usd; } catch (e) { errors.push(`币价：${e.message}`); }
  }
  if (networkHs === null || blockTime === null) {
    try { chain = await fetchChain(); } catch (e) { errors.push(`链数据：${e.message}`); }
  }
  if (reward === null) {
    try { reward = (await fetchBlockReward()).reward; } catch (e) { errors.push(`区块奖励：${e.message}`); }
  }

  const out = {
    price,
    networkHs: networkHs ?? chain?.networkHs ?? null,
    blockTime: blockTime ?? chain?.blockTime ?? null,
    reward,
    fee,
    height: chain?.height ?? null,
    errors,
  };
  out.usdPerHsHr = usdPerHsHour({
    usd: out.price, networkHs: out.networkHs, blockTime: out.blockTime, reward: out.reward, fee: out.fee,
  });
  out.usdPerThDay = out.usdPerHsHr * 1e12 * 24;
  return out;
}

const fmt = (n, d = 4) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const inputs = await resolveInputs();
if (!(inputs.usdPerThDay > 0)) {
  console.error('算不出收入密度，说明关键输入缺失：');
  for (const e of inputs.errors) console.error(`  - ${e}`);
  console.error('可以用 --price / --network / --reward / --blocktime 手填后再算。');
  process.exit(1);
}

const rows = hashrateTable().map(g => {
  const th = g.effective;
  const usdHr = th * 1e12 * inputs.usdPerHsHr;
  return {
    key: g.key,
    name: g.name,
    th,
    source: g.source,
    autoOk: g.autoOk,
    usdHr,
    usdDay: usdHr * 24,
    breakEvenDph: usdHr, // 盈亏线：这台机器每小时最多能付多少租金
    breakEvenPerThDay: inputs.usdPerThDay,
  };
});

if (json) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), inputs, rows }, null, 2));
} else {
  console.log('');
  console.log(`PRL 盈亏线 · ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC${inputs.height ? ` · 区块 ${inputs.height}` : ''}`);
  console.log(`  币价 $${fmt(inputs.price, 2)} · 全网 ${(inputs.networkHs / 1e18).toFixed(2)} EH/s · 出块 ${fmt(inputs.blockTime, 1)}s · 奖励 ${fmt(inputs.reward, 2)} PRL · 费率 ${(inputs.fee * 100).toFixed(1)}%`);
  console.log(`  收入密度：$${fmt(inputs.usdPerThDay, 5)} / TH·天   （每 1000 TH 每天 $${fmt(inputs.usdPerThDay * 1000, 2)}）`);
  console.log('');
  console.log('  型号                TH/s   收入$/天   盈亏线$/h  来源');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(18)} ${String(r.th).padStart(5)} ${fmt(r.usdDay, 2).padStart(9)} ${fmt(r.breakEvenDph, 4).padStart(10)}  ${r.source}${r.autoOk ? '' : '（不参与自动租用）'}`);
  }
  console.log('');
  console.log('  说明：盈亏线 = 该型号在当前币价/算力下每小时最多能付的租金，超过就是亏。');
  console.log('        不含 NOCK 合并挖矿加成，也不含矿工开发费；竞价实例应在盈亏线以下出价。');
}

if (inputs.errors.length) {
  console.error('');
  for (const e of inputs.errors) console.error(`  警告：${e}`);
  process.exitCode = 3;
}