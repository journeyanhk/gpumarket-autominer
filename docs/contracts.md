# 契约（contracts）

> 这份文档先于代码存在：M3 的抽象必须按这里写下的语义落地。任何与此冲突的实现都算 bug。
> 变更契约要先改这里，再改代码，并在 PR 描述里说明为什么。

## 0. 单位与术语

| 术语 | 单位 | 约定 |
|---|---|---|
| 算力 | **H/s**（内部一律） | 只在展示层转 TH/s（`1 TH = 1e12 H`）。禁止在决策链路里出现 TH |
| 金额 | **USD**（浮点） | 只做展示与汇总；账本累计用币数量，换汇只在读取时做 |
| 币数量 | 币的原生小数（PRL 8 位、NOCK 原生） | 账本以币计量，避免把币价波动混进 `realizedFactor` |
| 时间 | 毫秒时间戳 | 窗口参数用分钟表示 |
| 收益密度 | USD / (H·s) | 单一真值源：`usdPerHsHour()` |

`Revenue(rig) = hashrate(H/s) × usdPerHsHour(coin, pool)`

## 1. 四个接口（M3 落地）

```ts
interface Market {
  id: string;                       // 'vast' | 'clore'
  capabilities: {
    spot: boolean;                  // 支持竞价/可抢占实例
    hotSwitch: boolean;             // 不重启机器就能换矿池
    perGpuStats: boolean;           // 平台能给逐卡数据（多数不能）
    miningAllowed: boolean;         // 见 §7：必须人工确认后才为 true
    bandwidthBilled: boolean;       // 按 GB 收取出网费用
  };
  search(filter): Promise<Offer[]>; // Offer 必须带 minBid（竞价）与 dphTotal（挂牌）
  rent(offer, plan: MinerPlan): Promise<InstanceRef>;
  list(): Promise<Instance[]>;      // 已含平台状态归一（running/stopped/preempted/...）
  destroy(id): Promise<void>;
  logs(id, tail): Promise<string>;
}

interface Offer {
  marketId: string; offerId: string; machineId: string;
  gpuName: string; numGpus: number;
  dphTotal: number;                 // 挂牌总价 $/h（含存储与带宽）
  minBid?: number;                  // 竞价入场价 $/h
  reliability: number; inetDownCost?: number;
}

interface Coin {
  id: string;                       // 'prl'
  price(): Promise<{ usd: number; at: number; src: string }>;
  chain(): Promise<{ networkHs: number; blockTime: number; reward: number; at: number }>;
  hashrate: Record<string, number>; // gpuKey -> 单卡 H/s（含实测校准后的值）
  payoutAddressValid(a: string): boolean;
}

interface Pool {
  id: string; coin: string;
  fee: number;                      // 池费（0.01 = 1%）
  minerFee: number;                 // 矿工开发费
  payoutModel: 'pplns' | 'pps+';
  perGpuStats: boolean;             // 是否提供逐卡算力
  miner: MinerSpec;                 // 命令行模板 + 币种专用参数
  account(wallet): Promise<PoolAccount>;
}

interface MinerSpec {
  bin: 'wr' | 'srb';                // 只有清单里 pin 过的二进制可用（§6）
  args(ctx): string[];              // 纯函数，便于快照测试
}
```

`Offer` 与 `Instance` 的所有金额字段都是"**有效成本**"的原料，不是决策依据本身：

```
effectiveCost(offer) = (dphTotal + expectedBandwidthUsd) / P(deployOk) + expectedWasteHours × dphTotal
```

`P(deployOk)` 与 `expectedWasteHours` 来自 `deployStats`（已有字段：total/pull/miner 用时）。
**按挂牌价排序是错的**：便宜但 30% 部署失败的机器，有效成本比它贵 40% 的邻居更高。

## 2. MinerPlan 与控制通道

控制端（桌面程序）在 NAT 后，因此**不做入站连接**。机器每 60s 拉一份只读计划：

```json
{
  "v": 3,
  "instanceId": 12345,
  "exp": 1750000000,
  "nonce": "b64",
  "pool": "pearlhash",
  "pools": { "pearlhash": { "bin": "wr", "args": ["--algo", "pearlhash", "..."] } },
  "sig": "ed25519(b64)"
}
```

规则（全部是硬要求）：
1. **签名**：Ed25519，公钥内置在镜像/脚本里；验签失败一律继续用上一份有效计划。
2. **版本防回滚**：`v` 单调递增；收到比当前小的 `v` 直接忽略（防重放旧计划把机器切回坏矿池）。
3. **过期**：`exp` 之后不再信任，回落到上次有效计划并告警；无有效计划则挖默认矿池。
4. **幂等**：同一份计划重复下发不产生动作。
5. 拉取失败**不等于**切换；连续失败 ≥ 3 次只在日志里告警。

