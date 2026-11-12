// Clore 市场适配器（2026-11-05）：M3 `Market` 接口的第二个实现。
//
// 为什么放进 src 而不是留在 tools：
//   ①它要跟引擎一起每 2 小时跑一次（不新增进程），工具脚本没有调度；
//   ②它就是 M3 接口的验证载体——vast 是第一个实现，Clore 是第二个，
//     两个真实实现比 20 条 fixture 更能暴露接口设计错误（用户 2026-11-05 判定）；
//   ③数据落进与报价快照同一套 append-only 日志，覆盖率分析能跨市场复用。
//
// 与 tools/clore-census.mjs 的关系：取价规则只有这一份实现，工具从 here import，
// 避免"两个地方各写一遍取价"（那正是本项目 bug 家族的源头）。
import fs from 'node:fs';

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// 型号归一：Clore 的 specs.gpu 形如 "2x NVIDIA GeForce RTX 3080"
export function modelKey(s) {
  const t = String(s || '').toLowerCase();
  if (/3090/.test(t)) return '3090';
  if (/3080\s*ti/.test(t)) return '3080 Ti';
  if (/3080/.test(t)) return '3080';
  if (/3070\s*ti/.test(t)) return '3070 Ti';
  if (/3070/.test(t)) return '3070';
  if (/3060\s*ti/.test(t)) return '3060 Ti';
  if (/3060/.test(t)) return '3060';
  if (/2080\s*ti/.test(t)) return '2080 Ti';
  if (/4090/.test(t)) return '4090';
  if (/4080/.test(t)) return '4080';
  if (/4070\s*ti\s*super/.test(t)) return '4070 Ti Super';
  if (/4070\s*ti/.test(t)) return '4070 Ti';
  if (/4070\s*super/.test(t)) return '4070 Super';
  if (/4070/.test(t)) return '4070';
  if (/4060\s*ti/.test(t)) return '4060 Ti';
  return null;
}

// ---------- 汇率：只用公开行情，带时间戳 ----------
// Clore 自己也在换算（usd.on_demand_btc 就是它按内部价算的美元），所以"我们的换算"只作兜底，
// 但一旦用到就必须记下用了哪路、什么价、什么时候取的。
export async function fetchFx() {
  const fx = { at: new Date().toISOString(), btcUsd: null, cloreUsd: null, src: {} };
  try {
    const r = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT', { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    fx.btcUsd = num(d?.[0]?.last); if (fx.btcUsd) fx.src.btc = 'gate';
  } catch { /* 下面还有 CoinGecko */ }
  try {
    const r = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=CLORE_USDT', { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    fx.cloreUsd = num(d?.[0]?.last); if (fx.cloreUsd) fx.src.clore = 'gate';
  } catch { /* 下面还有 CoinGecko */ }
  if (!fx.btcUsd || !fx.cloreUsd) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,clore-ai&vs_currencies=usd', { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      fx.btcUsd ||= num(d?.bitcoin?.usd);
      fx.cloreUsd ||= num(d?.['clore-ai']?.usd);
      if (fx.btcUsd && !fx.src.btc) fx.src.btc = 'coingecko';
      if (fx.cloreUsd && !fx.src.clore) fx.src.clore = 'coingecko';
    } catch { /* 汇率拿不到不致命：只影响币本位报价的房源 */ }
  }
  return fx;
}

// 单条房源某一种计价方式（spot / on_demand）的「美元/天」，返回 { usd, src }
export function usdPerDayOf(p, kind, fx) {
  if (!p) return null;
  const direct = num(p?.[kind]?.['USD-Blockchain']);
  if (direct) return { usd: direct, src: 'usd' };
  if (kind === 'spot') { const v = num(p?.usd?.spot); if (v) return { usd: v, src: 'usd' }; }
  const pre = num(kind === 'spot' ? p?.usd?.spot_usd : p?.usd?.on_demand_usd);
  if (pre) return { usd: pre, src: 'usd' };
  const preBtc = num(kind === 'spot' ? p?.usd?.spot_btc : p?.usd?.on_demand_btc);
  if (preBtc) return { usd: preBtc, src: 'usd' };
  const preClore = num(kind === 'spot' ? p?.usd?.spot_clore : p?.usd?.on_demand_clore);
  if (preClore) return { usd: preClore, src: 'usd' };
  const btc = num(p?.[kind]?.bitcoin);
  if (btc && fx?.btcUsd) return { usd: btc * fx.btcUsd, src: 'btc' };
  const clore = num(p?.[kind]?.['CLORE-Blockchain']);
  if (clore && fx?.cloreUsd) return { usd: clore * fx.cloreUsd, src: 'clore' };
  return null;
}

export function readCloreKey(keyFile) {
  try {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    const m = /CLORE_KEY=(.+)/.exec(raw);
    return (m ? m[1] : raw).trim() || null;
  } catch { return null; }
}

