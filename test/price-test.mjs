// 币价源回退测试：Pearlhash 挂在 Cloudflare 后面，403 时必须自动切到 CoinGecko / WPRL 池，
// 而不是让进程直接崩掉（这是第二轮 review 发现的阻塞项）。
// 顺带守住 ticker 陷阱：Gate/MEXC/Bitget/KuCoin 的 PRLUSDT 是另一个代币，不能当备用源。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href;
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');

const P = await import(U('src/pearl.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const PEARL = 1.74, CG = 1.74, DEX = 1.75;

let down = new Set();
let wrongAsset = false;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.host === 'pearlhash.xyz') {
    if (down.has('pearlhash')) return new Response('Just a moment...', { status: 403 });
    return json({ usd: PEARL, usd_24h_change: -3.3, usd_24h_vol: 7.1e6 });
  }
  if (u.host === 'api.coingecko.com') {
    if (down.has('coingecko')) return json({ error: 'rate limited' }, 429);
    return json({ 'pearl-2': { usd: wrongAsset ? 0.093 : CG, usd_24h_change: -3.1 } });
  }
  if (u.host === 'api.dexscreener.com') {
    if (down.has('dexscreener')) return json({ pairs: [] });
    return json({
      pairs: [
        // 陷阱：TVL 一亿多美元、24h 成交额 $0.23、价格陈在 $1.17 —— 按流动性挑就会挑到它
        { baseToken: { symbol: 'WPRL' }, priceUsd: '1.17', liquidity: { usd: 176894749 }, priceChange: { h24: 0 }, volume: { h24: 0.23 } },
        { baseToken: { symbol: 'WPRL' }, priceUsd: String(DEX), liquidity: { usd: 875428 }, priceChange: { h24: -2.9 }, volume: { h24: 349981 } },
        { baseToken: { symbol: 'WRONG' }, priceUsd: '0.09', liquidity: { usd: 9e9 }, volume: { h24: 1e9 } },
      ],
    });
  }
  throw new Error(`未预期的请求：${u.host}`);
};

console.log('— 正常情况');
let p = await P.fetchPrice();
ok(p.src === 'pearlhash' && p.usd === PEARL, `主源可用：${p.src} $${p.usd}`);
ok(p.cross?.src === 'coingecko' && !p.disagree, '同时打了一个交叉验证源，且与主源一致');

console.log('— Pearlhash 被 Cloudflare 拦住');
down.add('pearlhash');
p = await P.fetchPrice();
ok(p.src === 'coingecko' && p.usd === CG, `403 → 自动切到 ${p.src} $${p.usd}（原来会直接抛错退出）`);
ok(p.cross?.src === 'dexscreener', '第二源换成 WPRL 池');
ok(p.errors.some(e => /pearlhash/.test(e)), '失败原因保留在 errors 里，便于日志排查');

console.log('— 主源 + 第二源都挂');
down.add('coingecko');
p = await P.fetchPrice();
ok(p.src === 'dexscreener' && p.usd === DEX, `只剩 WPRL 池也能出价：$${p.usd}（跳过假 TVL、零成交、价格陈旧的池子）`);
ok(p.cross === null, '没有交叉源时 cross 为 null（不假装有验证）');

console.log('— 全部失败');
down.add('dexscreener');
let err = null;
try { await P.fetchPrice(); } catch (e) { err = e; }
ok(err && /全部源失败/.test(err.message), `全部源失败 → 明确抛错（${err?.message.slice(0, 40)}…）`);

console.log('— 串币防护');
down = new Set(); wrongAsset = true; // CoinGecko 返回 $0.09 那个同 ticker 的假货
p = await P.fetchPrice();
ok(p.usd === PEARL, '主源与交叉源分歧 18 倍时，仍然采用主源的价格（不会被串币源带跑）');
ok(p.disagree === true && p.devPct > 25, `分歧标记生效（${p.devPct?.toFixed(0)}%）`);

console.log('— 源列表本身');
const hosts = P.PRICE_SOURCES.map(s => s.id).join(',');
ok(hosts === 'pearlhash,coingecko,dexscreener', `回退顺序固定：${hosts}`);
ok(!/gate|mexc|bitget|kucoin/i.test(hosts), '没有把「同 ticker 不同币」的交易所接进来');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);