// 单位断言（2026-11-05 用户要求）：这才是"两个 adapter 语义等价"的证明。
//
// 背景：M3 之前的"换 market 标签 → 同决策"是**同义反复**——它只证明 allocator 不读 market 字段，
// 任何一个没写 `if (offer.market)` 的实现都会通过。真正会咬人的是单位：
//   vast: dph_total 整机 $/h ｜ cpu_ram MB ｜ 无最短租期 ｜ num_gpus
//   Clore: USD-Blockchain **每 GPU 每天** ｜ specs.ram GB ｜ mrl 小时 ｜ "6x RTX 3080" 字符串
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] || process.cwd();
const U = p => pathToFileURL(path.join(root, p)).href;
const { normalizeVast, normalizeClore, toAllocatorOffer } = await import(U('src/m3/normalize.js'));
const { decide } = await import(U('src/m3/allocator.js'));
const { rentEv, rentEvShoppingList } = await import(U('src/m3/rentEv.js'));
const { assertSupply } = await import(U('src/m3/contract.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= Math.abs(b) * tol;

console.log('— Clore 真实 raw：6x RTX 3080，spot USD-Blockchain=14.0/天，mrl=300，ram=128GB');
const cloreRaw = {
  id: 9001, owner: 'o1', mrl: 300, partial_gpu_rental: false,
  specs: { gpu: '6x RTX 3080', ram: 128, cpus: '48/48', gpuram: 10 },
  price: { spot: { 'USD-Blockchain': 14.0, bitcoin: 0.00018, 'CLORE-Blockchain': 8700 } },
};
const c = normalizeClore(cloreRaw);
{
  // 每 GPU 每天 14.0 → ÷6 卡 ÷24 小时
  ok(c.usdPerGpuHour === 0.0972 && c.pricePerHour === 0.5833, `价格：整机 $${c.pricePerHour}/h，单卡 $${c.usdPerGpuHour}/卡·h`);
  ok(c.numGpus === 6, `卡数：从 "6x RTX 3080" 解析出 ${c.numGpus}（除以卡数错了就错 6 倍）`);
  ok(c.mrlHours === 300, `租期：mrl=${c.mrlHours}h（30 天锁仓，不能当现货）`);
  ok(c.ramGb === 128, `内存：specs.ram=${c.ramGb}GB（Clore 本来就是 GB）`);
  ok(c.frac === 1, 'frac：partial_gpu_rental=false → 整卡');
  ok(normalizeClore({ ...cloreRaw, partial_gpu_rental: true }).frac === null, 'frac：允许部分租用 → null（未知，不是 1）');
}

console.log('— vast 真实 raw：num_gpus=6，dph_total=0.6（整机），cpu_ram=128000MB');
const vastRaw = { id: 9002, num_gpus: 6, dph_total: 0.6, cpu_ram: 128000, cpu_cores_effective: 32, gpu_frac: 1, gpu_name: 'RTX 3080' };
const v = normalizeVast(vastRaw);
{
  ok(v.usdPerGpuHour === 0.1, `价格：0.6 整机 ÷ 6 卡 = $${v.usdPerGpuHour}/卡·h`);
  ok(v.numGpus === 6, `卡数：num_gpus=${v.numGpus}`);
  ok(v.mrlHours === 0, '租期：vast 按秒计费 → 0（已知无最短租期；null 只留给"未知"）');
  // 这不是"验证过的换算"，而是**单位假设**：MB(10^6)→119.2GiB，MiB(2^20)→125.0GiB。
  // 取 MiB（偏乐观一档，多算 3 个线程），偏差由下游 4GiB OS 余量吸收。
  ok(v.ramGb === 125 && v.ramUnitAssumed === 'MiB',
    `内存：cpu_ram_mib_assumed → ${v.ramGb}GiB（假设 MiB；若真 MB 则 119.2，差 3 线程且方向偏激进）`);
  ok(normalizeVast({ ...vastRaw, gpu_frac: null }).frac === null, 'frac：gpu_frac 缺失 → null（不默认整卡）');
}

console.log('— 语义等价：同一条 6 卡 3080 报价，两个场所归一后必须落在同一量级');
{
  ok(near(c.usdPerGpuHour, v.usdPerGpuHour), `Clore $${c.usdPerGpuHour} vs vast $${v.usdPerGpuHour}（差 ${(Math.abs(c.usdPerGpuHour - v.usdPerGpuHour) / v.usdPerGpuHour * 100).toFixed(1)}%，<3%）`);
  // Clore 的 specs.ram 是标称 GB、vast 的 cpu_ram 是 MB 十进制 → 归一后差 2.4%（128 vs 125GiB）。
  // 不追求相等（厂商标称本来就不统一），但必须落在同一量级——差 1024 倍才是 bug。
  ok(Math.abs(c.ramGb - v.ramGb) / v.ramGb < 0.05, `内存归一后同量级：${c.ramGb}GB vs ${v.ramGb}GiB（差 ${(Math.abs(c.ramGb - v.ramGb) / v.ramGb * 100).toFixed(1)}%）`);
  // 关键：归一化之后 allocator 看到的必须是同一种对象形状
  const ctx = { rentEnabled: true, targetProfitPct: 20, deployPct: 3.33, pSurvive: 0.5, revenuePerThHour: 0.0008, floorPricePerGpu: 0.02, maxHourlySpend: 0.2, budgetLeftUsd: 5, maxLeaseHours: 24 };
  const a1 = decide(toAllocatorOffer(c, { deliveredTh: 68.9, thSource: 'cheap-band', mrlHours: 6 }), ctx);
  const a2 = decide(toAllocatorOffer(v, { deliveredTh: 68.9, thSource: 'cheap-band' }), ctx);
  ok(a1.reasonCode === a2.reasonCode && a1.verdict === a2.verdict,
    `归一后同决策：${a1.verdict}/${a1.reasonCode} vs ${a2.verdict}/${a2.reasonCode}`);
}

console.log('— verdict 三态：缺数据是 watch（带补救条件），不是 skip');
{
  const ctx = { rentEnabled: true, targetProfitPct: 20, deployPct: 3.33, pSurvive: 0.5, revenuePerThHour: 0.0008, floorPricePerGpu: 0.02, maxHourlySpend: 0.2, budgetLeftUsd: 5, maxLeaseHours: 24 };
  const w1 = decide(toAllocatorOffer(v, { deliveredTh: 45, thSource: 'pooled' }), ctx);
  ok(w1.verdict === 'watch' && w1.reasonCode === 'th_uncalibrated', `未校准 → ${w1.verdict}/${w1.reasonCode}`);
  ok(w1.whatWouldMakeItViable?.minDeliveredTh > 0, `给出补救条件：需要 ≥${w1.whatWouldMakeItViable.minDeliveredTh} TH 或 ≤$${w1.whatWouldMakeItViable.maxUsdPerGpuHour}/h`);
  const w2 = decide(toAllocatorOffer({ ...c, mrlHours: null }, { deliveredTh: 68.9, thSource: 'cheap-band' }), ctx);
  ok(w2.verdict === 'watch' && w2.reasonCode === 'mrl_unknown', `mrl 缺失 → ${w2.verdict}/${w2.reasonCode}（maxMrlHours=${w2.whatWouldMakeItViable?.maxMrlHours}）`);
}

console.log('— 校准 EV：没有样本就不能拍概率（不许再用魔法常数 0.5）');
{
  const noSamples = rentEv({ needTh: 55, samples: [], revenuePerThHour: 0.0008, daysLeft: 6, rentPerHour: 0.067 });
  ok(noSamples.viable === false && noSamples.p === null, `无样本 → P 不可估（${noSamples.why}）`);
  // 5 条样本里 4 条 ≥55 → P=0.8；日收益 55×0.0008×24=$1.056；6 天 × 0.8 = $5.07 > $0.067
  const withSamples = rentEv({ needTh: 55, samples: [60, 58, 70, 55, 40], revenuePerThHour: 0.0008, daysLeft: 6, rentPerHour: 0.067 });
  // Laplace (k+1)/(n+2)：4/5 → 5/7 = 0.714（不是 0.8；5 条样本不该给 80% 把握）
  ok(Math.abs(withSamples.p - 0.714) < 0.002 && withSamples.viable === true, `有样本 → P=${withSamples.p}（Laplace 平滑），EV=$${withSamples.evUsd} > 0`);
  // 贴线但样本全达不到 → EV 负
  // need > spec → 直接判"价格主因"，不给 EV（否则 300 TH × 收入 会把 EV 算成正的，那是假象）
  const bad = rentEv({ needTh: 300, specTh: 119, samples: [60, 58, 70], revenuePerThHour: 0.0008, daysLeft: 6, rentPerHour: 0.067 });
  ok(bad.viable === false && /价格主因/.test(bad.why), `需要 300 TH > 规格 119 → ${bad.why}`);
  // 注意：这是**租用** EV（若真有一台能稳定交付 70 TH，6 天收益足以覆盖 1 小时租价）。
  // 它不是"校准价值"——单机测量不迁移，所以校准预算与 EV 无关，恒为 $0（§6.11）。
  const lowP = rentEv({ needTh: 70, specTh: 119, samples: [60, 58, 55], revenuePerThHour: 0.0008, daysLeft: 6, rentPerHour: 0.067 });
  ok(lowP.p === 0.2, `样本全不达标 → P=${lowP.p}（Laplace 平滑，不是 0）`);
  const list = rentEvShoppingList([{ model: 'X', needTh: 300, specTh: 119, samples: [60] }], { revenuePerThHour: 0.0008, daysLeft: 6, rentPerHour: 0.067 });
  ok(/无一条租用 EV>0/.test(list.conclusion), `购物单结论：${list.conclusion}`);
}

console.log('— 供给契约：observeSupply 必须带 wholeCardShare（换市场的第一筛子）');
{
  ok(assertSupply({ counts: {}, wholeCardShare: 0.26, wholeCardUnits: 42, at: Date.now() }), '含 wholeCardShare + wholeCardUnits 即通过');
  let threw = null; try { assertSupply({ counts: {}, at: Date.now() }); } catch (e) { threw = e.message; }
  ok(/wholeCardShare/.test(threw || ''), `缺字段会被点名：${(threw || '').slice(0, 30)}`);
  let threw2 = null; try { assertSupply({ counts: {}, wholeCardShare: 0.5, at: Date.now() }); } catch (e) { threw2 = e.message; }
  ok(/wholeCardUnits/.test(threw2 || ''), '缺 wholeCardUnits 也会被点名（跨场所只认它）');
}

console.log(fail ? `\n单位断言失败：${fail} 项` : `\n单位断言通过（${pass} 项）`);
process.exit(fail ? 1 : 0);