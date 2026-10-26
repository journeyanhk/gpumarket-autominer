// vast.ai REST API（按官方文档 docs.vast.ai 与官方 vast-cli 源码实现）
//   搜索:   POST   /api/v0/bundles/
//   租用:   PUT    /api/v0/asks/{offer_id}/
//   实例:   GET    /api/v0/instances/?owner=me
//   销毁:   DELETE /api/v0/instances/{id}/
//   余额:   GET    /api/v0/users/current   (字段 credit)
import { request } from './http.js';

const BASE = 'https://console.vast.ai/api/v0';

export class Vast {
  constructor(apiKey) { this.apiKey = apiKey; }
  get ok() { return !!this.apiKey; }
  h() { return { Authorization: `Bearer ${this.apiKey}` }; }

  async user() {
    return request(`${BASE}/users/current/`, { headers: this.h() });
  }

  async instances() {
    const r = await request(`${BASE}/instances/?owner=me`, { headers: this.h() });
    return r?.instances || [];
  }

  // 与官方 CLI search_offers 的默认过滤一致：verified / external=false / rentable / rented=false
  // vast 按「返回的条数」计每日搜索额度（UTC 0 点重置），所以只取每美元算力最高的前 N 条
  // names：只搜这些型号（vast 的 gpu_name 原样字符串），省掉不适合挖矿的卡占用的搜索条数
  // 竞价（bid）时按 min_bid 过滤：挂牌价常常是入场价的 3 倍，用挂牌价过滤会把能租的机器全滤掉
  async searchOffers(f, meta, names) {
    const maxPrice = Math.max(0.01, f.maxHourlySpend);
    const priceKey = f.useSpot && this.spotFilterOk !== false ? 'min_bid' : 'dph_total';
    const body = {
      verified: { eq: true },
      external: { eq: false },
      rentable: { eq: true },
      rented: { eq: false },
      reliability: { gte: f.minReliability },
      num_gpus: { gte: 1, lte: f.maxGpusPerMachine },
      [priceKey]: { lte: maxPrice }, // 单机时租不可能超过总预算
      cuda_max_good: { gte: f.minCuda },
      inet_down: { gte: f.minInetDown },
      order: [['flops_per_dphtotal', 'desc']],
      type: f.useSpot ? 'bid' : 'on-demand',
      limit: Math.max(20, Math.min(1000, f.scanRows || 100)),
      allocated_storage: f.disk,
      ...(names?.length ? { gpu_name: { in: names } } : {}),
    };
    try {
      const r = await request(`${BASE}/bundles/`, { method: 'POST', headers: this.h(), body, timeoutMs: 45000, meta });
      return r?.offers || [];
    } catch (e) {
      // 4xx（非 429）= vast 不接受这个过滤字段：退回按挂牌价过滤并记住，只多打这一次
      if (priceKey !== 'min_bid' || e.status === 429 || !(e.status >= 400 && e.status < 500)) throw e;
      this.spotFilterOk = false;
      console.error('vast 不接受 min_bid 过滤，竞价搜索退回按挂牌价过滤（会漏掉挂牌贵但入场价低的机器）');
      return this.searchOffers(f, meta, names);
    }
  }

  // 租用一个 offer 并部署。cancel_unavail=true：机器已被别人租走时直接失败，不会留下排队中的实例
  // mode 'args'：跳过 vast 的 SSH 初始化（apt 装 ssh/tmux 等，慢机器要好几分钟），容器直接用 bash 运行开机脚本
  // mode 'ssh'：原来的方式，能 SSH / Jupyter 登录，脚本作为 onstart 运行
  // price：竞价实例的出价（on-demand 时必须为 null）
  async rent(offerId, { image, disk, label, onstart, mode = 'ssh', price = null }) {
    const body = {
      client_id: 'me',
      image,
      env: {},
      price: price ?? null,
      disk,
      label,
      cancel_unavail: true,
      ...(mode === 'args'
        ? { runtype: 'args', onstart: 'bash', args: ['-c', onstart] } // 与官方 CLI `--onstart-cmd bash --args -c '...'` 相同
        : { runtype: 'ssh_proxy', onstart }),
    };
    return request(`${BASE}/asks/${offerId}/`, { method: 'PUT', headers: this.h(), body, timeoutMs: 60000 });
  }

  // 读取机器日志（官方 CLI `vastai logs`）：PUT request_logs 拿到结果地址，再轮询下载
  async logs(id, tail = 200) {
    const r = await request(`${BASE}/instances/request_logs/${id}/`, { method: 'PUT', headers: this.h(), body: { tail: String(tail) }, timeoutMs: 30000 });
    if (!r?.result_url) return typeof r === 'string' ? r : (r?.msg || '');
    for (let i = 0; i < 20; i++) {
      await new Promise(ok => setTimeout(ok, 600));
      try {
        const res = await fetch(r.result_url);
        if (res.status === 200) return await res.text();
      } catch {}
    }
    throw new Error('日志还没准备好，稍后再试');
  }

  // 重启容器（与官方 CLI reboot instance 相同）：停止再启动，磁盘数据保留，开机脚本重新执行
  async reboot(id) {
    return request(`${BASE}/instances/reboot/${id}/`, { method: 'PUT', headers: this.h(), body: {}, timeoutMs: 30000 });
  }

  // 改实例标签（官方 CLI `label instance`）。机器上的挖矿脚本每分钟读一次标签里的 pool=xxx
  async setLabel(id, label) {
    const r = await request(`${BASE}/instances/${id}/`, { method: 'PUT', headers: this.h(), body: { label }, timeoutMs: 30000 });
    if (r && r.success === false) throw new Error(r.msg || r.error || '修改标签失败');
    return r;
  }

  async destroy(id) {
    return request(`${BASE}/instances/${id}/`, { method: 'DELETE', headers: this.h(), body: {}, timeoutMs: 30000 });
  }
}
