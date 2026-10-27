#!/usr/bin/env node
// 租约报表：按型号 / 按房东打印「每机时净收益」排名。
//
// 这是决策口径——不是 ROI 均值。一台机器只跑了 8 分钟就被顶掉，ROI 会是 null 或极端值，
// 但它的租金是实付的；只把它们摊进「每机时净收益」才不会让短命机器把排名拉歪。
//
// 用法：
//   node tools/lease-report.mjs             # 读 data/state.json
//   node tools/lease-report.mjs --json      # 机器可读
//   node tools/lease-report.mjs --host      # 只看房东维度
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from '../src/leases.js';

const DATA = path.resolve(process.cwd(), 'data');
const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return {}; } })();
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch { return {}; } })();

// 币价：优先用 state 里最后一根 history 的价（那是引擎自己的口径），没有就报 0 并提示
const price = Number([...(st.history || [])].reverse().find(h => Number(h.price) > 0)?.price) || 0;
const leases = st.leases || [];
const rep = summarize(leases, { priceUsd: price });
const json = process.argv.includes('--json');
const onlyHost = process.argv.includes('--host');

if (json) { console.log(JSON.stringify(rep, null, 2)); process.exit(0); }

const money = v => (v == null ? '—' : (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(4));
const pct = v => (v == null ? '—' : v.toFixed(0) + '%');

console.log(`租约台账：${rep.total.leases} 条（未结束 ${rep.total.open}），合计 ${rep.total.hours}h，净 ${money(rep.total.netUsd)}（币价 $${price || '缺失'}）`);
if (!price) console.log('⚠ state 里没有币价，净收益会显示为负的纯支出（先让引擎跑一轮行情）');

const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('  ' + ['型号/房东', '租约', '出算力', '中位存活', '机时', '每机时净收益', '对手价位'].join('  '));
  for (const r of rows) {
    console.log('  ' + [
      String(r.key).padEnd(14),
      String(r.leases).padStart(3),
      pct(r.hashedRate).padStart(5),
      (r.medianLifetimeMin == null ? '—' : r.medianLifetimeMin.toFixed(0) + 'min').padStart(8),
      r.hours.toFixed(1).padStart(5),
      money(r.netPerMachineHour).padStart(13),
      (r.medianOpponentRatio == null ? '—' : r.medianOpponentRatio.toFixed(2) + '×').padStart(8),
    ].join('  '));
  }
};

if (!onlyHost) table('按型号（每机时净收益 = (入账 PRL×币价 − 实付租金) ÷ 计费小时）', rep.byGpu);
if (!onlyHost) table('按房东（同一房东反复收回，比型号更强的信号）', rep.byHost.slice(0, 12));

const endReasons = leases.reduce((a, l) => { const k = l.endReason || '未结束'; a[k] = (a[k] || 0) + 1; return a; }, {});
console.log('\n结束原因分布：' + Object.entries(endReasons).map(([k, v]) => `${k}×${v}`).join('  '));

// 判据提示：样本不够就别下结论
const thin = rep.byGpu.filter(r => r.leases < 10).map(r => r.key);
if (thin.length) console.log(`⚠ 样本 <10 的型号：${thin.join('、')}（结论要等够样本；屏蔽名单别靠猜）`);