vast 的"读自己的 label"是**一个**实现（`capabilities.hotSwitch=true`），不是通用机制；Clore 没有等价物，必须走上面的通道。

## 3. realizedFactor（实测折损系数）

```
realizedFactor(pool, coin) = Δ实际到账(币) / Δ理论应得(币)     // 同一窗口，币计量
```

- **只算成熟窗口**：Pearlhash pending ≈ 1h → 窗口 ≥ 2h；Kryptex 未确认 ≈ 24h → 窗口 ≥ 24h。用未成熟数据会系统性低估（到账还没结算），把盈利机器判成亏损。
- **PPS+ 与 PPLNS 不能混**：PPLNS 的窗口内方差与"运气"同量级（Pearlhash 占全网 17% 时，24h 约 ±10%），所以**判定 gate 必须用 PPS+ 池**（Kryptex）测；PPLNS 池只用于测 NOCK 加成与长期趋势。
- **最小样本**：≥ 24h 且有算力的机器 ≥ 1 台；样本不足返回 `null`，不要返回 0.9 之类的假值。
- **第一阶段不接止损**：只用于展示与决策加权；直接接止损会因为窗口滞后造成"亏了才退租"。

## 4. 分配器（allocator）

纯函数，禁止读时钟/随机数/网络：

```ts
allocate({
  offers,          // 已归一，含 effectiveCost
  budget: { maxInstances, maxHourlySpend, balance, reserve, runwayHours },
  targetRoiPct, realizedFactor, difficultyTrendPctPerDay,
  now,
}) -> { rent: Offer[], skip: {offerId, why}[] }
```

- 同一输入必须得到同一输出（回测可复现）。
- 目标 ROI 要做趋势修正：`roi_eff = roi − difficultyTrendPctPerDay × (预期持有小时 / 24)`。
- 排序键是 `effectiveCost` 对应的 ROI，不是挂牌价，也不是"每美元算力"。
- 竞价出价上限：`maxPay = revenueHr / (1 + targetRoiPct/100)`；出价必须 ≤ 该值，否则跳过（不在亏损区抢机器）。

## 5. 失败语义（fail-closed）

| 情形 | 行为 |
|---|---|
| 行情 < 5min | 正常判断 |
| 行情 5–10min | 用最近一次有效价继续判断，标记 `stale`，面板提示 |
| 行情 > 60min | 停止新租 + 尝试退租所有机器 + 红色告警（"无法确认收益，先止损"） |
| 矿池账户接口挂了 | 不把"看不出算力"当成"没算力"（否则会误杀），只标 `unknown` 并告警 |
| **市场 API（vast/Clore）挂了** | **无法退租**，只能告警 + 停止新租。文档和面板都要写明：止损不是保险 |

`decide()` 在 `!instancesOk` 时直接返回是**已知且可接受的权衡**，但必须让用户看见（面板红色 + 事件日志），不能静默。

## 6. 矿工二进制（供应链）

- 仓库内 `miners/manifest.json` 是**唯一**许可清单：`{version, url, sha256, asset}`。
- 下载可以走镜像（国内机器），但**每个候选包在解压前必须过 sha256 校验**；未通过即丢弃，全部失败则**不执行任何二进制**。
- 未 pin 的矿工一律禁用；升级只能通过 `node tools/pin-miners.mjs` 重新 pin 并人工 review diff。
- 校验值来源：GitHub Release 的 `digest` 字段 **且** 实际下载复算一致（两个独立来源）。

## 7. 平台条款

`capabilities.miningAllowed` 默认 `false`，必须在设置页手工勾选"我已确认该平台条款允许在其资源上挖矿"才解锁自动租用。
已知约束：vast.ai 条款规定**用信用卡充值的账户不得进行任何加密货币挖矿**。该确认项不得默认开启、不得由程序自动勾选。

## 8. 竞价（spot）状态归一

| 平台表现 | 归一状态 | 处理 |
|---|---|---|
| `actual_status=running` 且有算力 | `mining` | 正常 |
| `intended_status=running` 但 `actual_status=stopped`，且出过算力 | `preempted` | **按"需销毁"处理**：`stopped` 期间磁盘仍在计费；默认 5 分钟内销毁，不拉黑机器 |
| 从没出过算力就 `stopped` | `booting` 超时路径 | 按部署失败退租 |
| 其他非 active 状态 | `offline` | 连续 10min 才销毁 |

竞价实例被抢占**不是**机器质量问题：不进入黑名单，下轮扫描可以重新出价。

开关：`useSpot`（默认 `false`）与 `spotBidFactor`（默认 0.75）。M1 阶段只做了最小闭环——搜索 `type=bid`、下单带 `price`、`stopped` 按需销毁；**自动补位与更聪明的出价策略属于 M2**。