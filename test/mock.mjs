// 模拟 vast.ai / Pearlhash / GitHub 接口，用来离线跑通整个流程
const T0 = Date.now();
const sec = () => (Date.now() - T0) / 1000;
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

const gpus = [['RTX 5090', 370, 0.42], ['RTX 4090', 310, 0.31], ['RTX 5080', 195, 0.20], ['RTX 4080S', 175, 0.17], ['RTX 3090', 130, 0.13], ['RTX 4070S Ti', 144, 0.16], ['H100 SXM', 650, 1.6], ['A100 PCIE', 0, 0.8], ['RTX 3060', 41, 0.05]];
let nextId = 900;
const offers = [];
for (let i = 0; i < 60; i++) {
  const [name, th, base] = gpus[i % gpus.length];
  const n = i % 7 === 0 ? 2 : 1;
  const price = +(base * n * (0.62 + ((i * 37) % 60) / 100)).toFixed(3);
  offers.push({ id: 10000 + i, machine_id: 5000 + i, gpu_name: name, num_gpus: n, dph_total: price, min_bid: +(price * 0.7).toFixed(3), reliability2: 0.95 + (i % 5) / 100, geolocation: ['Tokyo, JP', 'Hong Kong, HK', 'Texas, US', 'Bavaria, DE', 'Guangdong, CN'][i % 5], inet_down: 300 + i * 10, cuda_max_good: 12.8 });
}
const instances = [{ id: 10000001, label: '', gpu_name: 'RTX 5080', num_gpus: 1, dph_total: 0.266, dph_base: 0.2596, actual_status: 'running', intended_status: 'running', start_date: Date.now() / 1000 - 3600, geolocation: 'Guangdong, CN', machine_id: 100001, gpu_temp: 61 }];
const born = {};
globalThis.__5080 = 96.4e12; // 真实情况：5080 掉到一半
globalThis.__weakGpu = true;  // 2 卡机器其中一张卡偏弱
const rebooted = {};
globalThis.__price = 1.85;
setTimeout(() => { globalThis.__price = 1.0; console.log('>>> MOCK: price dropped to 1.0'); }, 75_000);

