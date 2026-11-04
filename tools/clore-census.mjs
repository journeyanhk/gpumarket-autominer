#!/usr/bin/env node
// Clore Spot / On-Demand 只读普查（B 线，零成本）：每小时把 Clore 的报价记一行，
// 和目标型号的 PRL 盈亏线、vast 竞价入场价对比，为 M3「第一个新市场」备数据。
//
// 为什么单独一个工具：venue-compare.mjs 是"随手比一次"，这里要的是**时间序列**——
// Clore 的清算价分布必须连跑几天才知道它是否长期低于 vast。
//
// 计价口径（2026-10-30 修正，重要）：
//   Clore 的 price 结构一套房源一个样：有的给 `USD-Blockchain`（美元挂牌）、有的只给
//   `bitcoin` / `CLORE-Blockchain`（币本位挂牌）、有的把算好的美元放在 `usd.on_demand_btc`。
//   老版本只读 `price.spot['USD-Blockchain']` 和 `usd.on_demand_usd`，会把"只有币本位报价"的房源
//   整条丢掉，而且看不出一条趋势到底是租金在动还是汇率在动。现在按优先级取 USD，并记录用了哪一路：
//     usd（平台美元）> ownerUsd（房东原始美元）> btc×FX > clore×FX
//   后两路是"我们替它换算"的，行里单独计数（fxSamples），并且把汇率与时间戳一起落盘——
//   3 天后翻 jsonl 时能把「租金涨了」和「BTC 涨了」分开。
//
// 用法：node tools/clore-census.mjs [--json] [--models "2080 Ti,3080,4070S,3090"]
// 输出：追加到 /data/prl-automine/clore-census.jsonl（一行一次采样）
import fs from 'node:fs';
import path from 'node:path';

const SEC = '/data/prl-automine/.secrets';
const OUT = '/data/prl-automine/clore-census.jsonl';
const CTRL = 'http://127.0.0.1:8290/api/state';
const TARGETS = (() => {
  const i = process.argv.indexOf('--models');
  const s = i > 0 ? process.argv[i + 1] : '2080 Ti,3080,4070S,3090';
  return s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
})();

const med = a => { const v = [...a].sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(4); };
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// Clore 的 mrl（最低租期，小时）：便宜档里常见 72/240/300/720 小时的长约。
// 不带过滤的"最低价"等于把 30 天锁定期当现货，而密度一个月能漂 ±50% → 默认只统计 mrl ≤ 24h。
const MRL_MAX = (() => { const i = process.argv.indexOf('--mrl'); return i > 0 ? Number(process.argv[i + 1]) : 24; })();

const readKey = () => {
  try {
    const raw = fs.readFileSync(path.join(SEC, 'clore_key'), 'utf8').trim();
    const m = /CLORE_KEY=(.+)/.exec(raw);
    return (m ? m[1] : raw).trim();
  } catch { return null; }
};

// 型号匹配：Clore 的 specs.gpu 形如 "1x RTX 3080" / "2x RTX 2080 Ti"
const modelKey = (s) => {
  const t = String(s || '').toLowerCase();
  if (/2080\s*ti/.test(t)) return '2080 Ti';
  if (/3080\s*ti/.test(t)) return '3080 Ti';
  if (/3080/.test(t)) return '3080';
  if (/4070\s*ti/.test(t)) return '4070 Ti';
  if (/4070\s*s|4070s/.test(t)) return '4070S';
  if (/3090/.test(t)) return '3090';
  if (/4060\s*ti/.test(t)) return '4060 Ti';
  return null;
};

