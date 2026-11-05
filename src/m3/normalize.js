// 场所原始报价 → 归一化 Offer（M3）
//
// 这一层才是真正会咬人的地方（用户 2026-11-05）：同一件事在两个场所的单位完全不同，
// 而我们刚刚亲口踩过一次——Clore 的 USD-Blockchain 是**每 GPU 每天**，vast 的 dph_total 是
// **整机每小时**；cpu_ram 是 MB 十进制，Clore 的 specs.ram 是 GB；租期只有 Clore 有。
// 所以每个 adapter 必须带单位断言（见 test/units-test.mjs），而不是靠"换个 label 决策不变"。
import { modelKey } from '../clore.js';

/** vast：dph_total = 整机 $/h；cpu_ram = MB；gpu_frac 可能缺失（缺失即未知，不默认整卡） */
export function normalizeVast(raw) {
  const nGpu = Math.max(1, Number(raw?.num_gpus) || 1);
  const dph = Number(raw?.dph_total);
  return {
    id: raw?.id ?? null,
    market: 'vast',
    gpu: raw?.gpu_name || '',
    numGpus: nGpu,
    frac: raw?.gpu_frac == null ? null : Number(raw.gpu_frac),
    // 规范字段：pricePerHour = **整机** $/h（allocator 自己除以卡数）；usdPerGpuHour 只作展示。
    // 这个歧义（整机价 vs 单卡价）在 PRL 里就咬过一次，M3 只留一个口径。
    pricePerHour: Number.isFinite(dph) ? +dph.toFixed(4) : null,
    usdPerGpuHour: Number.isFinite(dph) ? +(dph / nGpu).toFixed(4) : null,
    // vast 按秒计费 → 最短租期是 **0（已知无限制）**，不是 null（未知）。
    // 这两者必须分开：0 = 现货，null = 不知道是不是长约。
    mrlHours: 0,
    // ⚠ 单位假设（2026-11-05 用户要求写成假设，不写成"断言通过"）：
    // vast 的 cpu_ram 官方文档未确认单位。若它是 MB(10^6) → 128000 = 119.2 GiB；
    // 若是 MiB(2^20) → 125.0 GiB。这里取 **MiB**，即偏乐观一档（多算 3 个线程）。
    // 之所以暂不修正：下游 RAM 门控还扣了 4GiB OS 余量，能吸收这 5% 的偏差。
    ramGb: raw?.cpu_ram == null ? null : +(Number(raw.cpu_ram) / 1024).toFixed(1),
    ramUnitAssumed: raw?.cpu_ram == null ? null : 'MiB',
    cpuCores: raw?.cpu_cores_effective == null ? null : Number(raw.cpu_cores_effective),
    reliability: raw?.reliability2 ?? raw?.reliability ?? null,
    hostId: raw?.host_id ?? null,
  };
}

/**
 * Clore：specs.gpu = "6x RTX 3080"；price.spot['USD-Blockchain'] = **每 GPU 每天**；
 * specs.ram = GB；mrl = 小时；partial_gpu_rental=false 表示只整机租（frac=1）。
 * @param {object} raw 房源
 * @param {object} [opts] { fx } —— 只有 USD-Blockchain 缺失时才需要汇率换算
 */
export function normalizeClore(raw, { fx = null } = {}) {
  const gpuStr = String(raw?.specs?.gpu || '');
  const m = /^\s*(\d+)\s*x\s*(.+)$/.exec(gpuStr);
  const nGpu = m ? Number(m[1]) : 1;
  const model = m ? m[2] : gpuStr;
  const spot = raw?.price?.spot || {};
  let perDay = Number(spot['USD-Blockchain']);
  if (!Number.isFinite(perDay) || perDay <= 0) {
    const btc = Number(spot.bitcoin);
    const clore = Number(spot['CLORE-Blockchain']);
    if (btc > 0 && fx?.btcUsd) perDay = btc * fx.btcUsd;
    else if (clore > 0 && fx?.cloreUsd) perDay = clore * fx.cloreUsd;
    else perDay = NaN;
  }
  const partial = raw?.partial_gpu_rental;
  return {
    id: raw?.id ?? null,
    market: 'clore',
    gpu: model,
    modelKey: modelKey(model),
    numGpus: nGpu,
    // 允许部分租用 → 我们拿到的不一定是整卡（frac 未知，不是 1）
    frac: partial === true || partial === 1 ? null : 1,
    pricePerHour: Number.isFinite(perDay) ? +(perDay / 24).toFixed(4) : null,   // 整机 $/h
    usdPerGpuHour: Number.isFinite(perDay) ? +(perDay / nGpu / 24).toFixed(4) : null,
    mrlHours: raw?.mrl == null ? null : Number(raw.mrl),
    ramGb: raw?.specs?.ram == null ? null : Number(raw.specs.ram),
    cpuCores: (() => { const c = String(raw?.specs?.cpus || ''); const n = parseInt(c, 10); return Number.isFinite(n) ? n : null; })(),
    reliability: raw?.reliability ?? null,
    hostId: raw?.owner ?? null,
  };
}

/** 归一化后统一改名为 allocator 用的字段（价格字段名一处定义，避免两处叫法） */
export function toAllocatorOffer(o, extra = {}) {
  return {
    id: o.id, market: o.market, gpu: o.gpu, numGpus: o.numGpus,
    frac: o.frac, pricePerHour: o.pricePerHour, mrlHours: o.mrlHours,
    ...extra,
  };
}