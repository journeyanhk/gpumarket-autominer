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

**当前账本口径（M2 之前，明确写死，避免误读 ROI）**：`accrue()` 只按 `dph`（GPU 挂牌价）记租金，
**不含存储费与出网带宽费**；`stopped` 期间的磁盘费也不计入；ROI 里同样没有 `inet_down_cost × 镜像 GB`。
所以现在所有"收益率"都是「不含存储/带宽」的口径，真实 ROI 只会比它低。
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
| **托管记录 `spot: true` 且 `actual_status` 不在 ACTIVE 集合**（stopped / exited / offline / 其他） | `preempted` | 5 分钟内销毁、**黑名单 0**、恢复 running 自动清计时。**不看是否出过算力**：开机阶段出价被顶掉是最常见的抢占时点 |
| 从没出过算力、且状态是 ACTIVE（loading/created/scheduling） | `booting` | 正常等部署，超时才按部署失败退租 |
| 按需实例的其他非 active 状态 | `offline` | 连续 10min 才销毁，拉黑 6h |

`spot: true` 的实例在 `offline` / `nohash` 分支销毁时同样 **`blacklistMin = 0`**：出价被顶或容器异常不该让整台机器进黑名单，否则高频抢占会把市场逐台拉黑。

**状态语义尚未在真机验证**：vast 对"被 outbid"的实例到底返回 `actual_status` / `cur_state` / `next_state` / `status_msg` 的哪种组合，目前只有推断。因此 `m.spot` 的状态元组每变化一次就写一条 `info` 事件（`noteSpotStatus`），M1.5 跑完用真实数据收紧判定。竞价下单被拒（`min_bid` 在下单前上涨）同样**不拉黑**，只把该 offer 从列表移除。

竞价实例被抢占**不是**机器质量问题：不进入黑名单，下轮扫描可以重新出价。

**判定前提（必须成立，否则会误杀）**：`intended=stopped` 被视为「平台停的」，前提是
①本程序从不主动 stop 实例；②使用者不会在 vast 网页上手动 stop 托管中的实例。
任何一条被打破，就会在 5 分钟内把一台你手动停掉的机器销毁。若将来要支持手动暂停，
必须先在 `managed` 里记一个 `manualStop` 标记并把这条判定让开。

开关：`useSpot`（默认 `false`）与 `spotBidFactor`（默认 0.75）。M1 阶段只做了最小闭环——搜索 `type=bid`、下单带 `price`、`stopped` 按需销毁；**自动补位与更聪明的出价策略属于 M2**。
### 8.1 追价（改价保活）默认关闭的实证（2026-10-27）

`PUT /api/v0/instances/bid_price/{id}/` 确实存在且可用，但用它救机器在实测里**零收益**：

- 20 次改价、9 台机器，**追价后恢复出算力的是 0 台**；其中 2 台是出过算力后才被顶，各追 3 次仍然被收回。
- 机制原因与 §8 一致：interruptible 是「房东随时可收回」，不是价高者得；容器一旦被收，
  抬高 `bid_price` 不会让它复活，只会把这一小时的出价上限和账单一起抬高。
- 因此 `maxBidRaises` 默认 **0**（不追价）。代码路径保留，等 §8.2 的对手价位样本攒够后可以回放验证。
- 不追价之后必须保证「被顶 → 计时 → 销毁」这条链不再被重置：旧实现在 `tryRaiseBid` 成功时
  `delete m.preemptedAt`，每追一次就重置一次 5 分钟销毁计时（一台机器最多能白挂 20 分钟）。
  默认 0 次之后这条路径不再触发，但**任何把 `maxBidRaises` 调回 >0 的人必须知道这个副作用**。

### 8.2 租约台账（`src/leases.js`、`tools/lease-report.mjs`）

一台机器一条记录，回答「该屏蔽哪个型号 / 该优先哪个房东」。决策口径是**每机时净收益**
= `(入账 PRL × 币价 − 实付租金) ÷ 计费小时`，不是 ROI 均值——短命机器 ROI 是 null 或极端值，
但租金是实付的，只有摊进机时才不会被拉歪。

关键字段与用途：

| 字段 | 用途 |
|---|---|
| `tRent / tRunning / tMinerUp / tFirstShare / tEnd` | 五个时间戳，把「出算力前被顶」「矿工启动慢」「部署失败」分开算 |
| `bidEntry / bidFinal / raises` | 出价轨迹（抬过几次、抬到多少） |
| `dphBaseActual / dphTotalActual` | 实付价，净收益只用实付价 |
| `endReason` | 枚举：`preempted_outbid` / `host_reclaim` / `our_stoploss` / `our_gate` / `deploy_fail` / `market_end` / … |
| `preemptKind` | 被收回成因推断：`outbid`（min_bid 明显高于我方出价）/ `host_reclaim`（价格没动）/ `deploy_fail`（容器起不来） |
| `opponentRatio` | 被顶时 `min_bid ÷ 我方出价`。这是检验「24GB 卡被 AI 租户抢」的唯一可用证据，不靠机制猜测 |
| `hostId` | 同一房东反复收回是比型号更强的信号 |
| `creditedPrl` + `creditedSrc` | 入账分摊。目前是 `pool_alloc`（按本矿池在跑机器的瞬时算力比例分摊）——**分摊不是真相**，单机能对上的只有份额 |

判据（写死在流程里，避免反复讨论）：型号屏蔽要等「3 天或该型号 ≥10 个干净租约」，到期按
`tools/lease-report.mjs` 的每机时净收益排名决定。2026-10-27 之前的历史样本受已删除的
「核价偏差直接销毁」误杀污染（13 台，4060 Ti 4 / 3070 3 / 3080 2 …），**不能用于型号取舍**。

### 8.3 到账分摊（`allocateCredit`）的三条硬约束（2026-10-27 复核修正）

矿池到账是「整个账户」的钱，摊到单机只能是估算。为了让三天后的型号排名不被长寿机器绑架，分摊必须满足：

1. **权重用本轮增量份额**，不是累计值。用累计值的话，每笔到账老机器都按「从租下到现在的总份额」拿大头，
   新机器和短命机器永远分不到。租约里用 `sharesMark` 记游标，分摊后推进到当前累计份额。
2. **分摊对象要包含「刚结束」的租约**（Kryptex 60 分钟、Pearlhash 90 分钟窗口）。
   入账有滞后：Kryptex 的 unconfirmed 要几分钟到几十分钟，Pearlhash 按小时结算。
   一台跑 40 分钟被收回的机器，它的币是死后才到账的——只分给 `!tEnd` 的租约等于把它挖的钱全送给别人。
3. **权重 = Δaccepted × difficulty**，不是 Δaccepted。Kryptex 对每个 worker 单独 vardiff，
   份额个数跨机器不可比；不乘难度会把「高难度少量份额」和「低难度大量份额」算成等价。

缺份额数据时（v8 之前的脚本 stats 被日志截断）退回瞬时算力比例，`creditedSrc` 如实标成 `pool_alloc`；
用了增量份额 × 难度才标 `share_alloc`。**报告里必须注明用的是哪一种**。

`endReason` 与被收回成因的对应：`preemptKind = host_reclaim`（同机 `min_bid` 没涨，说明不是被顶掉的）
时，`endReason` 归 `host_reclaim` 而不是 `preempted_outbid`——前者说明「加价也没用」，后者说明「出价不够」，
对决策的意义完全不同；容器起不来的归 `deploy_fail`。
