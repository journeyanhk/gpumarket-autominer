#!/usr/bin/env node
// Gate 卖出 + Lighter 平对冲（默认只读/演练，--probe 只验证下单通路，--live 才真卖）
//
// 约束（2026-10-27 实测）：
//   PEARL_USDT: min_base 0.1 PRL | min_quote 3 USDT | 数量精度 0.1 | taker 0.2%
//   → 按 $1.77 计，卖出量必须 ≥ 1.70 PRL，否则交易所直接拒单
import fs from 'node:fs';
import crypto from 'node:crypto';

const SEC = '/data/prl-automine/.secrets';
const readEnv = f => Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').filter(l => l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const gate = readEnv(`${SEC}/gate.env`);
const MODE = process.argv.includes('--live') ? 'live' : process.argv.includes('--probe') ? 'probe' : 'check';

const sign = (method, path, query, body = '') => {
  const t = Math.floor(Date.now() / 1000);
  const bh = crypto.createHash('sha512').update(body).digest('hex');
  const sig = crypto.createHmac('sha512', gate.GATE_API_SECRET)
    .update(`${method}\n${path}\n${query || ''}\n${bh}\n${t}`).digest('hex');
  return { t, sig };
};
const g = async (method, path, query = '', body = null) => {
  const b = body ? JSON.stringify(body) : '';
  const { t, sig } = sign(method, path, query, b);
  const r = await fetch('https://api.gateio.ws' + path + (query ? '?' + query : ''), {
    method,
    headers: { KEY: gate.GATE_API_KEY, SIGN: sig, Timestamp: String(t), 'Content-Type': 'application/json' },
    body: body ? b : undefined,
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = txt; }
  if (!r.ok) { const e = new Error(`Gate ${method} ${path} → ${r.status} ${txt.slice(0, 160)}`); e.status = r.status; e.body = d; throw e; }
  return d;
};

const cur = await g('GET', '/api/v4/spot/currencies/PEARL');
if (cur.name !== 'Pearl' || !(cur.chains || []).some(c => c.name === 'PEARL')) {
  console.error('币种身份不符，拒绝继续:', cur.name, cur.chain); process.exit(2);
}
const pair = await g('GET', '/api/v4/spot/currency_pairs/PEARL_USDT');
const MIN_QUOTE = Number(pair.min_quote_amount), MIN_BASE = Number(pair.min_base_amount), PREC = Number(pair.amount_precision);
const accts = await g('GET', '/api/v4/spot/accounts');
const avail = Number((accts.find(a => a.currency === 'PEARL') || {}).available || 0);
const book = await g('GET', '/api/v4/spot/order_book', 'currency_pair=PEARL_USDT&limit=3');
const bid = Number(book.bids[0][0]), bidSize = Number(book.bids[0][1]);
const ask = Number(book.asks[0][0]), askSize = Number(book.asks[0][1]);

// 加 1e-9 容差：1.9 / 0.1 = 18.999999999999996，直接 floor 会变成 1.8（少卖一整手）
const floorSize = q => Math.floor(q / Math.pow(10, -PREC) + 1e-9) * Math.pow(10, -PREC);
const out = { mode: MODE, balance: avail, bid, ask, minQuote: MIN_QUOTE, minBase: MIN_BASE, precision: PREC };

// 卖出量：默认「全部可用」但不超过买一档 20%（避免自己打穿盘口）；
// --size N 可显式指定（仍会被可用量与精度夹住，且不超过买一档 60%）
const sizeArg = (() => { const i = process.argv.indexOf('--size'); return i > 0 ? Number(process.argv[i + 1]) : null; })();
// 显式 --size 时以它为准（只受可用量与精度约束）：
// 盘口太薄时 20%/60% 的"防打穿"上限会算出低于 min_quote 的数量，反而把订单挡死。
// 未指定时保持旧行为：全部可用的 20%（不超过买一档）。
let size = sizeArg != null
  ? floorSize(Math.min(sizeArg, avail))
  : floorSize(Math.min(avail, Math.max(bidSize * 0.2, 0)));
out.plannedSize = size;
out.notionalUsd = +(size * bid).toFixed(3);
out.eligible = size >= MIN_BASE && size * bid >= MIN_QUOTE;

if (!out.eligible) {
  out.blocked = `可用 ${avail} PRL 卖出名义 $${(avail * bid).toFixed(3)}，低于交易所下限 ${MIN_QUOTE} USDT（需 ≥ ${(MIN_QUOTE / bid).toFixed(2)} PRL）`;
  console.log(JSON.stringify(out, null, 2));
  process.exit(3);
}

if (MODE === 'check') { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

if (MODE === 'probe') {
  // 只验证下单通路：挂一个远离市价的卖单（bid×1.10），立刻撤掉，不会成交
  const price = +(bid * 1.1).toFixed(4);
  const order = await g('POST', '/api/v4/spot/orders', '', {
    currency_pair: 'PEARL_USDT', type: 'limit', side: 'sell', amount: String(size), price: String(price),
    time_in_force: 'gtc', account: 'spot',
  });
  out.probe = { placed: order.id, price, size };
  const cancel = await g('DELETE', `/api/v4/spot/orders/${order.id}`, 'currency_pair=PEARL_USDT');
  out.probe.cancelled = cancel.id;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// live：贴买一卖出（吃单），成交后再平对冲
const order = await g('POST', '/api/v4/spot/orders', '', {
  currency_pair: 'PEARL_USDT', type: 'limit', side: 'sell', amount: String(size), price: String(bid),
  time_in_force: 'ioc', account: 'spot',
});
out.order = order;
console.log(JSON.stringify(out, null, 2));