// 机器实际在挖的矿池：标签里的 pool=xxx，在 __switchDelay 秒后生效（__labelBroken 时永远不生效）
const machinePool = i => {
  const want = (String(i.label || '').match(/pool=([a-z]+)/) || [])[1] || 'pearlhash';
  if (i._pool == null) { i._pool = want; i._kxOpened = Date.now(); }
  if (want !== i._pool && !globalThis.__labelBroken && sec() - (i._labelAt || 0) >= (globalThis.__switchDelay ?? 0)) { i._pool = want; i._kxOpened = Date.now(); }
  return i._pool;
};
globalThis.__machinePool = machinePool;
globalThis.__preempt = id => { const i = instances.find(x => x.id === +id); if (i) { i.actual_status = 'stopped'; i.intended_status = 'running'; } };
// 模拟任意状态组合（vast 的真实语义还没验证过，测试要能摆出各种组合）
globalThis.__instanceStatus = (id, actual, intended = 'running', msg = '') => {
  const i = instances.find(x => x.id === +String(id));
  if (i) { i.actual_status = actual; i.intended_status = intended; i.status_msg = msg; i.cur_state = actual; i.next_state = actual; }
};
globalThis.__kxEarned = 0;
// 模拟平台侧的计费字段：dph_total = 实际扣费（含存储/出网），dph_base = GPU 单价
globalThis.__setPrice = (id, total, base) => {
  const i = instances.find(x => x.id === +String(id));
  if (!i) return null;
  if (total != null) i.dph_total = total;
  if (base != null) i.dph_base = base;
  return { total: i.dph_total, base: i.dph_base };
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url);
  const m = (opt.method || 'GET').toUpperCase();
  const body = opt.body ? JSON.parse(opt.body) : null;
  if (u.host === 'console.vast.ai') {
    // 匿名搜索是合法身份（vast 的限流按 identity 计）：/bundles/ 允许不带 Authorization，
    // 其他端点仍然要求 key；带了错误的 key 一律 401。
    const auth = opt.headers?.Authorization;
    if (auth == null && u.pathname === '/api/v0/bundles/' && (opt.method || 'GET').toUpperCase() === 'POST') {
      globalThis.__anonSearches = (globalThis.__anonSearches || 0) + 1;
    } else if (auth !== 'Bearer test-key') return json({ error: 'unauthorized', msg: 'bad key' }, 401);
    if (u.pathname === '/api/v0/users/current/') return json({ credit: 9.98 - sec() * 0.0003, email: 'demo@example.com' });
    if (u.pathname === '/api/v0/bundles/' && m === 'POST') {
      if (!body.order || !['on-demand', 'bid'].includes(body.type)) return json({ error: 'bad query' }, 400);
      globalThis.__lastType = body.type;
      globalThis.__lastLimit = body.limit;
      if (globalThis.__rateLimited) { globalThis.__rateLimited = false; return json({ error: 'rate_limited', msg: 'API requests too frequent' }, 429); }
      globalThis.__lastQuery = body;
      // 竞价按 min_bid 过滤、按需按挂牌价过滤（与 vast 的语义一致）
      const list = offers.filter(o => (body.min_bid ? o.min_bid <= body.min_bid.lte : o.dph_total <= body.dph_total.lte) && (!body.gpu_name?.in || body.gpu_name.in.includes(o.gpu_name))).slice(0, body.limit || 1000);
      if (globalThis.__quotaLeft != null) {
        if (globalThis.__quotaLeft <= 0) return json({ error: 'search_quota_exceeded', msg: 'Daily search row quota exhausted' }, 429, { 'X-RateLimit-Reset': String(Math.floor(globalThis.__quotaReset / 1000)) });
        globalThis.__quotaLeft -= list.length;
      }
      return json({ offers: list }, 200, globalThis.__sendQuotaHeaders ? { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': String(globalThis.__quotaLeft ?? 4000) } : {});
    }
    if (u.pathname === '/api/v0/instances/' && m === 'GET') {
      // 2026-10 起真实平台已下架这个端点，这里如实复现（客户端必须走 v1）
      return json({ success: false, error: 'deprecated_endpoint', msg: '/api/v0/instances/ is deprecated. Use /api/v1/instances/ instead.' }, 410);
    }
    if (u.pathname === '/api/v1/instances/' && m === 'GET') {
      globalThis.__v1Calls = (globalThis.__v1Calls || 0) + 1;
      for (const i of instances) if (born[i.id] && sec() - born[i.id] > 8) i.actual_status = 'running';
      if (!globalThis.__paginate) return json({ success: true, total_instances: instances.length, instances, next_token: null });
      const tok = u.searchParams.get('next_token');
      const half = Math.ceil(instances.length / 2);
      if (!tok) return json({ success: true, instances: instances.slice(0, half), next_token: 'p2' });
      if (tok === 'p2') return json({ success: true, instances: instances.slice(half), next_token: null });
      return json({ success: false, msg: 'bad token' }, 400);
    }
    let mm;
    if ((mm = u.pathname.match(/^\/api\/v0\/asks\/(\d+)\/$/)) && m === 'PUT') {
      const o = offers.find(x => x.id === +mm[1]);
      if (!o) return json({ success: false, error: 'no_such_ask', msg: 'not available' }, 400);
      const script = body.runtype === 'args' ? (body.onstart === 'bash' && body.args?.[0] === '-c' ? body.args[1] : '') : body.onstart;
      if (!script?.includes('wildrig') || body.client_id !== 'me') return json({ success: false, msg: 'bad body' }, 400);
      // 出价被拒（扫描到下单之间 min_bid 涨了）
      if (globalThis.__bidError) {
        globalThis.__bidError = false;
        return json({ success: false, error: 'bid_price_too_low', msg: 'Bid price is too low for this offer' }, 400);
      }
      globalThis.__lastRentBody = body;
      offers.splice(offers.indexOf(o), 1);
      const id = nextId++;
      instances.push({ id, label: body.label, gpu_name: o.gpu_name, num_gpus: o.num_gpus, dph_total: o.dph_total, actual_status: 'loading', intended_status: 'running', start_date: Date.now() / 1000, geolocation: o.geolocation, machine_id: o.machine_id, gpu_temp: 55, _th: gpus.find(g => g[0] === o.gpu_name)[1] * o.num_gpus });
      born[id] = sec();
      console.log(`>>> MOCK: rented offer ${o.id} -> instance ${id}, label=${body.label}, image=${body.image}`);
      return json({ success: true, new_contract: id });
    }
    if ((mm = u.pathname.match(/^\/api\/v0\/instances\/request_logs\/(\d+)\/$/)) && m === 'PUT') {
      globalThis.__logReqs = (globalThis.__logReqs || 0) + 1;
      return json({ success: true, result_url: 'https://s3.mock/logs/' + mm[1] });
    }
    if ((mm = u.pathname.match(/^\/api\/v0\/instances\/reboot\/(\d+)\/$/)) && m === 'PUT') {
      const i = instances.find(x => x.id === +mm[1]);
      if (!i) return json({ success: false, msg: 'no such instance' }, 404);
      rebooted[i.id] = sec(); i.actual_status = 'loading'; born[i.id] = sec();
      console.log('>>> MOCK: rebooted ' + i.id);
      return json({ success: true });
    }
    if ((mm = u.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/)) && m === 'PUT') {
      const i = instances.find(x => x.id === +mm[1]);
      if (!i) return json({ success: false, msg: 'no such instance' }, 404);
      machinePool(i); i.label = body.label; i._labelAt = sec();
      globalThis.__labels = [...(globalThis.__labels || []), [i.id, body.label]];
      return json({ success: true });
    }
    if ((mm = u.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/)) && m === 'DELETE') {
      const k = instances.findIndex(x => x.id === +mm[1]);
      if (k < 0) return json({ success: false, msg: 'no such instance' }, 404);
      instances.splice(k, 1);
      console.log(`>>> MOCK: destroyed ${mm[1]}`);
      return json({ success: true });
    }
    return json({ error: 'mock 404 ' + u.pathname }, 404);
  }
  if (u.host === 'pearlhash.xyz') {
    const p = u.pathname;
    if (p === '/api/pearl-price') return json({ usd: globalThis.__price, usd_24h_change: 8.7 });
    if (p === '/api/chain-info') return json({ blocks: 129637, difficulty: 37874119, networkhashps: 70502429228133970000, avg_block_time_s: 171.1 });
    if (p === '/api/stats') return json({ hashrate: 1.39e19, total_workers: 57327 });
    if (p === '/api/pool-wallet-txs') return json({ transactions: [{ type: 'coinbase', receivedGrains: 224524935191, blockHeight: 129635 }] });
    if (p.startsWith('/api/account/')) {
      if (globalThis.__account404) return json({ error: 'not found' }, 404);
      if (globalThis.__pearlDown) return json({ error: 'down' }, 503);
      const w = [];
      if (!rebooted[10000001]) w.push({ worker_name: '5080', gpu_info: [{ name: 'NVIDIA GeForce RTX 5080', hashrate: globalThis.__5080 }] });
      for (const i of instances) if (born[i.id] && sec() - born[i.id] > 20 && machinePool(i) === 'pearlhash' && !globalThis.__pearlStratumDown) w.push({ worker_name: 'v' + i.id, gpu_info: Array.from({ length: i.num_gpus }, (_, k) => ({ name: i.gpu_name, hashrate: i._th / i.num_gpus * 1.03e12 * (globalThis.__weakGpu && i.num_gpus > 1 && k === 1 && !rebooted[i.id] ? 0.45 : 1) })) });
      return json({ connected_workers: w, nock_payout_address: globalThis.__nockAddr || 'Please set your nock address', balance_transactions: [{amount: 1.5, coin_type:'pearl'}], pending_rewards: { total_pending_prl: 0.0707, epochs: [{ amount: 0.07068133183781625, coin_type: 'pearl', epoch_label: '2026-10-18 09:00:00 UTC .. 2026-10-18 10:00:00 UTC', share: 0.000004501587452660985 }] } });
    }
    if (p.startsWith('/api/nock-balance/')) return json({ balance: 0, pending_rewards: { total_pending: 0.0295, epochs: [{ amount: 0.0295, epoch_label: '2026-10-18 09:00-10:00', immature_blocks: 4, share: 0.000005 }] } });
  }
  if (u.host === 'pool.kryptex.com' || u.host === 'prl-api.kryptex.network') {
    if (globalThis.__kryptexDown) return json({ error: 'down' }, 503);
    const p = u.pathname.replace(/^\/prl\/api/, '/api');
    if (p === '/api/v1/pool/info') return json({ hashrate: 3.24e19, net_hashrate: 7.03e19, fee: 0.03, commission: { 'PPS+': 0.03, SOLO: 0.01 }, block_time: 194, block_reward: 2238.42 });
    if (p.startsWith('/api/v3/miner/workers/')) {
      const results = [];
      for (const i of instances) if (born[i.id] && sec() - born[i.id] > 20 && machinePool(i) === 'kryptex') results.push({ worker: 'v' + i.id, status: 'online', last_share: Date.now() - 20000, opened_at: globalThis.__kxOpenedAgoMin != null ? Date.now() - globalThis.__kxOpenedAgoMin * 60000 : i._kxOpened, avg_hashrate_30m: String((i._th || 100) * 1e12 * (globalThis.__kxRatio ?? 1)), avg_hashrate_3h: '0', agent: 'WildRig/0.51.5', scheme: 'pps' });
      return json({ results });
    }
    if (p.startsWith('/api/v1/miner/balance/')) return json({ total: globalThis.__kxEarned, unconfirmed: globalThis.__kxEarned, confirmed: 0 });
    if (p.startsWith('/api/v1/miner/payouts/') && p.endsWith('/stats')) return json({ paid: 0, unpaid: 0 });
    return json({ error: 'mock kx 404 ' + p }, 404);
  }
  if (u.host === 's3.mock') return new Response(globalThis.__logText ?? `[prl] 03:40:01 worker=v1 gpu=NVIDIA GeForce RTX 3080, 320.00 W;
[prl] 03:40:01 download https://github.com/x
[prl] 03:40:03 miner ready: WildRig Multi 0.51.5
[prl] 03:40:03 started
[prl] 03:40:04 miner exited, last output:
[GPU#0] CUDA error 999: unknown error
[prl] restart in 10s
`, { status: 200 });
  if (u.host === 'api.coingecko.com') return json({ nockchain: { usd: 0.0178, usd_24h_change: -3.2 } });
  if (u.host === 'api.github.com' && /SRBMiner/i.test(u.pathname)) return json({ tag_name: '3.7.9', assets: [{ name: 'srbminer_custom-3.7.9.tar.gz', browser_download_url: 'https://x/hive' }, { name: 'SRBMiner-Multi-3-7-9-Linux.tar.gz', browser_download_url: 'https://github.com/doktor83/SRBMiner-Multi/releases/download/3.7.9/SRBMiner-Multi-3-7-9-Linux.tar.gz' }] });
  if (u.host === 'api.github.com') return json({ tag_name: '0.51.5', assets: [{ name: 'wildrig-multi-hiveos-0.51.5.tar.gz', browser_download_url: 'https://x/hive' }, { name: 'wildrig-multi-linux-0.51.5.tar.xz', browser_download_url: 'https://github.com/andru-kun/wildrig-multi/releases/download/0.51.5/wildrig-multi-linux-0.51.5.tar.xz' }] });
  if (u.hostname === '127.0.0.1') return realFetch(url, opt);
  return json({ error: 'mock: unknown host ' + u.host }, 404);
};