// 拉一次市场并按型号聚合（spot 口径，$/h/卡；带 mrl 与 frac 分布）
export async function fetchClore({ keyFile, mrlMaxHours = 24, timeoutMs = 30000 } = {}) {
  const key = readCloreKey(keyFile);
  if (!key) throw new Error('没有 clore_key');
  const r = await fetch('https://api.clore.ai/v1/marketplace', { headers: { auth: key }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const fx = await fetchFx();
  const servers = d.servers || [];
  const spot = {}, all = {}, mrls = {}, skipped = {}, fracDist = { '1.0': 0, partial: 0, null: 0 };
  const units = {}, unitsAll = {};
  let rented = 0;
  // 同时按 GPU 单元计数：跨场所比较的分母必须是"卡"，不是"房源"（2026-11-05）
  const fracUnits = { whole: 0, partial: 0, unknown: 0 }, totalUnits = {};
  let fieldMissing = 0;
  for (const s of servers) {
    const m = /^\s*(\d+)\s*x\s*(.+)$/.exec(s?.specs?.gpu || '');
    if (!m) continue;
    const cnt = +m[1];
    const k = modelKey(m[2]);
    if (!k) continue;
    // 已租的不算供给（2026-11-05 用户实测：Clore 41% 已租，含已租会把可得供给高估 1.7 倍）
    if (s.rented) { rented++; continue; }
    // 分数卡统计（Clore 的 partial_gpu_rental 与 gpu_array 都可能缺，缺就是缺，不默认整卡）
    totalUnits[k] = (totalUnits[k] || 0) + cnt;
    // Clore 结构上不提供分数卡（全量 2846 台 specs.gpu 全是 "Nx MODEL"，0 条小数表述）。
    // 所以 partial_gpu_rental 字段缺失 **不等于"未知/可能是分数卡"**，它就是整卡——
    // 把它记成 unknown 会让分母虚增、share 掉到 0.58（2026-11-12 就是这么来的）。
    // 字段缺失单独计数（fieldMissing），只用于监控我们自己的解析完整度。
    const pr = s?.partial_gpu_rental;
    if (pr === true || pr === 1) { fracDist.partial++; fracUnits.partial += cnt; }
    else {
      if (pr == null) fieldMissing++;
      fracDist['1.0']++; fracUnits.whole += cnt;
    }
    const mrl = Number(s.mrl);
    if (Number.isFinite(mrl)) (mrls[k] ||= []).push(mrl);
    const p = usdPerDayOf(s?.price || {}, 'spot', fx);
    // 两个口径都算：medAll（不过滤 mrl）与 med（mrl<=N）。
    // 2026-11-05 用户指出：我报的 $0.1679 与他独立拉到的 $0.25 差 33%，根因就是过滤藏在代码里。
    if (p) { (all[k] ||= []).push(p.usd / cnt / 24); unitsAll[k] = (unitsAll[k] || 0) + cnt; }
    if (Number.isFinite(mrl) && mrl > mrlMaxHours) { skipped[k] = (skipped[k] || 0) + 1; continue; }
    if (p) { (spot[k] ||= []).push(p.usd / cnt / 24); units[k] = (units[k] || 0) + cnt; }
  }
  const models = {};
  for (const k of Object.keys(spot)) {
    const a = spot[k].slice().sort((x, y) => x - y);
    const m = (arr) => (arr.length ? (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2) : null);
    const mr = (mrls[k] || []).slice().sort((x, y) => x - y);
    const aa = (all[k] || []).slice().sort((x, y) => x - y);
    models[k] = {
      n: a.length, min: +a[0].toFixed(4), med: +m(a).toFixed(4),
      nAll: aa.length, minAll: aa.length ? +aa[0].toFixed(4) : null, medAll: aa.length ? +m(aa).toFixed(4) : null,
      units: units[k] || 0, unitsAll: unitsAll[k] || 0,
      mrlMin: mr.length ? mr[0] : null, mrlMed: mr.length ? mr[mr.length >> 1] : null,
      skippedLongLease: skipped[k] || 0,
    };
  }
  const unitsTotal = fracUnits.whole + fracUnits.partial + fracUnits.unknown;
  // Clore 结构上不提供分数卡（全量 2846 台 specs.gpu 全是 "Nx MODEL"），所以 share 恒为 1.00。
  // 一旦 <0.999，说明是**我们的解析/归一化出问题**，不是市场变化 —— 必须标出来，不许进结论。
  // （2026-11-12 用户实测：0.582 是归一化失败量撑大了分母，不是 Clore 优势削弱）
  const wholeCardShare = unitsTotal ? +(fracUnits.whole / unitsTotal).toFixed(3) : null;
  const normalizeSuspected = wholeCardShare != null && wholeCardShare < 0.999;
  return { at: new Date().toISOString(), servers: servers.length, models, fracDist, fx,
    fracUnits: { ...fracUnits, total: unitsTotal },
    exhaustive: true,          // 全量拉取，没有配额截断
    rentableOnly: true,        // 已租的已剔除（41% 的机器在别人手里）
    rentedSkipped: rented,
    sampledRows: servers.length,
    wholeCardUnits: fracUnits.whole,
    wholeCardShare,
    normalizeSuspected,          // true → 该值不可用于任何结论（结构恒等 1.00 被打破）
    partialFieldMissing: fieldMissing,   // 解析完整度指标（Clore 恒无分数卡，缺字段按整卡算）
    filter: { mrlMaxHours, frac: '>=0.99', nGpu: 'all（整机价 ÷ 卡数）', priceKind: 'spot' } };
}
/** Clore 侧 countOffers：基于全量快照，exhaustive=true（唯一能给出确定计数的场所） */
export function countOffersClore(snapshot, query = {}) {
  const models = snapshot?.models || {};
  const key = query.gpu ? modelKey(query.gpu) : null;
  const rows = key ? (models[key] ? [[key, models[key]]] : []) : Object.entries(models);
  return {
    count: rows.reduce((a, [, v]) => a + (Number(v.n) || 0), 0),
    exhaustive: snapshot?.exhaustive !== false,
    sampledRows: snapshot?.sampledRows ?? null,
    asOf: snapshot?.at || null,
    query, byModel: Object.fromEntries(rows.map(([k, v]) => [k, v.n])),
  };
}
