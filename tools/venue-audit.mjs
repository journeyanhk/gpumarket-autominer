#!/usr/bin/env node
// Pearl (PRL) 场所审计：把所有可能出现「PRL / PEARL」的场所抓一遍，用价格数量级判定同名不同币。
//
// 为什么必须有这个工具：同名不同币已经踩了三次——
//   · Gate: PEARL = Pearl（对），PRL = Perle on SOL（错）
//   · Binance: PRL/USDT 永续是另一个项目（$0.0968 vs Pearl $1.66，差 17 倍）
//   · Surf token 搜索的 PRL 全是 EVM/SOL 上的零成交灰尘
// 判据只有一条：与「权威参考价」比数量级。差一个量级就不是同一个资产，深度再好也不能用。
//
// 参考价优先级：本地控制台 /api/state 的 market.price（我们自己的口径）
//              → pearlhash /api/pearl-price（矿池官方）
//
// 用法：node tools/venue-audit.mjs [--json] [--deep]
import fs from 'node:fs';

const CTRL = 'http://127.0.0.1:8290/api/state';
const PH = 'https://pearlhash.xyz/api/pearl-price';

const get = async (url, ms = 12000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
};

// ---------- 参考价 ----------
const ref = { console: null, pearlhash: null, used: null };
try {
  const st = await get(CTRL);
  ref.console = Number(st?.market?.price) || null;
} catch { /* 控制台可能没起，退回矿池价 */ }
try {
  const p = await get(PH);
  ref.pearlhash = Number(p?.usd) || null;
} catch { /* 忽略 */ }
ref.used = ref.console || ref.pearlhash;
if (!ref.used) {
  console.error('拿不到权威参考价（控制台与 pearlhash 都失败），无法判定同名不同币');
  process.exit(2);
}

// ---------- 场所探针：返回 {venue, market, type, price, extra} ----------
const probes = [
  {
    venue: 'gate', market: 'PEARL_USDT', type: 'spot',
    run: async () => {
      const t = await get('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=PEARL_USDT');
      const row = Array.isArray(t) ? t[0] : t;
      return { price: Number(row?.last), extra: { bid: Number(row?.highest_bid), ask: Number(row?.lowest_ask), vol24h: Number(row?.base_volume) } };
    },
  },
  {
    venue: 'gate', market: 'PRL_USDT', type: 'spot',
    run: async () => {
      const t = await get('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=PRL_USDT');
      const row = Array.isArray(t) ? t[0] : t;
      return { price: Number(row?.last), extra: { vol24h: Number(row?.base_volume) } };
    },
  },
  {
    venue: 'binance', market: 'PRLUSDT', type: 'spot',
    run: async () => ({ price: Number((await get('https://api.binance.com/api/v3/ticker/price?symbol=PRLUSDT'))?.price) }),
  },
  {
    venue: 'binance', market: 'PRLUSDT', type: 'perp',
    run: async () => {
      const p = await get('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=PRLUSDT');
      return { price: Number(p?.markPrice), extra: { fundingRate: Number(p?.lastFundingRate), index: Number(p?.indexPrice) } };
    },
  },
  {
    venue: 'lighter', market: 'PRL', type: 'perp',
    run: async () => {
      const d = await get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=4097');
      const ob = d?.order_book_details?.[0] || {};
      return { price: Number(ob?.last_trade_price) || null, extra: { mark: Number(ob?.mark_price) || null } };
    },
  },
  {
    venue: 'mexc', market: 'PRLUSDT', type: 'spot',
    run: async () => ({ price: Number((await get('https://api.mexc.com/api/v3/ticker/price?symbol=PRLUSDT'))?.price) }),
  },
  {
    venue: 'bitget', market: 'PRLUSDT', type: 'spot',
    run: async () => {
      const d = await get('https://api.bitget.com/api/v2/spot/market/tickers?symbol=PRLUSDT');
      const row = d?.data?.[0];
      if (!row) throw new Error('no data');
      return { price: Number(row.lastPr) };
    },
  },
  {
    venue: 'kucoin', market: 'PRL-USDT', type: 'spot',
    run: async () => {
      const d = await get('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=PRL-USDT');
      return { price: Number(d?.data?.price) };
    },
  },
];