// ---------- 汇率：只用公开行情，带时间戳 ----------
// Clore 自己也在换算（`usd.on_demand_btc` 就是它按内部价算的美元），所以"我们的换算"只作兜底，
// 但一旦用到就必须记下用了哪路、什么价、什么时候取的。
async function fetchFx() {
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
// src: usd=平台美元 | ownerUsd=房东原始美元 | btc=我们按 BTC 汇率换 | clore=我们按 CLORE 汇率换
function usdPerDayOf(p, kind, fx) {
  if (!p) return null;
  const direct = num(p?.[kind]?.['USD-Blockchain']);
  if (direct) return { usd: direct, src: 'usd' };
  // 平台已经算好的美元（只有按需有这组字段；spot 的 usd.spot 恒为 0，是坑）
  if (kind === 'spot') { const v = num(p?.usd?.spot); if (v) return { usd: v, src: 'usd' }; }
  const pre = num(kind === 'spot' ? p?.usd?.spot_usd : p?.usd?.on_demand_usd);
  if (pre) return { usd: pre, src: 'usd' };
  const preBtc = num(kind === 'spot' ? p?.usd?.spot_btc : p?.usd?.on_demand_btc);
  if (preBtc) return { usd: preBtc, src: 'usd' };
  const preClore = num(kind === 'spot' ? p?.usd?.spot_clore : p?.usd?.on_demand_clore);
  if (preClore) return { usd: preClore, src: 'usd' };
  // 房东自己填的美元价（未换算）
  for (const cc of ['USD-Blockchain', 'bitcoin', 'CLORE-Blockchain']) {
    const v = num(p?.original_usd?.[cc]?.[kind]);
    if (v) return { usd: v, src: 'ownerUsd' };
  }
  // 币本位 + 我们自己的汇率（带时间戳）
  const btc = num(p?.[kind]?.bitcoin);
  if (btc && fx.btcUsd) return { usd: btc * fx.btcUsd, src: 'btc' };
  const clore = num(p?.[kind]?.['CLORE-Blockchain']);
  if (clore && fx.cloreUsd) return { usd: clore * fx.cloreUsd, src: 'clore' };
  return null;
}

const out = { at: new Date().toISOString(), models: {}, vastMinBid: {}, breakeven: null, fx: null, error: null };

// 1) 本地口径：密度 + 每型号盈亏线（用控制台缓存，避免再算一遍）
try {
  const st = await (await fetch(CTRL, { signal: AbortSignal.timeout(10000) })).json();
  const density = Number(st?.market?.usdPerThDay) || 0;   // $/TH·天（Kryptex 保守口径）
  out.density = +density.toFixed(5);
  const target = Number(st?.config?.targetProfitPct) || 20;
  // 每型号参考算力（TH/s）：优先用控制台的型号表（含实测校准值），报价里的 thRaw 只作兜底。
  // 为什么改：0 台在跑、缓存报价里又刚好没有某个型号时，只从 offers 反推会让该型号的盈亏线变成 null，
  // 报告里就出现"有 Clore 报价但没有盈亏线"的空洞（2026-10-30 首跑后修正）。
  // 用**交付算力**（pricingTable 的 th = expectedDeliveredTh），不是规格算力。
  // 2026-11-04 发现：这里原来取 g.effective（规格），3080 会被高估约一倍，
  // 于是"盈亏线"算出来 $0.0596 而按交付算只有 $0.0357——Clore 那边直接对比会得出相反结论。
  const refTh = {};
  const thSource = {};
  for (const r of st?.pricingTable || []) {
    const k = modelKey(r.model);
    if (k && Number(r.th) > 0) {
      refTh[k] = +Number(r.th).toFixed(1);
      // 规格回退的型号（台账 0 条）必须标出来：它的"不亏线"是规格算力撑起来的，
      // 拿它去比 Clore 会重复 2026-11-04 那个 62% 高估的错。
      thSource[k] = r.thCalibrated === false || r.thSource === 'spec' ? 'spec' : (r.thSource || 'sample');
    }
  }
  for (const g of st?.table || []) {
    const k = modelKey(g.name || g.key);
    if (k && g.effective > 0 && !refTh[k]) refTh[k] = +Number(g.effective).toFixed(1);
  }
  for (const o of st?.offers || []) {
    const k = modelKey(o.gpuName);
    if (k && o.thRaw > 0 && !refTh[k]) refTh[k] = +Number(o.thRaw).toFixed(1);
  }
  // vast 竞价入场价（min_bid，单卡）
  for (const o of st?.offers || []) {
    const k = modelKey(o.gpuName); if (!k) continue;
    const per = (Number(o.minBid) || Number(o.dph) || 0) / (o.numGpus || 1);
    if (per > 0) (out.vastMinBid[k] ||= []).push(per);
  }
  for (const k of Object.keys(out.vastMinBid)) out.vastMinBid[k] = med(out.vastMinBid[k]);
  // 两个数必须分开（2026-11-04 用户判定：混用会让所有"差几个百分点"的判断错位）：
  //   breakeven = 交付算力 × 密度 ÷ 24           → ROI = 0 的租金上限（"不亏"线）
  //   ceiling   = breakeven ÷ (1 + 目标ROI%)      → 期望 ROI 达标的租金上限（"值得租"线）
  // 除数必须与闸门同源（2026-11-04 用户指出）：expRoi = roi×P − deploy ≥ target
  //   ⇒ 收入 ≥ 成本 × (1 + (target + deployPct)/P)，默认 ×1.467，不是 ×1.2（差 22%）
  const deployPct = (Number(st?.config?.deployCostMin ?? 2)) / 60 * 100;
  const pSurvive = Number(st?.config?.pSurviveDefault ?? 0.5) || 1;
  const roiReqPct = +(((target + deployPct) / pSurvive)).toFixed(1);
  out.roiReqPct = roiReqPct;
  out.breakeven = {}; out.ceiling = {};
  for (const [k, th] of Object.entries(refTh)) {
    const be = th * density / 24;
    out.breakeven[k] = +be.toFixed(4);
    out.ceiling[k] = +(be / (1 + roiReqPct / 100)).toFixed(4);
  }
  out.targetPct = Number(st?.config?.targetProfitPct) || 20;
  out.thSourceMap = thSource;
  out.refTh = refTh; out.targetPct = target; out.densitySrc = 'market.usdPerThDay（Kryptex 保守口径）';
} catch (e) { out.error = `本地口径失败：${e.message.slice(0, 80)}`; }

// 2) 汇率 + Clore 报价
try {
  const key = readKey();
  if (!key) throw new Error('没有 clore_key');
  const fx = await fetchFx();
  out.fx = fx;
  const r = await fetch('https://api.clore.ai/v1/marketplace', { headers: { auth: key }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const spot = {}, ond = {}, srcMix = {}, mrls = {}, skippedMrl = {};
  for (const s of d.servers || []) {
    const m = /^\s*(\d+)\s*x\s*(.+)$/.exec(s?.specs?.gpu || '');
    if (!m) continue;
    const cnt = +m[1];
    const k = modelKey(m[2]); if (!k || !TARGETS.includes(k.toLowerCase())) continue;
    if (s.rented) continue;
    const mrl = Number(s.mrl);
    if (Number.isFinite(mrl)) (mrls[k] ||= []).push(mrl);
    if (Number.isFinite(mrl) && mrl > MRL_MAX) { skippedMrl[k] = (skippedMrl[k] || 0) + 1; continue; }
    const p = s?.price || {};
    const sp = usdPerDayOf(p, 'spot', fx);
    const od = usdPerDayOf(p, 'on_demand', fx);
    const mix = srcMix[k] ||= { spot: {}, ond: {} };
    if (sp) { (spot[k] ||= []).push(sp.usd / cnt / 24); mix.spot[sp.src] = (mix.spot[sp.src] || 0) + 1; }   // $/天 ÷24 → $/h（单卡）
    if (od) { (ond[k] ||= []).push(od.usd / cnt / 24); mix.ond[od.src] = (mix.ond[od.src] || 0) + 1; }
  }
  for (const k of new Set([...Object.keys(spot), ...Object.keys(ond)])) {
    const sP = med(spot[k] || []), oP = med(ond[k] || []);
    const mrlArr = (mrls[k] || []).slice().sort((a, b) => a - b);
    const mrlMed = mrlArr.length ? mrlArr[Math.floor(mrlArr.length / 2)] : null;
    const mrlMin = mrlArr.length ? mrlArr[0] : null;
    const be = out.breakeven?.[k] ?? null;
    const ce = out.ceiling?.[k] ?? null;
    const mix = srcMix[k] || { spot: {}, ond: {} };
    // 需要我们自己换算的样本占比：>0 就说明这一列的价格里含汇率成分，趋势解读要拆开
    const fxShare = (m) => { const t = Object.values(m).reduce((a, b) => a + b, 0); return t ? +(((m.btc || 0) + (m.clore || 0)) / t * 100).toFixed(0) : null; };
    out.models[k] = {
      nSpot: (spot[k] || []).length, spotMed: sP, spotMin: spot[k]?.length ? +Math.min(...spot[k]).toFixed(4) : null,
      nOnDemand: (ond[k] || []).length, onDemandMed: oP,
      breakeven: be, ceiling: ce, targetPct: out.targetPct ?? null,
      thSource: (out.thSourceMap?.[k]) || 'spec', thCalibrated: ((out.thSourceMap?.[k]) || 'spec') !== 'spec',
      mrlMin, mrlMed, nSkippedMrl: skippedMrl[k] || 0, mrlMax: MRL_MAX,
      spotVsBreakeven: sP && be ? +(sP / be).toFixed(3) : null,        // <1 表示 Spot 比"不亏线"便宜
      spotVsCeiling: sP && ce ? +(sP / ce).toFixed(3) : null,          // <1 才是"值得租"（期望 ROI 达标）
      spotVsVast: sP && out.vastMinBid?.[k] ? +(sP / out.vastMinBid[k]).toFixed(3) : null,
      onDemandVsBreakeven: oP && be ? +(oP / be).toFixed(3) : null,
      onDemandVsVast: oP && out.vastMinBid?.[k] ? +(oP / out.vastMinBid[k]).toFixed(3) : null,
      srcMix: mix, spotFxShare: fxShare(mix.spot), onDemandFxShare: fxShare(mix.ond),
    };
  }
} catch (e) { out.error = (out.error ? out.error + '；' : '') + `Clore：${e.message.slice(0, 90)}`; }

// 3) 落盘一行
try { fs.appendFileSync(OUT, JSON.stringify(out) + '\n'); } catch { /* 写不进去不算失败 */ }

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`Clore Spot 普查 ${out.at}｜密度 $${out.density ?? '—'}/TH·天`);
if (out.fx) console.log(`汇率：BTC $${out.fx.btcUsd ?? '—'}（${out.fx.src.btc || '—'}）/ CLORE $${out.fx.cloreUsd ?? '—'}（${out.fx.src.clore || '—'}），取样于 ${out.fx.at}`);
if (out.error) console.log(`⚠ ${out.error}`);
const rows = Object.entries(out.models);
if (!rows.length) console.log('（本次没有目标型号的 Clore 报价）');
else {
  console.log('型号       Spot样本 Spot中位 不亏线 达标线 Spot/达标 Spot/vast 按需中位 按需/达标 mrl中位 长租跳过 汇率依赖');
  for (const [k, v] of rows) {
    const tag = v.thCalibrated === false ? '*' : ' ';
    console.log(`${(k + tag).padEnd(10)} ${String(v.nSpot).padStart(6)}  ${String(v.spotMed ?? '—').padStart(8)}  ${String(v.breakeven ?? '—').padStart(6)}  ${String(v.ceiling ?? '—').padStart(6)}  ${String(v.spotVsCeiling ?? '—').padStart(8)}  ${String(v.spotVsVast ?? '—').padStart(8)}  ${String(v.onDemandMed ?? '—').padStart(8)}  ${String(v.onDemandVsBreakeven ?? '—').padStart(8)}  ${String(v.mrlMed ?? '—').padStart(7)}  ${String(v.nSkippedMrl ?? 0).padStart(8)}  ${String(v.spotFxShare ?? '—').padStart(4)}%`);
  }
  // 只有"交付算力有台账支撑"的型号才允许进"便宜"名单（spec 回退的一律不算）
  const win = rows.filter(([, v]) => v.thCalibrated !== false && ((v.spotVsCeiling != null && v.spotVsCeiling < 1) || (v.onDemandVsBreakeven != null && v.onDemandVsBreakeven < 1)));
  const specOnly = rows.filter(([, v]) => v.thCalibrated === false).map(([k]) => k);
  console.log(`口径：不亏线 = 交付算力×密度÷24（ROI=0）；达标线 = 不亏线÷(1+${out.roiReqPct ?? '—'}%)（闸门口径，与 isRentable 同源）。mrl > ${MRL_MAX}h 已排除。`);
  if (specOnly.length) console.log(`⚠ 规格回退（台账 0 条，不参与"便宜"判定）：${specOnly.join('、')}`);
  console.log(win.length ? `✅ 低于达标线：${win.map(([k]) => k).join('、')}` : '没有型号的 Spot / 按需低于达标线');
}
