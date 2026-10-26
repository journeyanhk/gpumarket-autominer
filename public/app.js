'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = null;
let settingsOpen = false;

// ---------- 格式化 ----------
const usd = (v, d = 2) => v == null || !isFinite(v) ? '—' : (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(d);
const pct = (v, d = 1) => v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
const num = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toFixed(d);
function hs(v) {
  if (!v) return '0';
  const u = [['EH/s', 1e18], ['PH/s', 1e15], ['TH/s', 1e12], ['GH/s', 1e9]];
  for (const [n, k] of u) if (v >= k) return (v / k).toFixed(v / k >= 100 ? 1 : 2) + ' ' + n;
  return v.toFixed(0) + ' H/s';
}
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}
function dur(min) {
  if (min == null) return '—';
  if (min < 60) return Math.floor(min) + ' 分钟';
  const h = Math.floor(min / 60), m = Math.floor(min % 60);
  return h < 48 ? `${h} 小时 ${m} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}
const clsRoi = v => v == null ? '' : v >= (S?.config.targetProfitPct ?? 30) ? 'up' : v < (S?.config.stopLossPct ?? 0) ? 'down' : '';
const flag = g => esc(g || '').replace(/^.*,\s*/, '') || '—';
const POOL_NAME = { pearlhash: 'Pearlhash', kryptex: 'Kryptex' };
const pn = id => POOL_NAME[id] || id || '—';
const poolTag = (id, extra = '') => `<span class="pool-tag ${esc(id)}${extra}">${pn(id)}</span>`;

function spark(values, color) {
  const v = values.filter(x => x != null && isFinite(x));
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const W = 200, H = 52;
  const pts = v.map((x, i) => [i / (v.length - 1) * W, H - 6 - (x - min) / span * (H - 14)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
function roiBar(v) {
  const t = S.config.targetProfitPct, max = Math.max(100, t * 2);
  const w = Math.max(0, Math.min(100, (v ?? 0) / max * 100));
  const c = v == null ? 'var(--muted-2)' : v >= t ? 'var(--green)' : v < S.config.stopLossPct ? 'var(--red)' : 'var(--amber)';
  return `<div class="bar"><i style="width:${w}%;background:${c};color:${c}"></i><span class="tick" style="left:${Math.min(100, t / max * 100)}%"></span></div>`;
}

// ---------- 渲染 ----------
const PAGES = {
  overview: ['MINING FARM', '矿场总览'],
  pools: ['MINING POOLS', '矿池'],
  market: ['VAST.AI MARKET', '市场机会'],
  ref: ['HASHRATE TABLE', '显卡算力'],
  log: ['EVENT LOG', '运行日志'],
};
function showPage(p) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + p));
  $('#page-eyebrow').textContent = PAGES[p][0];
  $('#page-title').textContent = PAGES[p][1];
  $('#sidebar').classList.remove('open');
  try { localStorage.setItem('prl-page', p); } catch {}
}
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
$('#menu-button').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
try { const p = localStorage.getItem('prl-page'); if (p && PAGES[p]) showPage(p); } catch {}
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);

function render() {
  if (!S) return;
  const m = S.market, a = S.account, s = S.summary, c = S.config;
  $('#swRent').checked = c.autoRent;
  $('#swDestroy').checked = c.autoDestroy;
  $('#meta-wr').textContent = S.wildrig?.version || '—';
  $('#meta-port').textContent = location.port || '—';

  // 侧边栏：数据源 & 连接状态
  const src = (cls, name, val, title = '') => `<div class="src ${cls}" title="${esc(title)}"><i></i>${name}<em>${esc(val)}</em></div>`;
  const vastCls = !c.hasApiKey ? 'bad' : a.error ? 'bad' : 'ok';
  const poolCls = m.fresh ? 'ok' : m.updatedAt ? 'warn' : 'bad';
  const scanCls = S.offerStats.error ? 'bad' : S.offerStats.pausedUntil ? 'warn' : S.offerStats.scannedAt ? 'ok' : '';
  $('#chips').innerHTML = [
    src(poolCls, 'Pearlhash', m.fresh ? ago(m.updatedAt) : '异常', m.error || ''),
    ...(S.pools || []).filter(p => p.id === 'kryptex' && p.configured).map(p => src(p.apiOk ? 'ok' : 'bad', 'Kryptex', p.apiOk ? '在线' : '异常', p.apiError || '')),
    src(vastCls, 'vast.ai', !c.hasApiKey ? '未配置' : a.error ? '异常' : '在线', a.error || a.vastEmail || ''),
    src(scanCls, '市场扫描', S.offerStats.pauseReason === 'quota' ? `额度用完 ${new Date(S.offerStats.pausedUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 恢复` : S.offerStats.pausedUntil ? '稍后重试' : S.offerStats.plan && S.offerStats.nextScanAt == null ? '已满额 暂停' : ago(S.offerStats.scannedAt), S.offerStats.plan || S.offerStats.error || ''),
    src(m.nockPrice ? 'ok' : 'warn', 'NOCK 价格', m.nockSrc || '—'),
  ].join('');
  const cc = $('#conn-card');
  const bad = poolCls === 'bad' || vastCls === 'bad';
  cc.className = 'connection-card' + (bad ? ' offline' : (poolCls !== 'ok' || scanCls === 'warn') ? ' degraded' : '');
  $('#conn-title').textContent = !c.hasApiKey ? '等待配置' : bad ? '连接异常' : '实时监控中';
  $('#conn-sub').textContent = !c.hasApiKey ? '先在设置里填 API Key' : bad ? (a.error || m.error || '数据源异常').slice(0, 26) : `在租 ${s.count} 台 · 达标机会 ${S.offerStats.profitable}`;

  // 顶栏模式
  const mp = $('#mode-pill');
  const pre = S.preflight.filter(x => !x.includes('行情') || !m.updatedAt);
  mp.className = 'mode-pill ' + (c.autoRent ? (pre.length ? 'warn' : 'live') : '');
  mp.querySelector('b').textContent = c.autoRent ? (pre.length ? 'AUTO · 暂停' : 'AUTO RENT') : 'WATCH ONLY';

  // 侧边栏仪表盘：综合收益率，0% 在左端，目标×2 在右端
  const t = c.targetProfitPct, max = Math.max(60, t * 2), min = Math.min(-50, -t);
  const roi = s.roi;
  const frac = roi == null ? 0 : Math.max(0, Math.min(1, (roi - min) / (max - min)));
  const fill = $('#gauge-fill');
  fill.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
  fill.style.stroke = roi == null ? 'var(--muted-2)' : roi >= t ? 'var(--green)' : roi < c.stopLossPct ? 'var(--red)' : 'var(--amber)';
  $('#gauge-needle').setAttribute('transform', `rotate(${(-90 + frac * 180).toFixed(1)} 110 110)`);
  $('#gauge-mark').style.transform = `rotate(${(-90 + (t - min) / (max - min) * 180).toFixed(1)}deg)`;
  $('#gauge-roi').textContent = pct(roi);
  $('#gauge-roi').className = clsRoi(roi);
  $('#gauge-target').textContent = `目标 ${t}%`;
  $('#gauge-sub').textContent = s.count ? `${s.count} 台 · ${usd(s.profitHr * 24)}/天` : '暂无在租机器';

  // 导航计数
  $('#nav-inst').textContent = s.abnormal ? `${s.abnormal}!` : s.count;
  $('#nav-inst').classList.toggle('alert', !!s.abnormal);
  const navO = $('#nav-offers');
  navO.textContent = S.offerStats.profitable;
  navO.classList.toggle('hot', S.offerStats.profitable > 0);
  $('#nav-log').textContent = S.events.length;
  const navP = $('#nav-pools');
  const badPool = (S.pools || []).find(p => p.configured && p.health?.bad);
  navP.textContent = badPool ? '!' : ({ pearlhash: 'PH', kryptex: 'KX' }[c.effectiveDefaultPool] || '—');
  navP.classList.toggle('alert', !!badPool);

  // 横幅
  let banner = '';
  const nd = S.netDown || {};
  const downParts = [nd.vastMin >= 3 ? `vast（${Math.round(nd.vastMin)} 分钟）` : '', nd.pearlMin >= 3 ? `Pearlhash（${Math.round(nd.pearlMin)} 分钟）` : ''].filter(Boolean);
  if (downParts.length) banner = `<div class="banner bad">⚠ 程序连不上 <b>${downParts.join('、')}</b>：止损、自动退租、算力监控都已暂停，<b>已租机器仍在计费</b>。请检查网络，或杀毒软件（如 360）是否拦截了 node.exe。</div>`;
  else if (!c.hasApiKey) banner = `<div class="banner info">第一次使用：先在设置里填 <b>vast API Key</b>，再到「矿池」页填钱包地址。填好后程序会开始扫描市场（不会自动租，需要你手动打开「自动租用」）。<button class="small-button go" onclick="openSettings()">去设置</button></div>`;
  else if (!c.walletValid && !c.kryptexWalletValid) banner = `<div class="banner info">还没填钱包：到「矿池」页给 Pearlhash 或 Kryptex 填上 PRL 钱包地址（两个池可以用不同的钱包，方便分开统计收益）。<button class="small-button go" onclick="showPage('pools')">去填写</button></div>`;
  else if (badPool) banner = `<div class="banner bad">⚠ <b>${pn(badPool.id)}</b> 疑似故障（${esc(badPool.health.why)}，已持续 ${dur(badPool.health.badMin)}）。${c.failover && S.pools.filter(p => p.configured).length > 1 ? `持续 ${c.failoverMinutes} 分钟会把可切换的机器自动转到另一个矿池。` : '可以在「矿池」页打开故障自动切换，或手动切换机器。'}</div>`;
  else if (s.abnormal) banner = `<div class="banner bad"><b>${s.abnormal}</b> 台机器算力异常（低于预期 ${c.hashLowPct}% 或有显卡掉线），已排在「已租显卡」最前面并标红，可以点卡片上的「↻ 重启」。</div>`;
  else if (c.autoRent && S.offerStats.pauseReason === 'quota') banner = `<div class="banner">vast 今日搜索额度已用完，<b>${new Date(S.offerStats.pausedUntil).toLocaleString('zh-CN', { hour12: false })}</b> 恢复。在此之前不会自动租新机器，已租的机器照常监控、止损和重启。</div>`;
  else if (c.autoRent && a.vastBalance != null && S.budget.spendCapByRunway != null && S.budget.spendCapByRunway < c.maxHourlySpend && s.spendHr + 0.02 >= S.budget.spendCapByRunway) banner = `<div class="banner">余额 <b>${usd(a.vastBalance)}</b> 只够每小时花 <b>${usd(S.budget.spendCapByRunway)}</b>（保证续航 ${c.minRunwayHours} 小时），已暂停新租。充值后会自动继续。</div>`;
  else if (c.autoRent && pre.length) banner = `<div class="banner">自动租用已开启，但暂时不会下单：${esc(pre.join('、'))}</div>`;
  else if (s.roi != null && s.roi < c.stopLossPct) {
    const hasManual = S.instances.some(x => !x.managed && x.phase === 'loss');
    banner = `<div class="banner bad">当前综合收益率 <b>${pct(s.roi)}</b> 低于止损线 ${c.stopLossPct}%。本程序租的亏损机器会在持续 ${c.stopLossMinutes} 分钟后${c.autoDestroy ? '自动退租' : '提醒（自动退租已关闭）'}${hasManual ? '；手动租的亏损机器不会自动退，需要你自己决定' : ''}。</div>`;
  }
  $('#banner').innerHTML = banner;

  // KPI
  const H = S.history;
  const ch = m.change24h;
  const nockTag = m.nockBonusPct > 0 ? `<i class="up">含 NOCK +${num(m.nockBonusPct, 2)}%</i>`
    : a.nockPayoutAddress ? '<i>NOCK 未计入</i>'
    : `<i title="矿池里还没登记 NOCK 收款地址，领不到所以不计入；登记后约多 ${num(m.nockPotentialPct, 2)}%">NOCK 未登记</i>`;
  $('#kpis').innerHTML = `
    <div class="stat-card accent-green"><div class="stat-top"><span>PRL 价格</span><i class="${ch >= 0 ? 'up' : 'down'}">${pct(ch)} 24H</i></div>
      <strong>${usd(m.price, 4)}</strong>
      <div class="stat-foot">NOCK <b>${m.nockPrice ? usd(m.nockPrice, 4) : '—'}</b>${m.nockPerPrl ? ` · 每 PRL 附 <b>${num(m.nockPerPrl, 2)}</b> NOCK` : ''}</div>
      ${spark(H.map(h => h.price), '#b6f36b')}</div>
    <div class="stat-card accent-cyan"><div class="stat-top"><span>全网算力</span><i>#${m.height ?? '—'}</i></div>
      <strong>${m.networkHs ? (m.networkHs / 1e18).toFixed(2) : '—'}<span>EH/s</span></strong>
      <div class="stat-foot">出块 <b>${m.blockTime ? m.blockTime.toFixed(0) + 's' : '—'}</b> · 奖励 <b>${num(m.reward, 1)}</b> PRL</div>
      ${spark(H.map(h => h.netEh), '#59dfe9')}</div>
    <div class="stat-card accent-violet"><div class="stat-top"><span>每 TH/s 日收益 · ${pn(m.defaultPool)}</span>${m.defaultPool === 'pearlhash' ? nockTag : `<i>矿池+矿工费 ${num(m.defaultFee * 100, 1)}% · 无 NOCK</i>`}</div>
      <strong>${usd(m.usdPerThDay, 4)}<span>${num(m.prlPerThDay, 4)} PRL</span></strong>
      <div class="stat-foot">每 $0.1/h 租金 · 保本 <b>${num(S.breakEvenPer01, 0)}</b> TH · 达标 <b class="up">${num(S.targetPer01, 0)}</b> TH</div>
      ${spark(H.map(h => h.usdPerThDay), '#a88bff')}</div>
    <div class="stat-card accent-amber"><div class="stat-top"><span>vast 余额</span><i>${esc(a.vastEmail || '')}</i></div>
      <strong>${usd(a.vastBalance)}</strong>
      <div class="stat-foot">${s.runwayHours != null ? '按当前花费可跑 <b>' + dur(s.runwayHours * 60) + '</b>' : '当前没有计费中的机器'}</div></div>`;

  $('#strip').innerHTML = `
    <div><span>在租机器</span><b>${s.count}<span class="dim" style="display:inline;font-size:12px"> / ${c.maxInstances}</span></b><small>挖矿中 ${s.mining}${s.abnormal ? ` · <span class="down">异常 ${s.abnormal}</span>` : ''}</small></div>
    <div><span>总算力 · 10 分钟</span><b>${hs(s.totalHs)}</b><small>${num(s.prlPerDay, 1)} PRL / 天</small></div>
    <div><span>每小时成本</span><b>${usd(s.spendHr, 3)}</b><small>${S.budget.spendCapByRunway != null && S.budget.spendCapByRunway < c.maxHourlySpend ? `续航上限 ${usd(S.budget.spendCapByRunway, 2)}` : `上限 ${usd(c.maxHourlySpend, 2)}${c.runwayGuard ? '' : ' · 续航保护关'}`}</small></div>
    <div><span>每小时收益</span><b>${usd(s.revenueHr, 3)}</b><small>${s.estimatedCount ? `含 ${s.estimatedCount} 台预估` : '全部实测'}</small></div>
    <div class="tm-roi"><span>综合收益率</span><b class="${clsRoi(s.roi)}">${pct(s.roi)}</b><small>目标 ${c.targetProfitPct}% · 止损 ${c.stopLossPct}%</small></div>
    <div><span>每日净利</span><b class="${s.profitHr >= 0 ? 'up' : 'down'}">${usd(s.profitHr * 24)}</b><small>${usd(s.profitHr, 3)} / 小时</small></div>
    ${(() => { const kx = (S.pools || []).find(p => p.id === 'kryptex' && p.configured); const kb = kx?.pending?.prl ?? 0;
      return `<div><span>矿池待结算</span><b>${num((a.prlPending || 0) + kb, 3)}<span class="dim" style="display:inline;font-size:11px"> PRL</span></b><small>${kx ? `PH ${num(a.prlPending, 2)} · KX ${num(kb, 2)}` : `${num(a.nockPending, 3)} NOCK`}</small></div>`; })()}`;

  renderCards();
  renderPools();
  renderOffers();
  renderTable();
  renderLog();
}

const PHASE = { mining: '挖矿中', booting: '部署中', restarting: '重启中', switching: '切换矿池', unmatched: '未匹配', nohash: '无算力', loss: '低于止损', offline: '离线', stopped: '已停止' };
const HEALTH = { low: '算力偏低', gpu: '显卡异常' };
const isAbnormal = x => ['low', 'gpu'].includes(x.health) || ['nohash', 'offline'].includes(x.phase);

// 单台机器最近 60 分钟算力曲线：实线 = 实测，虚线 = 预期，阴影 = 合理范围（预期 × 下限% ~ 预期）
function hashChart(x) {
  // 时间窗随数据长度自适应：最少 10 分钟，最多 60 分钟
  const span = Math.max(600, Math.min(3600, -Math.min(0, ...x.series.map(p => p[0]))));
  const pts = x.series.filter(p => p[0] >= -span);
  const exp = x.expectedHs / 1e12, low = exp * (S.config.hashLowPct / 100);
  const W = 300, H = 64, padT = 6, padB = 4;
  const maxV = Math.max(exp * 1.15, ...pts.map(p => p[1]), 1);
  const X = t => (t + span) / span * W;
  const Y = v => H - padB - v / maxV * (H - padT - padB);
  const line = pts.length > 1 ? pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join('') : '';
  const col = isAbnormal(x) ? 'var(--red)' : ['restarting', 'booting', 'switching'].includes(x.phase) ? 'var(--cyan)' : 'var(--green)';
  const mark = t => t && t > Date.now() - span * 1000 ? `<line class="rs" x1="${X((t - Date.now()) / 1000).toFixed(1)}" x2="${X((t - Date.now()) / 1000).toFixed(1)}" y1="0" y2="${H}"/>` : '';
  const last = pts[pts.length - 1];
  return `<div class="hash-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${exp ? `<rect x="0" y="${Y(exp).toFixed(1)}" width="${W}" height="${(Y(low) - Y(exp)).toFixed(1)}" class="band"/>
      <line x1="0" x2="${W}" y1="${Y(exp).toFixed(1)}" y2="${Y(exp).toFixed(1)}" class="exp"/>` : ''}
      ${mark(x.restartAt)}${mark(x.poolSince)}${mark(x.switching?.at)}
      ${line ? `<path d="${line}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : ''}
      ${last ? `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2.5" fill="${col}"/>` : ''}
    </svg>
    <div class="hash-axis"><span>${Math.round(span / 60)} 分钟前</span><span>${exp ? `预期 ${num(exp, 0)} · 下限 ${num(low, 0)} TH/s` : '未知型号'}</span><span>现在</span></div>
  </div>`;
}

function gpuBars(x) {
  if (!x.gpus || !x.gpus.length) return '';
  if (x.gpus.length === 1 && x.numGpus === 1) return '';
  const per = x.perGpuHs / 1e12;
  const rows = x.gpus.map((g, i) => {
    const r = per ? g.hs / 1e12 / per : null;
    const w = Math.max(2, Math.min(100, (r ?? 0) * 100 / 1.2));
    return `<div class="gpu-row ${g.ok === false ? 'bad' : ''}"><span>GPU${i}</span><div class="gbar"><i style="width:${w}%"></i><em style="left:${(S.config.hashLowPct / 1.2).toFixed(1)}%"></em></div><b>${num(g.hs / 1e12, 0)}</b></div>`;
  });
  for (let i = x.gpus.length; i < x.numGpus; i++) rows.push(`<div class="gpu-row bad"><span>GPU${i}</span><div class="gbar"></div><b>离线</b></div>`);
  return `<div class="gpu-list">${rows.join('')}</div>`;
}

// 部署进行到哪一步：① vast 拉镜像/开机 ② 下载并启动矿工 ③ 等矿池上报
function deployStage(x) {
  const d = x.deploy, now = Date.now();
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const tail = `（共 ${mmss(now - (d?.rentedAt || now))}，超过 ${S.config.bootTimeoutMinutes} 分钟无算力自动退租）`;
  if (!d || !d.runningAt) {
    const msg = x.statusMsg ? ` · ${x.statusMsg.slice(0, 60)}` : '';
    return `① vast 正在拉取镜像并开机${d?.inetDown ? `（带宽 ${Math.round(d.inetDown)} Mbps）` : ''}${msg}${tail}`;
  }
  const stuck = now - d.runningAt > 4 * 60000;
  return `② 已开机 ${mmss(now - d.runningAt)}，正在下载矿工并连接矿池${stuck ? `（正常不到 1 分钟，超过 ${S.config.minerStartTimeoutMinutes} 分钟会判定失败并退租）` : tail}${x.logHint ? `\n机器日志：${x.logHint}` : ''}`;
}
function deployDone(x) {
  const d = x.deploy;
  if (!d || !d.hashAt) return '';
  const mm = ms => `${Math.floor(ms / 60000)}分${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}秒`;
  return `部署 ${mm(d.hashAt - d.rentedAt)}${d.runningAt ? `（镜像 ${mm(d.runningAt - d.rentedAt)} · 矿工 ${mm(d.hashAt - d.runningAt)}）` : ''}`;
}

function renderCards() {
  const list = [...S.instances].sort((a, b) => isAbnormal(b) - isAbnormal(a));
  const nAb = list.filter(isAbnormal).length;
  $('#instCount').textContent = list.length ? `${list.length} 台${nAb ? ` · ${nAb} 台异常` : ''}` : '';
  const da = S.deployAvg, m2 = v => v == null ? '?' : `${Math.floor(v / 60)}分${String(Math.round(v % 60)).padStart(2, '0')}秒`;
  $('#instHint').textContent = [
    da ? `最近 ${da.n} 台平均部署 ${m2(da.total)}（拉镜像 ${m2(da.pull)} · 启动矿工 ${m2(da.miner)}）` : '',
    list.some(x => !x.managed) ? '紫色「手动」= 不是本程序租的，只监控不自动退租' : '',
  ].filter(Boolean).join('　·　');
  if (!list.length) { $('#cards').innerHTML = `<div class="empty">还没有租用的机器。${S.config.autoRent ? '达到目标收益率的机器出现时会自动租下。' : '打开右上角「自动租用」，或到「市场机会」手动租一台。'}</div>`; return; }
  $('#cards').innerHTML = list.map(x => {
    const showRoi = x.roi ?? x.expRoi;
    const rev = x.roi != null ? x.revenueHr : x.expRevenueHr;
    const ab = isAbnormal(x);
    const notes = [];
    if (x.switching) notes.push(['info', `${x.switching.auto ? '自动' : ''}切换矿池 ${pn(x.switching.from)} → ${pn(x.switching.to)}${x.switching.reason ? '（' + x.switching.reason + '）' : ''}，已 ${dur((Date.now() - x.switching.at) / 60000)}。机器每分钟检查一次，通常 1~2 分钟生效，8 分钟没在新矿池出算力会自动改回`]);
    else if (x.phase === 'restarting') notes.push(['info', `已重启 ${dur((Date.now() - x.restartAt) / 60000)}，等待矿工重新上线（${S.config.bootTimeoutMinutes} 分钟内不会自动退租）`]);
    else if (x.roi == null) notes.push(x.phase === 'booting' ? ['info', deployStage(x)]
      : x.phase === 'unmatched' ? ['warn', '矿池里没找到这台机器的矿工 → 点「绑定矿工名」填你启动时用的名字（如 5080）']
      : x.phase === 'nohash' ? ['bad', '矿工掉线，矿池里已经看不到它的算力 → 建议重启']
      : ['', '暂无实测算力，收益率为预估值']);
    if (x.failoverFrom && !x.switching) notes.push(['warn', `${pn(x.failoverFrom)} 故障时自动转到这里，恢复后会自动切回`]);
    if (x.pool !== x.wantPool && !x.switching && x.phase !== 'booting') notes.push(['warn', `标签要求挖 ${pn(x.wantPool)}，但矿池数据显示它在 ${pn(x.pool)} 出算力`]);
    if (x.belowSince) notes.push(['warn', `跌破止损已 ${dur((Date.now() - x.belowSince) / 60000)}，满 ${S.config.stopLossMinutes} 分钟${x.managed ? '将自动退租' : '（手动机器不会自动退）'}`]);
    const healthPill = x.health && x.health !== 'ok' ? `<span class="status-tag hbad">${HEALTH[x.health]}</span>` : '';
    const ratio = x.hashRatio;
    return `<div class="rig ${x.phase} ${ab ? 'abnormal' : ''}">
      <div class="rig-head">
        <div class="rig-icon">${x.numGpus}×</div>
        <div class="rig-name"><b>${esc(x.gpuName)}</b>
          <small>#${x.id} · ${flag(x.geolocation)} · ${dur(x.ageMin)}${x.gpuTemp > 0 ? ' · ' + Math.round(x.gpuTemp) + '°C' : ''}${x.gpuUtil > 0 ? ' · 负载 ' + Math.round(x.gpuUtil) + '%' : ''}</small></div>
        <div class="rig-tags">${x.managed ? '' : '<span class="status-tag manual">手动</span>'}${switchTag(x)}${healthPill}<span class="status-tag ${x.phase}">${PHASE[x.phase] || x.status}</span></div>
      </div>
      ${ab && x.healthMsg ? `<div class="health-alert"><b>${esc(x.healthMsg)}</b><span>实测 ${hs(x.hs5 || x.liveHs)} · 预期 ${hs(x.expectedHs)}</span></div>` : ''}
      <div class="hash-head"><span>算力 · 5 分钟</span><b class="${ab ? 'down' : ''}" ${x.hsEstimated ? 'title="Kryptex 只提供 30 分钟平均算力，前 30 分钟按连接时长换算"' : ''}>${x.hs5 || x.liveHs ? (x.hsEstimated ? '≈' : '') + hs(x.hs5 || x.liveHs) : '—'}</b>
        <em class="${ratio == null ? 'dim' : ratio * 100 < S.config.hashLowPct ? 'down' : 'up'}">${ratio == null ? (x.healthMsg || '') : Math.round(ratio * 100) + '% 预期'}</em></div>
      ${hashChart(x)}
      ${gpuBars(x)}
      <div class="rig-metrics">
        <div><span>时租</span><b>${usd(x.dph, 3)}</b></div>
        <div><span>收益 / 小时</span><b>${usd(rev, 3)}</b></div>
        <div><span>利润 / 天</span><b class="${rev - x.dph >= 0 ? 'up' : 'down'}">${usd((rev - x.dph) * 24)}</b></div>
      </div>
      <div class="rig-roi"><strong class="${clsRoi(showRoi)}">${pct(showRoi)}</strong>${roiBar(showRoi)}</div>
      ${notes.map(([k, t]) => `<div class="rig-note ${k}">${esc(t)}</div>`).join('')}
      <div class="rig-foot">
        <span class="foot-meta">${deployDone(x) ? `<span title="从租下到出算力">${deployDone(x)}</span><br>` : ''}矿工 <b>${esc(x.worker)}</b> · <button class="text-button" onclick="setAlias('${x.id}','${esc(x.worker)}')">绑定</button></span>
        <div class="foot-actions">
          <button class="small-button" onclick="showLogs('${x.id}','${esc(x.numGpus + '× ' + x.gpuName)}')">日志</button>
          <button class="small-button ${ab ? 'warn-btn' : ''}" ${x.phase === 'restarting' ? 'disabled' : ''} onclick="rebootInst('${x.id}')">${x.phase === 'restarting' ? '重启中…' : '↻ 重启'}</button>
          <button class="small-button danger" onclick="destroyInst('${x.id}','${esc(x.numGpus + '× ' + x.gpuName)}',${x.dph})">退租</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// 卡片右上角的矿池标签：能切换时可以点（只有 2 个矿池，点一下切到另一个）
function switchTag(x) {
  if (x.switching) return `<span class="pool-tag ${x.switching.to} pending" title="正在切换到 ${pn(x.switching.to)}">${pn(x.switching.to)} …</span>`;
  const other = x.wantPool === 'kryptex' ? 'pearlhash' : 'kryptex';
  const conf = (S.pools || []).find(p => p.id === other)?.configured;
  const why = !(x.switchable || []).length ? '旧版脚本租的（或手动部署的）机器不支持切换矿池，新租的机器才可以'
    : !(x.switchable || []).includes(other) ? (other === 'kryptex' && x.scriptVer === 2 ? '这台是上一版程序租的，挖 Kryptex 用的 WildRig 不兼容，新租的机器才能切 Kryptex' : `租这台机器时还没填 ${pn(other)} 钱包，脚本里没有它的参数，不能切过去`)
    : !conf ? `${pn(other)} 钱包已清空` : '';
  if (why) return `<span class="pool-tag ${x.pool}" title="${esc(why)}">${pn(x.pool)}</span>`;
  return `<button class="pool-tag ${x.pool} can" title="点击切换到 ${pn(other)}" onclick="switchPool('${x.id}','${other}')">${pn(x.pool)} ⇄</button>`;
}

// ---------- 矿池页 ----------
let cmpWin = 'all';
try { cmpWin = localStorage.getItem('prl-cmp') || 'all'; } catch {}
function poolCard(p) {
  const c = S.config, h = p.health;
  const isPh = p.id === 'pearlhash';
  const walletName = isPh ? 'wallet' : 'kryptexWallet';
  const hintOk = p.configured ? '<small class="field-help ok">✓ 地址校验通过</small>' : p.wallet ? '<small class="field-help bad">✗ 地址无效</small>' : '<small class="field-help">挖到的币打到这个地址；不填 = 不用这个矿池</small>';
  const status = !p.configured ? ['', '未启用'] : p.apiOk ? ['ok', '数据正常'] : ['bad', '数据异常'];
  const pend = isPh ? `待结算 <b>${num(p.pending?.prl, 3)}</b> PRL · <b>${num(p.pending?.nock, 3)}</b> NOCK`
    : p.pending ? `余额 <b>${num(p.pending.prl, 3)}</b> PRL · 累计已付 <b>${num(p.pending.paid, 2)}</b>` : '余额 —';
  return `<div class="pool-card ${p.id} ${p.isDefault ? 'default' : ''} ${p.configured ? '' : 'off'}" data-pool="${p.id}">
    <div class="pool-head">
      <div class="pool-logo">${p.name.slice(0, 1)}</div>
      <div class="pool-title"><b>${p.name}</b><small>手续费 ${num(p.fee * 100, 0)}% · 矿工 ${p.miner}${p.minerFee ? ` 开发费 ${num(p.minerFee * 100, 0)}%` : ' 0 开发费'}${isPh ? ' · 按出块分配 · NOCK 合并挖矿' : ' · PPS+ 按份额固定付'}</small></div>
      <div class="pool-badges">${p.isDefault ? '<span class="status-tag">默认矿池</span>' : ''}<span class="src ${status[0]}"><i></i>${status[1]}</span></div>
    </div>
    <div class="pool-metrics">
      <div><span>在挖机器</span><b>${p.rigs}</b></div>
      <div><span>算力</span><b>${hs(p.hs)}</b></div>
      <div><span>每 TH/s 日收益</span><b>${usd(p.usdPerThDay, 4)}</b></div>
      <div><span>收益 / 租金 每小时</span><b>${usd(p.revenueHr, 3)} / ${usd(p.spendHr, 3)}</b></div>
    </div>
    <div class="pool-form form-grid">
      <label class="span-2">${p.name} 收款钱包（PRL）<input name="${walletName}" value="${esc(p.wallet)}" placeholder="prl1..." autocomplete="off" spellcheck="false">${hintOk}</label>
      ${isPh ? `<label class="span-2">NOCK 收款地址（可选）<input name="nockAddress" value="${esc(c.nockAddress || '')}" placeholder="Nockchain 钱包地址" autocomplete="off" spellcheck="false">
        <small class="field-help">填了以后新租的机器用「PRL地址@nock=NOCK地址」登录 Pearlhash，额外分 NOCK</small></label>
        <label class="check span-2"><input type="checkbox" name="includeNock" ${c.includeNock ? 'checked' : ''}> 矿池已登记 NOCK 地址时，把 NOCK 收益计入利润</label>` : ''}
    </div>
    ${h?.bad ? `<div class="rig-note bad">疑似故障：${esc(h.why)}，已持续 ${dur(h.badMin)}</div>` : ''}
    <div class="pool-foot">
      <span class="foot-meta">${p.configured ? pend : '<span class="dim">填写钱包后启用</span>'}</span>
      <div class="foot-actions">
        <button class="small-button go" onclick="savePool('${p.id}')">保存</button>
        ${p.configured && !p.isDefault ? `<button class="small-button" onclick="setDefaultPool('${p.id}')">设为默认</button>` : ''}
        ${p.configured ? `<button class="small-button" onclick="switchAll('${p.id}')">全部切到这里</button>` : ''}
        <a class="small-button link" href="${p.site}" target="_blank" rel="noopener">官网 ↗</a>
      </div>
    </div>
  </div>`;
}
function renderPools() {
  if (!S.pools) return;
  const box = $('#poolCards');
  const editing = box.contains(document.activeElement) || [...box.querySelectorAll('input')].some(i => i.dataset.dirty);
  if (!editing) {
    box.innerHTML = S.pools.map(poolCard).join('');
    box.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { i.dataset.dirty = '1'; }));
  }
  // 收益对比
  document.querySelectorAll('#cmpSeg button').forEach(b => b.classList.toggle('on', b.dataset.w === cmpWin));
  const cmp = S.compare?.[cmpWin] || {};
  const rows = S.pools.filter(p => cmp[p.id]);
  const from = Math.min(...rows.map(p => cmp[p.id].from));
  $('#cmpRange').textContent = rows.length ? `统计自 ${new Date(from).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
  const ranked = rows.filter(p => cmp[p.id].roi != null).sort((a, b) => cmp[b.id].roi - cmp[a.id].roi);
  const best = ranked.length >= 2 ? ranked[0] : null; // 两个池都有数据才比较
  $('#cmpTable tbody').innerHTML = rows.length ? rows.map(p => {
    const r = cmp[p.id];
    return `<tr class="${best && best.id === p.id && rows.length > 1 ? 'good' : ''}">
      <td>${p.name}${best && best.id === p.id && rows.length > 1 ? '<span class="tag real">收益率最高</span>' : ''}</td>
      <td class="r">${num(r.prl, 3)}</td><td class="r">${p.nock ? num(r.nock, 2) : '—'}</td>
      <td class="r">${usd(r.usd, 2)}</td><td class="r">${usd(r.spend, 2)}</td>
      <td class="r ${r.profit >= 0 ? 'up' : 'down'}">${usd(r.profit, 2)}</td>
      <td class="r ${clsRoi(r.roi)}">${pct(r.roi)}</td>
      <td class="r">${usd(r.theo, 2)}</td><td class="r">${num(r.rigHours, 1)} h</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="dim" style="text-align:center;padding:26px;font-family:var(--sans);font-weight:400">还没有数据：程序运行一段时间后开始统计</td></tr>';
  // 故障切换
  const c = S.config;
  if (document.activeElement !== $('#foMin')) $('#foMin').value = c.failoverMinutes;
  $('#swFailover').checked = c.failover;
  const nConf = S.pools.filter(p => p.configured).length;
  $('#foNote').innerHTML = nConf < 2 ? '两个矿池都填了钱包才能自动切换。'
    : `开启后：某个矿池的接口连不上、或在那里挖的机器（≥3 台）六成以上同时没算力，持续 <b>${c.failoverMinutes} 分钟</b> → 把能切换的机器转到另一个矿池；原矿池恢复稳定 <b>15 分钟</b>后自动切回（6 小时内反复故障时等待时间翻倍，最多 4 小时）。只对新版脚本租的机器有效。`;
  $('#foList').innerHTML = (S.failovers || []).map(f => `<div class="log-row"><time>${new Date(f.t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span class="warn">${pn(f.from)} → ${pn(f.to)}：${f.n} 台（${esc(f.why)}）</span></div>`).join('') || '<div class="dim" style="padding:4px 0 6px;font-size:12px">还没有发生过自动切换</div>';
}
document.querySelectorAll('#cmpSeg button').forEach(b => b.addEventListener('click', () => { cmpWin = b.dataset.w; try { localStorage.setItem('prl-cmp', cmpWin); } catch {} renderPools(); }));
$('#swFailover').addEventListener('change', async e => {
  try { await api('/api/settings', { failover: e.target.checked }); toast(`矿池故障自动切换已${e.target.checked ? '开启' : '关闭'}`); } catch (x) { toast(x.message, true); }
  refresh();
});
$('#foMin').addEventListener('change', async e => {
  try { await api('/api/settings', { failoverMinutes: e.target.value }); toast('已保存'); } catch (x) { toast(x.message, true); }
  refresh();
});
window.savePool = async id => {
  const card = document.querySelector(`.pool-card[data-pool="${id}"]`);
  const data = {};
  card.querySelectorAll('input').forEach(i => { data[i.name] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  try {
    await api('/api/settings', data);
    card.querySelectorAll('input').forEach(i => delete i.dataset.dirty);
    document.activeElement?.blur();
    toast(`${pn(id)} 设置已保存${data.wallet === '' || data.kryptexWallet === '' ? '（钱包已清空，这个矿池停用）' : ''}`);
  } catch (e) { toast(e.message, true); }
  refresh();
};
window.setDefaultPool = async id => {
  const p = S.pools.find(x => x.id === id);
  const ok = await confirmBox('设为默认矿池', `之后新租的机器会先挖 <b>${pn(id)}</b>，市场收益率也按它计算（手续费 ${num(p.fee * 100, 0)}%${p.minerFee ? ` + ${p.miner} 开发费 ${num(p.minerFee * 100, 0)}%` : ''}${p.nock ? '，含 NOCK' : '，没有 NOCK'}）。<br>已经在挖的机器不变，需要的话可以点「全部切到这里」。`);
  if (!ok) return;
  try { await api('/api/settings', { defaultPool: id }); toast(`默认矿池改为 ${pn(id)}`); } catch (e) { toast(e.message, true); }
  refresh();
};
window.switchPool = async (id, to) => {
  const x = S.instances.find(i => i.id === id);
  if (!x) return;
  const ok = await confirmBox('切换矿池', `把 <b>#${id}</b>（${x.numGpus}× ${esc(x.gpuName)}）从 <b>${pn(x.wantPool)}</b> 切到 <b>${pn(to)}</b>？<br>机器 1 分钟内读到指令后重连新矿池，中断挖矿约 1~2 分钟，不用重启、不多扣费。${to === 'kryptex' ? '<br><span class="dim">Kryptex 只有 30 分钟平均算力，刚切过去的半小时里面板上的算力会偏低，期间不判断算力异常和止损。</span>' : ''}`);
  if (!ok) return;
  try { await api(`/api/instances/${id}/pool`, { pool: to }); toast(`已发送切换指令 #${id} → ${pn(to)}`); } catch (e) { toast('切换失败：' + e.message, true); }
  refresh();
};
window.switchAll = async to => {
  const can = S.instances.filter(x => x.wantPool !== to && (x.switchable || []).includes(to));
  const cannot = S.instances.filter(x => x.wantPool !== to && !(x.switchable || []).includes(to));
  if (!can.length) { toast(cannot.length ? `有 ${cannot.length} 台不在 ${pn(to)}，但它们不支持切换（旧版脚本或租的时候没填这个矿池的钱包）` : `所有机器都已经在挖 ${pn(to)}`, !!cannot.length); return; }
  const ok = await confirmBox('全部切换', `把 <b>${can.length}</b> 台机器切到 <b>${pn(to)}</b>？每台中断约 1~2 分钟。${cannot.length ? `<br><span class="dim">另有 ${cannot.length} 台不支持切换，会保持不变。</span>` : ''}`);
  if (!ok) return;
  try { const r = await api('/api/pools/switch-all', { to }); toast(`已发送 ${r.switched} 台的切换指令`); } catch (e) { toast(e.message, true); }
  refresh();
};

function renderOffers() {
  const only = $('#onlyGood').checked;
  const t = S.config.targetProfitPct;
  const st = S.offerStats;
  const u = st.usage || {}, q = st.quota;
  const quotaTxt = q && q.remaining != null ? `剩余 ${q.remaining}${q.limit ? ' / ' + q.limit : ''} 条` : st.quotaEst ? `估计每日额度约 ${st.quotaEst} 条` : '';
  const nextTxt = st.pausedUntil ? (st.pauseReason === 'quota' ? `今日额度已用完，${new Date(st.pausedUntil).toLocaleString('zh-CN', { hour12: false })} 恢复` : '请求太频繁，稍后重试')
    : st.nextScanAt == null && st.plan ? st.plan
    : st.nextScanAt ? `下次扫描 ${new Date(st.nextScanAt).toLocaleTimeString('zh-CN', { hour12: false })}${st.plan ? '（' + st.plan + '）' : ''}` : '';
  $('#scanInfo').textContent = [
    st.scannedAt ? `上次 ${ago(st.scannedAt)}${st.mode ? ' · ' + st.mode : ''} · ${st.total} 台 · 已知型号 ${st.known}` : (S.config.hasApiKey ? '等待首次扫描…' : '填写 API Key 后开始扫描'),
    `今日已搜 ${u.requests || 0} 次 / ${u.rows || 0} 条${quotaTxt ? ' · ' + quotaTxt : ''}`,
    nextTxt,
  ].filter(Boolean).join('　·　');
  const rows = S.offers.filter(o => !only || o.roi >= t);
  $('#offerCount').textContent = st.scannedAt ? `${st.profitable} 台达标` : '';
  const tb = $('#offers tbody');
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="9" class="dim" style="text-align:center;padding:30px;font-family:var(--sans);font-weight:400">${st.scannedAt ? (only ? `当前没有收益率 ≥ ${t}% 的机器，取消「只看达标」可查看全部` : '没有可用的机器') : '—'}</td></tr>`; return; }
  tb.innerHTML = rows.map(o => `<tr class="${o.roi >= t ? 'good' : ''} ${o.blacklisted ? 'dim' : ''}">
    <td>${o.numGpus}× ${esc(o.gpuName)}${o.source === '实测' ? '<span class="tag real">实测</span>' : o.source === '估算' ? '<span class="tag est">估算</span>' : ''}${o.blacklisted ? `<span class="tag bl">${esc(o.blacklisted)}</span>` : ''}</td>
    <td class="r">${num(o.th, 0)} TH</td>
    <td class="r">${usd(o.dph, 3)}</td>
    <td class="r">${usd(o.revenueHr, 3)}</td>
    <td><div class="roi-cell"><span class="${clsRoi(o.roi)}">${pct(o.roi)}</span>${roiBar(o.roi)}</div></td>
    <td class="r">${num(o.thPer01, 0)}</td>
    <td class="r">${o.reliability != null ? (o.reliability * 100).toFixed(1) + '%' : '—'}</td>
    <td>${flag(o.geolocation)}</td>
    <td class="r"><button class="small-button go" onclick="rent(${o.id})">租用</button></td>
  </tr>`).join('');
}

function renderTable() {
  const per = S.market.usdPerThDay / 24;
  const k = 1 + S.config.targetProfitPct / 100;
  $('#hashTable tbody').innerHTML = S.table.map(g => `<tr>
    <td>${esc(g.name)}</td>
    <td class="r">${num(g.effective, 1)}</td>
    <td>${g.source === '实测' ? `<span class="tag real" style="margin:0">实测 ×${g.measuredSamples}</span>` : g.source === '估算' ? '<span class="tag est" style="margin:0" title="估算值不会被自动租用，可手动租一台拿实测">估算</span>' : '<span class="tag" style="margin:0">参考</span>'}</td>
    <td class="r">${per ? usd(g.effective * per, 3) : '—'}</td>
    <td class="r up">${per ? usd(g.effective * per / k, 3) : '—'}</td>
  </tr>`).join('');
}

function renderLog() {
  $('#log').innerHTML = S.events.map(e => `<div class="log-row"><time>${new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })}</time><span class="${e.level}">${esc(e.msg)}</span></div>`).join('') || '<div class="dim" style="padding:20px">暂无</div>';
}

// ---------- 交互 ----------
async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function toast(msg, err = false) {
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' error' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 4500);
}
function confirmBox(title, html) {
  return new Promise(ok => {
    $('#cfTitle').textContent = title;
    $('#cfBody').innerHTML = html;
    $('#confirm').hidden = false;
    const done = v => { $('#confirm').hidden = true; $('#cfYes').onclick = $('#cfNo').onclick = null; ok(v); };
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
  });
}

async function refresh() {
  try { S = await api('/api/state'); if (!settingsOpen) render(); }
  catch (e) {
    $('#conn-card').className = 'connection-card offline';
    $('#conn-title').textContent = '与本地程序断开';
    $('#conn-sub').textContent = '黑色命令行窗口是否被关掉了？';
  }
}

async function toggle(key, val) {
  try { await api('/api/settings', { [key]: val }); toast(`${key === 'autoRent' ? '自动租用' : '自动退租'}已${val ? '开启' : '关闭'}`); }
  catch (e) { toast(e.message, true); }
  refresh();
}
$('#swRent').addEventListener('change', async e => {
  const v = e.target.checked;
  if (v) {
    const ok = await confirmBox('开启自动租用', `程序会自动租下收益率 ≥ <b>${S.config.targetProfitPct}%</b> 的机器并部署挖矿，最多 <b>${S.config.maxInstances}</b> 台、每小时最多花 <b>${usd(S.config.maxHourlySpend)}</b>。<br>会真实扣除 vast 余额，确定开启？`);
    if (!ok) { e.target.checked = false; return; }
  }
  toggle('autoRent', v);
});
$('#swDestroy').addEventListener('change', e => toggle('autoDestroy', e.target.checked));
$('#onlyGood').addEventListener('change', () => S && renderOffers());
$('#btnScan').addEventListener('click', async () => {
  $('#btnScan').disabled = true;
  try { await api('/api/scan', {}); toast('扫描完成'); } catch (e) { toast(e.message, true); }
  $('#btnScan').disabled = false; refresh();
});

window.rent = async id => {
  const o = S.offers.find(x => x.id === id);
  if (!o) return;
  const ok = await confirmBox('手动租用', `${o.numGpus}× ${esc(o.gpuName)}（${flag(o.geolocation)}）<br>时租 <b>${usd(o.dph, 3)}</b> · 预计收益率 <b>${pct(o.roi)}</b><br>租下后会自动部署挖矿，确定？`);
  if (!ok) return;
  try { const r = await api('/api/rent/' + id, {}); toast('租用成功，实例 ' + r.id + '，正在部署'); } catch (e) { toast('租用失败：' + e.message, true); }
  refresh();
};
window.destroyInst = async (id, name, dph) => {
  const ok = await confirmBox('退租', `确定销毁实例 <b>#${id}</b>（${esc(name)}，${usd(dph, 3)}/h）？<br>销毁后立即停止计费，机器上的数据会清空。`);
  if (!ok) return;
  try { await api(`/api/instances/${id}/destroy`, {}); toast('已退租 #' + id); } catch (e) { toast('退租失败：' + e.message, true); }
  refresh();
};
window.showLogs = async (id, name) => {
  $('#logTitle').textContent = `机器日志 · #${id} ${name}`;
  $('#logBody').textContent = '正在从 vast 读取日志…（需要几秒）';
  $('#logHint').textContent = '';
  $('#logModal').hidden = false;
  try {
    const r = await api(`/api/instances/${id}/logs`);
    const lines = (r.text || '').split(/\r?\n/);
    $('#logBody').textContent = lines.slice(-200).join('\n') || '（日志为空：机器可能还在拉镜像，或开机脚本还没开始执行）';
    $('#logHint').textContent = r.hint ? '关键信息：' + r.hint : '';
    $('#logBody').scrollTop = 1e9;
  } catch (e) { $('#logBody').textContent = '读取失败：' + e.message; }
};
document.querySelectorAll('[data-close-log]').forEach(b => b.addEventListener('click', () => { $('#logModal').hidden = true; }));

window.rebootInst = async id => {
  const x = S.instances.find(i => i.id === id);
  if (!x) return;
  const warnManual = !x.managed
    ? `<br><br><span style="color:var(--amber)">⚠ 这台是你<b>手动</b>部署的，不是本程序租的。重启后机器里手动运行的矿工（比如 tmux 里跑的）会被关掉，<b>不会自动重新开挖</b>，需要你进 Jupyter 重新运行挖矿命令。</span>`
    : '<br>重启后开机脚本会自动重新拉起矿工，通常 1~3 分钟恢复算力，期间不会被自动退租。';
  const ok = await confirmBox('重启机器', `重启实例 <b>#${id}</b>（${x.numGpus}× ${esc(x.gpuName)}）${x.healthMsg ? `<br>原因：${esc(x.healthMsg)}` : ''}<br>重启只是关机再开机，磁盘数据保留，不会多扣费。${warnManual}`);
  if (!ok) return;
  try { await api(`/api/instances/${id}/reboot`, {}); toast('已发送重启指令 #' + id); } catch (e) { toast('重启失败：' + e.message, true); }
  refresh();
};
window.setAlias = async (id, cur) => {
  const v = prompt('这台机器在矿池里的矿工名（Worker name）。\n本程序租的机器是 v+实例号，不用改；手动租的机器填你启动时用的名字（比如 5080）：', cur);
  if (v === null) return;
  try { await api(`/api/instances/${id}/alias`, { worker: v }); toast('已绑定，约 1 分钟后显示实测算力'); } catch (e) { toast(e.message, true); }
  refresh();
};

// 设置
window.openSettings = () => {
  const f = $('#settingsForm'), c = S.config;
  for (const el of f.elements) {
    if (!el.name || c[el.name] === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!c[el.name]; else el.value = c[el.name];
  }
  $('#settingsErr').textContent = '';
  $('#settings').hidden = false; settingsOpen = true;
};
$('#btnSettings').addEventListener('click', () => S && openSettings());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $('#settings').hidden = true; settingsOpen = false; render(); }));
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const data = {};
  for (const el of e.target.elements) if (el.name) data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  try {
    const r = await api('/api/settings', data);
    $('#settings').hidden = true; settingsOpen = false;
    toast(r.restartNeeded ? '已保存。代理设置需要关闭程序窗口后重新启动才生效' : '设置已保存');
    refresh();
  } catch (err) { $('#settingsErr').textContent = err.message; }
});

refresh();
setInterval(refresh, 5000);