// 判定：与参考价的数量级比较
const classify = (price) => {
  if (!(price > 0)) return { verdict: 'N/A', ratio: null };
  const ratio = +(price / ref.used).toFixed(3);
  if (ratio >= 0.67 && ratio <= 1.5) return { verdict: 'SAME_ASSET', ratio };
  if (ratio < 0.33 || ratio > 3) return { verdict: 'IMPOSTOR', ratio };
  return { verdict: 'SUSPECT', ratio };
};

const rows = [];
for (const p of probes) {
  try {
    const r = await p.run();
    rows.push({ venue: p.venue, market: p.market, type: p.type, price: r.price ?? null, ...classify(r.price), extra: r.extra || null });
  } catch (e) {
    rows.push({ venue: p.venue, market: p.market, type: p.type, price: null, verdict: 'UNREACHABLE', ratio: null, error: e.message.slice(0, 90) });
  }
}

// 深度：只对判定为同资产的场所查（避免用错币的盘口）
const deep = process.argv.includes('--deep');
if (deep) {
  for (const r of rows) {
    if (r.verdict !== 'SAME_ASSET') continue;
    try {
      if (r.venue === 'gate' && r.type === 'spot') {
        const ob = await get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${r.market}&limit=5`);
        r.depth = { bids: ob.bids.slice(0, 3).map(x => [Number(x[0]), Number(x[1])]), asks: ob.asks.slice(0, 3).map(x => [Number(x[0]), Number(x[1])]) };
      }
      if (r.venue === 'lighter') {
        const ob = await get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=4097&limit=3');
        r.depth = { bids: (ob.bids || []).slice(0, 3).map(x => [Number(x.price), Number(x.remaining_base_amount)]), asks: (ob.asks || []).slice(0, 3).map(x => [Number(x.price), Number(x.remaining_base_amount)]) };
      }
    } catch (e) { r.depthError = e.message.slice(0, 80); }
  }
}

const out = { at: new Date().toISOString(), reference: ref, rows };
if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const mark = v => ({ SAME_ASSET: '✅ 同资产', IMPOSTOR: '❌ 同名不同币', SUSPECT: '⚠ 待人工核', UNREACHABLE: '— 不可达', 'N/A': '— 无价' }[v] || v);
console.log(`Pearl (PRL) 场所审计 ${out.at}`);
console.log(`参考价：控制台 $${ref.console ?? '—'}｜pearlhash $${ref.pearlhash ?? '—'} → 采用 $${ref.used}`);
console.log('');
console.log('场所        品种              类型   价格        比值    判定');
for (const r of rows) {
  console.log(
    `${r.venue.padEnd(10)} ${String(r.market).padEnd(17)} ${r.type.padEnd(6)} `
    + `${(r.price == null ? '—' : '$' + r.price.toFixed(4)).padEnd(11)} ${(r.ratio == null ? '—' : r.ratio.toFixed(2) + '×').padEnd(7)} ${mark(r.verdict)}`
    + (r.extra ? `  ${JSON.stringify(r.extra)}` : '') + (r.error ? `  (${r.error})` : ''),
  );
}
const same = rows.filter(r => r.verdict === 'SAME_ASSET');
console.log(`\n可用场所：${same.length ? same.map(r => `${r.venue}/${r.market}(${r.type})`).join('、') : '无'}`);
if (same.some(r => r.depth)) for (const r of same.filter(x => x.depth)) console.log(`  ${r.venue} 盘口：买 ${JSON.stringify(r.depth.bids)}｜卖 ${JSON.stringify(r.depth.asks)}`);
const bad = rows.filter(r => r.verdict === 'IMPOSTOR');
if (bad.length) console.log(`⚠ 忽略：${bad.map(r => `${r.venue}/${r.market} $${r.price}`).join('、')} —— 与 Pearl 差 ${bad.map(r => r.ratio + '×').join('、')}，不是同一个资产`);