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
- **新币的矿工同样受这条约束**（2026-11-04 用户判定）：M3 引入任何新币时，它的矿工（例：Blocknet 需要专用 Argon2id 矿工，SRBMiner 不支持）**必须先 pin 进 manifest 才允许出现在镜像里**，不允许"从矿池页面下个压缩包直接跑"。Coin 插件的验收条件里包含这一项。

## 6.1 实验类代码与付费实验（2026-11-04）

- 任何会**花钱**的实验（租机测 A/B、校准、探针），观测代码必须先在本地用假数据跑通并有单测覆盖失败分支；否则不允许启动付费 run。
  - 依据：2026-11-04 CPU 腿 A/B 三次都死在观测链上（钩子位置、假想 JSON 结构、`shares.total` 当算力），共花 $0.0234，一条有效数据都没拿到。
- 实验钩子只允许走 `extraOnstart`（默认空字符串，空时开机脚本逐字节不变），且必须**前置**注入——`launchMode=args` 时脚本以矿工前台运行结尾，接在后面的命令永远不会执行。
- 实验完成后必须把 `extraOnstart` 复位为空并记录在文档里。

## 6.2 触发板（2026-11-04 取代"等密度"）

**"等密度回到 X"不是策略**——它没有触发条件、没有时间表，成本是余额闲置 + 引擎空转 + D14 拿不到新样本。
把下一步改成下面这张板子，由每日 09:07 的矿工流向任务逐条核对（`tools/gpu-coin-scan.mjs` + `tools/clore-census.mjs`）：

| 触发器 | 判据 | 动作 |
|---|---|---|
| PRL 价格 | ≥ $1.90 | 重算库存变现线（1.29 PRL 才有出手可能），密度门槛同步上抬 |
| Pearl 难度 | 24h ≤ −1.5% | B 型窗口候选：按需机 P=1 试租（窗口逻辑已有） |
| 池占比 | Kryptex 占比低于 7 日中位 **5 个点** | 同上：供给可能回流 |
| Clore | 出现 `mrl ≤ 24h` **且** 3080 Spot ≤ **达标线**（每日由 `tools/triggers.mjs` 现算；2026-11-04 为 **$0.025**，旧写死的 $0.033 建在 spec×0.6 上，会触发一次注定亏 35% 的租用） | 唯一能在 Clore 过 20% 的组合，出现即试租 |
| 以上全无 | — | **M3 是唯一有价值的工时去处**，不是等 |

注：Clore 的 `mrl ≤ 24h` 是硬过滤——`$0.0958` 的 2080 Ti 是 **720h（30 天）长约**，密度一个月能漂 ±50%，把它当现货等于自杀。

## 6.3 有效配置完整性（2026-11-04）

- 引擎启动时对 `DEFAULT_CONFIG` 做**递归键检查**：缺键 → **拒绝启动**并列出键名（`PRL_ALLOW_CONFIG_DRIFT=1` 可临时放行），启动成功则把快照写进 `state.json.effectiveConfig`。
- 修补工具：`node tools/fix-config.mjs [--write]`（只补缺失键，不动已有值，写入前备份 `.bak`）。
- 依据：保存过的 `config.json` 会整体覆盖默认值对象，新加的键静默变 `undefined`——面板一切正常，护栏却没生效。这比"影子列空着"严重得多。

## 6.4 运行节奏 R1–R5 与 D14 预注册判据（2026-11-04 用户判定）

**背景**：三周约花 $6.9 得到的结论是"vast 这门生意不是定价问题，是供给结构与密度问题"。继续在 PRL 上精修属于**回避换赛道**，不是工程。

| 编号 | 规则 |
|---|---|
| **R1** | **自动扫描继续**，2 小时一轮不变；`keyCruiseRows` 保持 0，key 只留给窗口二次确认。理由：扫描现金成本 $0（匿名额度、无租约、`maxBidRaises=0`），买的是"密度一变就能分钟级接单"的期权，同时是"0 台是市场而非 bug"的唯一证据链。 |
| **R2** | **人工巡检降到每天 1 次**（09:07 触发板那轮）。其余时间的 2 小时任务转为**静默告警检查**，只在四类告警时出声：① `cacheAge > 10 分钟` 或 `gapPct > 50`；② 守护重启次数增加 / `venueGuard.down`；③ 出现新的合格交付样本（`deliveredTh` 样本数增加）；④ 触发板 T1–T5 命中。 |
| **R3** | **11-11 前不再新增 PRL 侧功能**。PRL 代码进入"只修 bug"状态；本次唯一例外是 `thSource` 回退标记（见 §6.3 的同类问题）。 |
| **R4** | **11-11 D14 判定**，三条判据任一不过 → `rentEnabled=false`，引擎降为**纯只读监测器**，余额冻结为观测预算、不充值：<br>① ≥1 次**净正**闭环（入账×币价 − 实付 > 0）；<br>② 回放期望为正 **且** P(存活 ≥30min) ≥ 0.3；<br>③ **vast** 窗口期整卡供给 ≥2 条（2026-11-05 修订：此判据只对 vast 成立；Clore 可租整卡 3080 有 486 单元，约束不是供给而是价格差（最低档 2.2×、中位 7.3×），见 §6.14.1）。 |
| **R5** | D14 之后：M3 骨架已通 → Clore/多币接上，**PRL 作为第一个只读 Market 实现**留在系统里；M3 未通 → 那才是该讨论"停项目"的时刻，停的是项目，不是扫描。 |

**余额纪律**：$13 **不退、不充**。它是期权费（够一台 3080 跑 13 天），11-11 若密度回到 $0.032 就是开机弹药；不回到就是沉没成本，冻结即可。

**"停"必须由预注册数据触发，而不是临场情绪**——这样 11-11 那天不需要再争，只跑一遍判据。

**保守口径（2026-11-04 补）**：R4 的三条判据一律用**保守 th**（`pooled` / 台账实测比口径）跑。
若保守为正、乐观也为正 → 通过；**只有乐观为正 → 记为不通过**。理由：th 若高估 53%，回放会虚假转正，D14 会被误判通过。

## 6.5 thSource / pooled 回退与三条不变量（2026-11-04 两轮收口）

**第一刀（标签）**：`pricingTable` 每条带 `thSource` 与 `thCalibrated`。
**第二刀（数值，同日）**：`thSource=spec` 的型号里，`th = 规格 × 0.6` 是**魔法数**；而 `frac=null` 的样本被整体排除，
等于用数据清洗把"45 TH 的坏机器"洗掉、再用一个好看的常数顶上去。现在：

| 规则 | 实现 |
|---|---|
| `frac=null` 不等于数据不可用 | 进 **下限池**（`poolRatio`）：只做**上界约束**，不做点估计。frac 只回答"是不是整卡"，不改变"交付了多少 TH"这个观测事实。 |
| 无样本回退不再是魔法常数 | `th = min(规格 × uncalibratedFactor, poolRatio × 规格)`，`thSource='pooled'`、`thCalibrated=false`。2080 Ti 那条 `0.60` 是碰巧对；3080 真实比值约 **0.39**，旧口径高估 **53%**。 |
| 新不变量 | 无整卡样本的型号：`expectedDeliveredTh ≤ poolRatio × 规格`（有整卡样本时仍由 `maxDeliveredTh` 兜底，那是更紧的界）。 |

**实证**：3080 从 `68.9`（spec×0.6）→ **`45.0`（pooled）**；按密度 $0.0160、目标 20%，达标线从 $0.033 降到 **$0.025**。
**结论**：全市场比之前更没戏——但那才是真的。

### 6.5.1 阈值必须带 derivedFrom 并每日重算

`tools/triggers.mjs` 每次现算 T1–T5，输出 `threshold + derivedFrom`（哪个 th、`thSource`、哪个密度、哪个目标 ROI）。
**禁止把阈值写死在文档或定时任务里**——"推导它的输入变了、阈值没变"是最难发现的一类漂移（T4 就是这么从 $0.033 漂到该有的 $0.025 的）。

## 6.5.2 thSource 回退标记（原始记录）

`pricingTable` 每条带 `thSource`（`cheap-band` / `premium-band` / `model-median` / `cheap-carryover` / `spec`）与 `thCalibrated`（`spec` 时为 false）。
**任何跨场所比较（Clore 普查、触发板 T4）都必须先看这个标记**：台账 0 条的型号其"不亏线"是规格算力撑起来的，拿它去比会把"便宜一半"再读成一次假信号（3090 就是这么差点被读成"有戏"）。

## 6.6 达标线必须钉到「整卡报价」（2026-11-04）

`needDensity` / 达标线只能建立在**能真正租到的整卡**上，并显式输出出处：

```js
bidFrom: { offerId, machineId, frac, fracKnown, minBid, thSource, thCalibrated }
```

- 选择规则：`list.filter(frac >= 0.99)` 里取 `minBid/numGpus` 最小的一条；没有整卡 → `needDensity = null`、`bidFrom.noWholeCard = true`。
- `tools/triggers.mjs` 打印 `bid 出处：offer/<id> frac=… minBid=…`，**若 frac < 0.99 直接拒绝计算**（退出码 3）。
- **未知 frac 一律拦**：`isRentable` 对 `gpuFrac == null` 返回 `frac_unknown`（`allowUnknownFrac=true` 才放行）。旧逻辑把缺失当整卡，缓存里就踩过——`saveOffers` 当时没存 `gpuFrac`，重算时全部"变成整卡"。
- 实证：2026-11-04 面板上的 `$0.0533` 是**折整卡价**（半卡 $0.0267 ÷ 0.5）或缓存失真；同日最便宜的可租**整卡**是 `$0.0933`（offer 53447819），`needDensity` 从 0.0417 变成 **0.0730**，gap 从 160% 变成 **≈383%**。

## 6.7 逐轮报价快照（2026-11-04 起，只写不读）

```
data/offerLog/YYYYMMDD.jsonl.gz   # 每轮一行，multi-member gzip 追加
{t, n, window, rows:[{id,m,dph,mb,frac,eff,ram,gate,th}]}
```

- **只写不读**：任何决策路径都不读这个文件（`test/lease-test.mjs` 有断言：源码里不得出现对它的 read）。
- 30 天滚动，约 0.7KB/轮 → **≈350KB/天**。
- 三个用途：①覆盖率分析（"30 行就是市场"是当前无法反驳的假设）；②房东回收率的免费先验（连续两轮"有→无→有"= 高频收回型，不用花钱试）；③区分"真没机会"与"没被采样到"。
- 它不违反 R3：R3 禁的是**加功能**，这是**加观测**。

## 6.8 `frac=null` 在两层的相反用法（都正确，别改）

- **校准层**：`frac=null` 的 45 TH 样本**要进下限池**——它是真实交付，只是不能证明整卡（`poolRatio` 只用它做上界约束）。
- **决策层**：`frac=null` 的报价**必须 skip**——不能证明我们租到的是整卡。

> `frac` 在校准层表示"不能做点估计"，在决策层表示"不能下单"，两者不冲突。

一句话写在这里，是为了将来有人看到这两条时不必重构一次。

## 6.9 M3 verdict 三态与漏斗（2026-11-05）

`decide()` 返回 `verdict: 'pass' | 'watch' | 'skip'`：

| verdict | 含义 | 是否带补救条件 |
|---|---|---|
| `pass` | 现在就能租 | — |
| `watch` | **我们缺一项数据**（未校准 th / mrl 未知） | 必须带 `whatWouldMakeItViable`（`minDeliveredTh` / `maxUsdPerGpuHour` / `maxMrlHours`） |
| `skip` | 市场事实（frac 半卡、价格低于地板、ROI 不够、超预算…） | 不需要 |

`whatWouldMakeItViable` 里还有 `specTh` 与 `priceIsTheProblem`：
**当"要过线所需的交付算力 > 规格算力"时，价格是主因，补样本无解**。
没有这个字段，漏斗会把人引向"再多测几台"，而测多少都没用。

`tools/m3-funnel.mjs` 拿真实快照跑全量并输出：报价总数 → 归一化成功 → 各原因码计数 → `pass/watch/skip` 拆分 → watch 的补救条件。
**这是 M3 的第一份产出**：它把"没机会"拆成"缺哪一项数据"或"价格不够"。

## 6.10 单位断言（M3 的等价性证明）

`test/units-test.mjs` 用真实 raw 断言四个单位换算：

| 字段 | vast | Clore | 断言 |
|---|---|---|---|
| 价格 | `dph_total` 整机 $/h | `spot['USD-Blockchain']` 每 GPU **每天** | Clore 14.0/天 ÷6 卡 ÷24 = **$0.0972/卡·h**；vast 0.6 整机 ÷6 = **$0.1/卡·h** |
| 卡数 | `num_gpus` | `"6x RTX 3080"` 字符串 | 解析出 6（除错就错 6 倍） |
| 租期 | 按秒计费 → **0（已知无限制）** | `mrl` 小时 | 0 ≠ null：`null` 只表示"未知"，`0` 表示"确认无最短租期" |
| 内存 | `cpu_ram` **MB 十进制** → 128000 = **125 GiB** | `specs.ram` **GB** | 同量级（差 2.4%），差 1024 倍才是 bug |

"换 `market` 标签 → 同决策"只是**同义反复**（证明 allocator 没写场所分支），真正的等价性靠上面四条。

## 6.11 校准预算 = $0（硬规则，不用 EV 论证）

```
calibrationBudget = 0, no exceptions
```

**理由不是"EV 算出来是负的"，而是"单机测量的信息不迁移"**：测一台机器的交付 TH，
几乎不改变对**其他** host / 配置的判断，所以"这次测量会改变某个决策"的概率趋近 0。

> 用 EV 公式去证明"不该花"是危险的——那会让人以为"哪天 EV 转正就该花"。
> `src/m3/rentEv.js` 算的是**租用** EV（"租这台来挖值不值"，那是 `decide()` 的活），
> 与校准预算无关。两者混用就是下一个 0.6。

P 一律用 **Laplace 平滑 (k+1)/(n+2)**：n=5 时"4 台都好"读成 0.714 而不是 0.8——那 4 台很可能同房东。
另外 `need > spec` 时直接判"价格主因"，不给 EV（用 need 当收入基数会把 EV 算成正的，那是假象）。

## 6.12 `wholeCardShare` / `wholeCardUnits` / `exhaustive`：一个数不能干三件事

| 字段 | 定义 | 用途 | 可比性 |
|---|---|---|---|
| `wholeCardShare` | 整卡 **GPU 单元** ÷ 同分母总 GPU 单元 | 看**供给侧演化**（同场所时间序列） | 同场所内 |
| `wholeCardUnits` | 整卡 GPU 单元**绝对数** | 同场所时间序列 | 同场所内 |
| `exhaustive` | 这次统计是否全量（vast=false / Clore=true） | **决定前两个数能不能跨场所比** | — |

**2026-11-05 的第五次同类错误**：把 vast 的 10–12 与 Clore 的 2646 摆在一张表里，等于拿**我们自己的配额上限**当市场事实。vast 匿名额度每轮 ~30 行，`exhaustive=false`，`units` 只是**下界**。

规则：`exhaustive=false` 的场所，`units` **只能用于同场所时间序列，禁止跨场所比较**。跨场所一律走 `countOffers(gpu=…, wholeOnly=true, rentable=true)` 的**按型号确定性计数**，并且两边都要打印 `exhaustive` 与 `rentableOnly`。

**`exhaustive` 不等于"租得到"**（2026-11-05 用户实测）：Clore 有 **41% 的机器已被租走**，用含已租的分母报供给会把可得量高估 1.7 倍。所以两个标记都是必填：

| 标记 | 回答 | 缺了会怎样 |
|---|---|---|
| `exhaustive` | 我们拉全了吗 | 采样被当市场事实 |
| `rentableOnly` | 已租的剔除了吗 | 供给被高估 1.7 倍 |

**对照表固定五列**：`model | venue | filter | count | 口径`。脚注是给人看的，**列是给机器比的**——`clore 26` 与 `vast ≥7` 并列过一次，前者是 `mrl≤24h` 过滤后、后者没有 mrl 概念，读者会以为差 3.7 倍，真实差 4–19 倍。

**`806 → 2646` 这个 3.3 倍跳变必须写明**：806 是**房源数**（`fracDist['1.0']` 数的是 server），2646 是**GPU 单元数**（按 `nGpu` 求和）。同一口径换单位，不是供给暴涨。不写清就会变成第二个 `0.0533`。

实测（2026-11-05，五列口径）：

| model | venue | filter | count | 口径 |
|---|---|---|---:|---|
| RTX 3080 | clore | whole+rentable, mrl≤24h | **74 单元**（26 台） | exact |
| RTX 3080 | clore | whole+rentable, 无 mrl | **486 单元**（114 台） | exact |
| RTX 3080 | vast | whole+rentable | **≥7** | 采样 31 行，下界 |

同一个 Clore，换滤镜差 **6.6 倍**。这就是"滤镜必须是列"的原因。

## 6.12.1 匹配口径必须打出来（`matchedOn`）

漏斗输出必带 `型号匹配：gpu(exact) N 条 / normalizeFailed M 条`。
起因：2026-11-05 我自己用"型号名模糊匹配"把所有行配到了第一个型号，于是算出"价格主因 962/1001 = 96%"——
**一个和预期一致的派生比值，最不容易被审查**。规则：**任何比例/倍数进结论前，必须能打印它的分子分母怎么来的。**

## 6.13 漏斗时间序列（D14 的证据）

`tools/m3-funnel.mjs --append` 每天 09:07 追加一行到 `data/offerLog/funnel-YYYYMMDD.jsonl`：

```
{at, day, total, normalized, pass, watch, skip, priceLimited, dataLimited,
 wholeCardShareVast, wholeCardShareClore, price, density}
```

**单日快照回答不了"市场有没有在变好"**；序列能回答两件事：`pass` 是否曾经非零、价格主因比例有没有下降趋势。11-11 判定时这份序列比任何一条租约都更有说服力。

## 6.12.2 先问有没有货，再问值不值（接口顺序，2026-11-05）

`Market` 契约新增：

```
countOffers(query) → { count, exhaustive, sampledRows, asOf }   // 有没有货
observeSupply()    → { counts, wholeCardShare, wholeCardUnits, exhaustive, sampledRows, at }
decide(offer, ctx) → { verdict, reasonCode, expRoi, whatWouldMakeItViable }  // 值不值
```

漏斗分两阶段跑：**第一阶段 `countOffers`**（回答"市场上有没有整卡"），**第二阶段 `decide`**（回答"值不值"）。
这个顺序以前只写在评论里，现在长在接口上——否则第二个币的 `pass=0` 会再次混淆"没有货"和"没采到"。

## 6.13.1 `offerLog` 历史记录的使用边界（2026-11-05）

`c67fdbd` 之前的快照行**没有 `gpu` 字段**，永远无法正确重算型号维度：

- ✅ 可用于：价格分布 / 供给计数 / 整卡比例；
- ❌ 不得用于：型号维度漏斗；
- ⛔ **禁止用型号名反查回填**——那等于第二次猜（同样的错误换个形式）。

按经验，任何人看到"整卡 1080 条但漏斗 0 条"的第一反应都是去回填。先写下来。

## 6.14 vast `cpu_ram` 单位是**假设**，不是断言（2026-11-05 用户纠正）

```
128000 —— 若单位 MB(10^6)  → 128.0 GB = 119.2 GiB
       —— 若单位 MiB(2^20) → 125.0 GiB
```

归一化里取 **MiB**（`ramUnitAssumed='MiB'`），即偏乐观一档（多算约 3 个线程）；偏差由下游 4GiB OS 余量吸收。
**官方文档未确认单位，所以文档与测试里一律写"假设"，不得写成"已验证"。**

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

### 8.4 累计到账必须单调（P0 复盘，2026-10-28）

`ledger.prl.acc` 曾经把同一笔 PRL 记两次：调用方传的是「当前余额」而不是「累计到账」，
矿池一打款余额归零、再从 0 涨回来，差额就被再记一遍。实测 Kryptex 多记 1.03、Pearlhash 多记 1.10，
面板"全程盈利 +$2.26"其实是 **−$1.65**。

修法两条：

1. **调用方一律传单调量**：Kryptex 用 `paid + balance`（`fetchKryptexEarned().earned` 已是此口径）；
   Pearlhash 用「正数 `balance_transactions` 之和 + pending」（pending 结算时 credited 增加、pending 减少，和不变）。
2. **`track()` 保留高水位**：值一旦下降只记 `resets` 计数（`ledger.<pool>.prl.resets`），绝不把 `last` 跟着降。
   `resets` 就是口径问题的报警信号。
3. 回归测试：`pool-test`（打款导致回落 → acc 不变）、`lease-test`（高水位 / 增量累加）。

**租约台账的 `creditedPrl` 是相对口径**：只覆盖台账上线之后的到账增量，是给型号排名做相对比较用的，
不等于该机器的绝对产出。矿池级绝对数看 `ledger`（现已校正到真实累计）。

### 8.5 每日失败成本封顶（`dailyFailBudget`，默认 $0.30）

「等待模式」不是零成本：租到手却没出过一份份额的机器（部署失败、刚下就被房东收回）照样付租金。
这类支出单独累计在 `st.failSpend = { day, usd }`，只统计 `tFirstShare == null` 的租约；
到顶后 `rentAllowed()` 直接拒租到第二天零点（UTC 日切），避免"抢不到也要花钱"无界。

### 8.6 min_bid 30 分钟稳定性过滤（`minBidStablePct`，默认 10%）

同一台机器的 `min_bid` 在 30 分钟内跳 >10%，说明它正在被抢或房东在试探价格，
此时下单大概率刚租就被收（今天 4090 三次开局收回都是这种形态）。样本不足 20 分钟不判（避免误杀新机）。

### 8.7 窗口模式（`windowMode`，2026-10-28 定）

利润只在「收入密度 ÷ 租金地板」越过 1 的时候出现，而**平时的风控恰好会在窗口期挡住下单**
（min_bid 一跳就过滤、失败成本一超就停）。所以窗口期只放宽三项：

| 项 | 生产值 | 窗口值 | 为什么 |
|---|---|---|---|
| `minBidStablePct` | 10%/30min | 50% | 窗口期 min_bid 必然跳，不收窄就等于自动弃权 |
| `dailyFailBudget` | $0.30/天 | **$1.0/窗口（绝对额）** | 抢失败是窗口期的正常成本，但不能无界 |
| `maxHourlySpend` | $0.20/h | $0.60/h | 窗口短，允许集中下单 |
| `maxBidRaises` | 0 | **0（不放宽）** | 追价 9 台 0 次救活、机制上是房东收回而非价高者得；窗口期不会改变这一点 |

触发两种，任一条成立即进入：
- **A 消息型**：PRL 1 小时涨幅 ≥ `chg1hPct`（默认 8%）；
- **B 算力回落型**：最优报价的「收入密度 ÷ 地板」≥ `ratio`（1.0）**且**密度 24h 上升 ≥ `densityRise24hPct`（15%）。
  加 B 的原因：本周窗口是全网算力从 94 掉到 76 EH/s，币价没涨，只盯币价会漏掉。

`minutes`（360）到点自动退出，退出时 `assertProductionLimits()` 核对三项已恢复、且 `maxBidRaises` 仍为 0；
窗口内失败成本触顶则**提前退出**（不是无限放宽）。

### 8.8 按型号的 L1（`l1ByModel`）

`L1 = 份额反推算力 ÷ 矿工自报`。出价评估用的是参考算力（来自矿工自报），所以必须乘 L1 才是能卖出去的算力；
不乘会系统性高估 20–30%（实测 3080：自报 118 TH/s、累计反推 109.6、边际 90.1 → 0.76~0.93）。

规则：按型号维护最近 20 个样本取中位数；**样本 <3 的型号用全局保守值 `l1Default = 0.8`**（不拿一两台机器当结论）；
异常值（<0.3 或 >1.5）直接丢弃。面板同时暴露 `th`（乘过 L1）与 `thRaw`，避免再被单一口径误导。

### 8.9 场所审计 `tools/venue-audit.mjs`（同名不同币防线）

Pearl 的 ticker 已经被三方撞过：Gate 的 `PEARL` 是 Pearl，而 Gate/Binance/MEXC/Bitget/KuCoin 的 `PRL`
是**另一个项目**（全都在 $0.096–0.097 一带，5 个所都挂着，成交量还不小）。差一个数量级，
深度再好也不能用——用错就是拿别人的盘口做对冲。

工具做法：取权威参考价（优先控制台 `market.price`，退回 pearlhash `/api/pearl-price`），
逐个场所拉最新价并算 `ratio = 场所价 / 参考价`：

| ratio | 判定 | 处理 |
|---|---|---|
| 0.67–1.5 | `SAME_ASSET` | 可用（`--deep` 时再拉三层盘口） |
| <0.33 或 >3 | `IMPOSTOR` | 直接忽略，并在输出里点名 |
| 其余 | `SUSPECT` | 人工核（可能只是行情滞后） |

2026-10-28 实测：`gate/PEARL_USDT` 1.00×、`lighter/PRL` 1.00× → 可用；
`gate/PRL_USDT`、`binance PRLUSDT(perp)`、`mexc/bitget/kucoin PRLUSDT` 全部 0.06× → 判定 IMPOSTOR。
结论：**Pearl 目前只有 Gate 现货 + Lighter 永续两个可用场所**，其余都是同名不同币。

### 8.10 搜索额度分桶（40 / 60）与「额度耗尽也能下单」

vast 的搜索额度按**返回行数**计、UTC 0 点重置（北京时间 08:00）。固定 90 秒 × 60 行的节奏
会在无窗口的下午把额度烧光（2026-10-28：331 次 / 19,860 行，正好在两次 +10% 窗口前耗尽）——
这是**策略缺陷**，不是"只能等到明早"。

- `quotaBuckets()`：`quotaEst × 40%` 给巡航、`× 60%` 锁给窗口，`usageToday()` 分别记 `cruiseRows` / `windowRows`。
- 巡航：每次 `cruiseScanRows`（默认 30）行，间隔 = 剩余巡航额度 ÷ 剩余次数，**最少 10 分钟**。
- 窗口：`windowScanRows`（默认 100）行、**60 秒**一次，直到窗口桶耗尽。
- 下单不受搜索配额限制（走 `PUT /asks/{id}`），所以额度耗尽时用**缓存报价**出价：
  `offersCache` 落盘、≤ `offerCacheMaxMin`（30 分钟）、`min_bid` 稳定、`thPer01` 过线的可直接下单，
  `no_such_ask` / `unavailable` 换下一条，不计失败成本。
- `autoRent` 里「最近扫描太旧就不下单」的闸门在额度暂停期间改用**缓存时间戳**判断——
  这条不改，缓存报价永远进不来（两次窗口都是被它挡住的）。

### 8.11 第三种窗口触发：6 小时阶梯上涨

只认「1 小时急涨」会漏掉最常见的形态：价格分几小时阶梯抬上来、1 小时已经停滞
（2026-10-28：1h +0.56% 但 6h +11.04%）。第三条规则：
`6h 涨幅 ≥ chg6hPct（8%）` **且** `密度 6h 均值 ÷ 地板 ≥ stairRatio（1.1）`。

### 8.12 vast 搜索额度：按「返回行数」计，账号级，20,000 行/天

实测（2026-10-28）：331 次请求 × 60 行 = **19,860 行**后返回 `429 Daily search row quota exhausted`，
网页控制台同时报 `Daily search limit reached. Resets at 00:00 UTC`。据此：

- **计费单位是行，不是请求**：`limit=60` 一次就扣 60 行。同样的额度，`limit=20` 能扫 3 倍次数。
- **额度是账号级**：网页登录态也被同一额度挡住 → **再建一把 API key 不会增加额度**，只有换账号（或等 UTC 0 点）才行。
- **每天上限约 20,000 行**（我们撞到 19,860 就断了，取整到 2 万）；`quotaEst` 会按实际撞到的值自学习。
- **下单不受此限**：`PUT /api/v0/asks/{id}/` 不吃搜索配额 —— 所以额度耗尽时仍可用缓存报价或手抄 offer 下单。
- 由此把默认 `cruiseScanRows` 降到 **20**、`windowScanRows` 降到 **40**：
  40% 巡航 = 8,000 行 ≈ 400 次（约 3.6 分钟一次）；60% 窗口 = 12,000 行 ≈ 300 次（60 秒一次可覆盖 5 小时窗口）。
- 请求频率限制（`x-ratelimit-limit=30`）与每日行数额度是**两套**东西，别混用。

### 8.13 房东三层制：硬封 / 24h 观察 / 白名单（2026-10-30）

只按型号屏蔽解释不了 70 次租用 64 次 `host_reclaim`：收回集中在 7 个房东，而房东 482330
764 分钟 0 收回。所以筛选的单位是**房东**，分三层：

| 层 | 判定 | 后果 |
|---|---|---|
| 硬封 | 收回率 >60% **且** 中位存活 <20 分钟（样本 ≥2） | 7 天不租（到期后 7 天假释：每房东只许 1 台，活过 30 分钟才彻底解除） |
| 24h 观察 | 累计收回 ≥2 次；或单次收回且中位存活 <20 分钟 | 24 小时不租；假释期同硬封 |
| 白名单 | 已结束租约 **≥3 条** 且 每机时净收益 **>0** 且 中位存活 **>60 分钟** | 房东口径的 L1 与 P、`minBidStablePct` 放宽到 50%、同房东允许 **2 台** |

优先级：**白名单压得过 24h 观察（软封），压不过硬封**。理由是软封只说明「累计收回 2 次」，
而白名单的三条样本已经把这个房东的收回率定价过了（净收益为正、中位 >60 分钟）；硬封是
「收回率 >60% 且中位 <20 分钟」，与白名单条件互斥，同时出现说明数据有问题，按保守处理。
`applyGates` 对被压过的软封打 `hostBanLifted = true`，面板上能看出这次出价是靠白名单放行的。

并发： `hostConcurrentCap()` = 白名单 `perHostMachines`（默认 2），其余走
`unknownHostMaxConcurrent`（默认 1，此前是个从没被读过的死键）。为什么陌生房东只给 1 台：
部署失败与被收回的代价是**每台一份**，而陌生房东的存活率恰恰未知——一次押 3 台等于把同一个
未知概率连乘 3 次。

**幸存者偏差必须写在报告里**：白名单是从已经发生的租约里学出来的。它只能说明「这个房东过去
赚钱」，不能证明「下一台也赚钱」；历史回放里白名单房东贡献的 +$0.03/机时 不能当成白名单的
预期收益（见 `tools/replay-backtest.mjs` 的 survivorship 段）。

### 8.14 窗口 episode（M2.1：捕获必须可验证）

每次进入窗口模式落一条 `st.windowEpisodes` 记录：

| 字段 | 含义 |
|---|---|
| `start / plannedEnd / endedAt` | 进入时刻、计划退出（默认 6h）、实际退出 |
| `reason` | 触发真因（1h 涨幅 / 6h 阶梯 / 密度上升 / 72h 算力回落），原文写进状态 |
| `info` | 当时的行情快照：`chg1h / chg6h / ratio / ratioPass / density6h / densityRise24hPct / netDrop72hPct / price` |
| `limits` | 当时放宽后的三项阈值（`minBidStablePct / dailyFailBudget / maxHourlySpend`） |
| `rents[]` | 窗口内租下的租约 id（`rent()` 落账时追加） |
| `adopted` | 引擎重启/热更新时补记的在途窗口（行情快照只能用补记时刻，不是触发时刻） |

`tools/window-report.mjs` 把 episode 与租约连起来算捕获率（有租约的窗口 ÷ 总窗口）、
窗口净额、中位存活、出算力率；`--backfill` 从 `history` 反推历史窗口，但**只能用价格口径**
（1h / 6h 涨幅）——`ratio` 与 `ratioPass` 需要当时的报价列表，`history` 里没有，报告里必须标注。

**两条配套修正（2026-10-30 当天）**

1. **扫描时就建 `machine_id → host_id`**：vast 的 `/bundles/` 响应本来就带 `host_id`
   （匿名搜索同样返回，实测确认），所以白名单与房东口径 L1 对新机器立刻生效，
   不用「先租一台、被收回一次才发现房东是谁」。租下之后的 `refreshVast` 仍会再校一次；
   映射存在 `st.machineHost`，新增映射时立即落盘（不等 2 分钟周期保存）。
2. **`l1ByHost` 回填**：此前 `recordL1` 没带 hostId，历史样本全落在型号口径（2080 Ti 被
   482330 的 1.17 污染后封顶 1.0）。引擎启动时跑一次 `backfillHostL1()`，用台账里的
   `sharesAccepted × difficulty × 2^32 ÷ 秒数 ÷ (lastHs | localThAvg×1e12)` 反算每条已结束租约的 L1，
   验收带 **0.5~1.5**（比在线采样 0.3~2.0 更严：回填每条租约只有一个终点值，而 `pool_alloc`
   是按瞬时算力比例分摊的，长租约的终点值容易偏低——482330 那条 764 分钟反算出 0.228 就是这种污染）。幂等，靠 `st.l1HostBackfilledAt` 标记。
   同时 `l1ForHost()` 对**白名单房东**放宽到 2 条样本（非白名单仍要 3 条）：
   白名单已经过了「≥3 条租约、每机时为正、中位 >60 分钟」，再卡 3 条 L1 样本等于让新晋房东白等一台机器。

### 8.15 `ratio` 只从「通过钓鱼过滤」的报价取地板（2026-10-30）

`ratio`（全市场地板比值，次要指标）原来对**全部**报价取 `max((th×密度/24)/dph)`。2026-10-30 实测
被一条 $0.0119/h 的「4090」放大到 **19.49**——那条报价已经被按型号地板（P10×0.5）判为钓鱼、
本来租不到，却还在给指标供数，而且它是**窗口触发 ②③ 的输入**：假报价可以把系统骗进窗口模式。

修正：地板只从 `!floorSkip && !insaneSkip && !blacklisted && !avoidHost` 的报价里取，
并输出 `ratioN`（参与计算的报价数，0 = 用的是缓存地板）。可出价集合为空时 `ratioPass` 仍然是 null，
不允许拿 `ratio` 顶上——两者语义不同：`ratio` 是「最好的一条」`ratioPass` 是「能出价的中位」。

**B 型窗口的成立条件（2026-10-30 观察，写进判据而不改代码）**：算力回落型窗口要「**算力退、价格稳**」
同时成立才有肉。当天 72h 算力 −29.6%→−35.7%，但密度只有 $0.0223/TH·天（币价 $1.52 跌得比算力退得还快，
$1.71 的反弹也没把密度拉回 $0.026），结果是 `ratioPass` 一直 null、过线 0 条。所以第④条触发只负责
「允许进入窗口」，能不能租仍然由 `ratioPass`/期望 ROI 决定——**触发≠机会**，报告里必须分开写。

### 8.16 租用假阴性、删失样本与零份额（2026-11-02 实测驱动）

**租用假阴性**：vast 在 `no_such_ask` / 5xx / 超时下可能**其实已经下单成功**。2026-11-02 实测：
`rent-manual` 返回「这台机器刚被别人租走了」，而实例 58753840 已经在跑，重试又租了一台 → 双租双计费。
现在的规则：任何失败先 `GET instances` 按 `machine_id` 核对，**已落地就按成功登记、绝不重试**；
核实未落地的**自动重试**上 10 分钟锁（手动单不受限——人手刚核对过），锁内二次自动下单 → 判「反复租不到」屏蔽 2 小时。
429 例外：那是频率问题，走全局 5 分钟退避，不占机器锁。

**删失样本（our_kill）**：我们自己发起的销毁（矿工未上线 / 部署超时 / 掉线 / 算力过低 / 止损 / 离线）
统一记 `endReason = our_kill:<码>`。房东台账的中位存活、`pSurvive` 的分母都**排除**这些租约——
它们既不是房东收回，也不说明房东短命。房东证据只认 `host_reclaim`。
（回填先例：58753840 的 `deploy_fail` → `our_kill:premature_1a`。）

**零 accepted share**：矿工在跑（`localHs > 0`）却一份 accepted share 都没有（钱包地址错 / 矿池拒 /
算法不匹配）与「矿工没起来」是两件事。新增 1a2 规则：`localHs > 0` 且 `noShareKillMin`（25 分钟）零份额 → 退租，
`endReason = no_accepted_share`。1a) 的 8 分钟「未上线」规则同时改为**先看 localHs**：
有本地算力就不算未上线（实测把一台正在 102 TH/s 出算力的机器杀过）。

**顺带修**：`tryRaiseBid` 原来拿「实付总价（含存储）」当加价基准、却拿「纯算力收入」当上限，
任何 10% 加价都会越过 20% 上限 → 追价永远不成立。现在把存储费从上限里扣掉再判断。


## 6.14.1 供给约束只在 vast；Clore 的约束是价格差（最低档 2.2×、中位 7.3×）

D14 的第三条（"窗口期整卡供给 ≥2 条"）**只对 vast 成立**：

| 场所 | 可租整卡 3080 | 约束 |
|---|---:|---|
| vast | 1–7（采样下界） | **供给**：1–2 台 |
| Clore | **486 单元 / 114 台**（无 mrl）；74 单元（mrl≤24h） | **价格**：最低 $0.0499 → **2.2×**；mrl≤24h 中位 $0.1688 → **7.3×**；全量中位 $0.2083 → **9.1×** |

**换市场不会解决供给，只会把"1–2 条"的瓶颈换成"2.2 倍价格差"。** 但 2.2 倍是比 200 倍好对付得多的距离——它是"等密度涨到 2.2 倍"或"换一个密度更高的币"，**两个都在我们能力范围内**。这是九天内第一次出现"瓶颈是可度量的倍数，而不是结构性缺失"。

顺带一个解释：Clore 41% 的机器被租走，说明这个市场在赚钱——**但从 AI 租户赚，不是从矿工**。这解释了为什么它的中位价是 vast 的 2–3 倍：定价权不在矿工手里。

## 6.14.2 WTM `nethash` **就是 H/s**（三锚点 ≤3%）；不确定的是每卡算力表

我 2026-11-05 先写了"42 个币里 41 个单位存疑"——**那是错的，而且错法和我在批评的完全一样**：
我用记忆里的 2021–2022 量级（RVN 4–5 TH/s、Ergo 15–25 TH/s）去质疑实测数据。今天实测：

| 算法 | 独立锚点 | WTM 比值 |
|---|---|---:|
| pearl | 本机扫描 87.6 EH/s | 1.10 |
| autolykos | `api.ergoplatform.com/info.hashRate` = 589,810,514,536 | **1.002** |
| kawpow | `rvn.cryptoscope.io` `hashrate_raw` = 480,833,028,965 | **0.981** |

三个都在 [0.8, 1.25] 内。**成熟币的单位系数是 1.0，`diffToHash` 前置可以删掉**——唯一需要系数的仍是 WTM 不覆盖的新币。

**真正不确定的是每卡算力表**（KawPow 48 MH/s、Autolykos 175 MH/s…），那是 ±30% 量级，不是 10–30 倍。

**我自己在这一节里又犯了一次同类错误**：把 `48 MH/s` 写成 `0.048 TH/s`（差 1e6），于是 RVN 显示 $9.95/h。
所以现在的写法是：**表里所有算力统一 TH/s，并在注释里写换算过程**。

### 单位测试 = 锚点比值断言（不是范围启发式）

`tools/unit-anchors.json` + `tools/unit-anchor-check.mjs`：每个算法一个独立来源，断言 `ratio ∈ [0.8, 1.25]`。

- 锚点未过的算法 → 该算法的币**立即停用 `pass`**（`uncalibrated_algo` → `watch`）；
- 缺锚点的算法（etchash / firopow 目前 `pending`）→ 同样只能 `watch`；
- `$/h ∈ [1e-4, 1]` 那种范围过滤**不是测试**（用户的 $0.0101 能通过它却仍可能错 10 倍），只保留为 sanity。

## 6.14.3 派生表必须带 `thSource`（2026-11-05）

`mature-coin-sweep` 第一版读了 `pricingTable.th` 的 **spec 回退值 68.9**，算出 Pearl $0.0611/h、差 1.2×；
按 **pooled 45 TH** 是 $0.0399/h、差 **1.8×**。**1.2× 意味着"再等等就到了"，1.8× 意味着"还差一倍"**。
所以这张表固定带 `thSource` 列，并且取数必须指定型号（第一版取了 2080 Ti 的行来算 3080）。

## 6.14.4 锚点必须同一时刻成对（2026-11-05）

`nethash` 是时变量：PRL 两天内在 81.8–92 EH/s 之间摆。我上一轮报 "pearl ratio=1.10"，再上一轮报 "0.6%"，
**两次取样时间不同**——这暴露了锚点表的结构缺陷：不同时刻的两个数相比，`[0.8, 1.25]` 里有相当一部分宽度
是在容忍时间漂移，而不是单位误差。

现在每条锚点记录 `{wmtNethash, wmtAt, anchorHashrate, anchorAt, skewMin, ratio}`，
**`|Δt| > 10min → 该锚点作废**（`status=INVALID_TIME_SKEW`），**不放宽容差**——放宽容差等于把漂移当单位误差吸收。

## 6.14.5 跨算法表只放能横向比的列（2026-11-05）

`密度 $/TH·天` 从跨算法表里**删掉**：KawPow 单卡 48 MH/s、Pearl 单卡 45 TH/s，差 1e6 倍，
放同一列等于邀请"Neoxa 比 Pearl 好 45 万倍"这种误读。跨算法只保留 `3080 $/h`、`达标上限`、`溢价`、`thSource`、`锚点`；
密度改名 `densityPerHsDay` 只留在 JSON / 单算法视图。

**规则：表里每一列都要能回答"这列能横向比吗"；不能比的列不许出现。**

## 6.14.6 新币阈值不写死（第九个魔法常数 0.030 已删除）

```
threshold(venue, th) = minRentablePrice(venue) × (1 + roiReq) × 24 ÷ th
```

2026-11-05 实测输出（`tools/new-coin-watch.mjs`）：

```
需密度 ≥ $0.0394/TH·天（roiReq 46.7%）｜CPU 影子腿 $0.028/h（14 线程 × $0.002）
  derivedFrom: venue=vast,  price=$0.1067, th=45(pooled) → 需 $0.0835/TH·天
  derivedFrom: venue=clore, price=$0.0504, th=45(pooled) → 需 $0.0394/TH·天
```

原来写的 `0.030` 会报出**差 30% 的假机会**——那正是 PRL 1.9× 差距所在的区间（看起来有戏、其实没有）。

**每条新币信号都带 `cpuLegUsdHr` 影子腿**：新币 × CPU 是仅剩的两个未证伪象限的交集，而纯 CPU 币根本没有 GPU 腿。

## 6.14.7 双源密度取小，分歧 >10% 禁止 pass（2026-11-05）

```
pricing_density = min(our_density, wtm_density)
spread = |wtm − ours| / min(ours, wtm)
spread > 10%  →  verdict 最高 watch（reasonCode=density_spread），并输出 densitySpread
```

**为什么不能只当观察项**：Pearl 上两个源差 **12.7%**，换算成 45 TH 的 3080 是 **$0.0048/h**——
等于**部署成本（3.33%）的 4 倍、20% 门槛的五分之三**。用乐观那个源，会把"差 1.9×"说成"差 1.7×"，
而 1.7 距离"再等一等就到了"的心理阈值更近。

实测（2026-11-05 09:07Z）：`ours $0.01986 / wtm $0.02103 → pricing $0.01986，spread 5.9%`（今日 <10%，允许 pass）。

## 6.14.8 出块时间必须用链上实测（2026-11-06，用户定位的根因）

| 源 | 出块时间 | 相对链上 |
|---|---:|---:|
| **链上实测**（`pearlhash /api/chain-info → avg_block_time_s`） | **174.9s** | — |
| Kryptex 自报 | 194s | **+10.9%** |
| WTM 自报 | 183s（早期 171s） | +4.6% |

密度 ∝ 1/出块时间，**10.9% 的偏差 = 20% 门槛的一半**。修法：所有密度计算统一用链上实测值，
各源自报值只作审计（`blockTimeSources{kryptex,wtm,kxVsChainPct}` 进面板）。

**修完后 spread 从 16.8% → 30.1%**，说明还有第二个变量：全网算力（链上 101.2 EH/s vs WTM 87.1 EH/s = 16%）。
于是把第二源改成**只换一个变量**：用 WTM 的区块奖励，其余输入（链上 nethash/出块时间/币价）与我们相同。
最终 **spread 5.2%**，回到"gap 355% 不过"这个干净理由上。

**规则**：`spread` 只允许反映"单一变量的分歧"。三个变量一起比，等于把三种误差揉成一个数——那正是我们反复犯的错。

## 6.14.9 Pearl 的 nethash 没有仲裁者，改用台账实测密度（2026-11-09）

**标准换算对 Pearl 不成立**：`nethash = difficulty × 2^32 ÷ block_time` 算出 **1.34 PH/s**，而我们相信 **87.6 EH/s**，
差 **65,600 倍**。Pearl 是矩阵乘算法，difficulty 不是"每 2^32 次哈希记 1"。
所以 **"全网算力"只是各家自报的估计量**：我们 87.6 EH/s 与 WTM 的差 12.7%，是两个估计量的差，不是谁算错了。
**停止仲裁 nethash。**

### 实测密度（唯一不经过 nethash 的口径）

```
measured_density = Σ(credited PRL × price) ÷ Σ(deliveredTH × hours) ÷ 24
```

台账 6 条租约（h≥0.5、th 用矿工自报）、2167 TH·h：

| 口径 | $/TH·天 | 相对实测 |
|---|---:|---:|
| **实测（台账 credited）** | **0.02150** | — |
| WTM（仅换奖励） | 0.02014 | −6.3% |
| 我们（链上原语） | 0.01739 | **−19.1%** |

单条租约离散 0.0144–0.0262，加权 0.0215，**不是离群点**。
**结论：WTM 更接近真相，我们的链上口径系统性低估约 19%**（自报 TH 若偏乐观，真实值只会更高）。

处置：
- `measured_density` 进日报字段（每天一个数）；
- `pricing` 仍取 `min(ours, wtm)`——**保守**，在"要不要租"上宁可低估收入；但**不再声称它是精确值**；
- `spread` 的语义改为"两个外部估计量的差"，**它不裁决对错**。

## 6.15 下一个时间盒：一个币、一条漏斗、一个结论（2026-11-06 → 11-11）

**M3 现状：两个市场（vast / Clore）、一个币（PRL），而 PRL 已经死了。** 漏斗显示两个市场的 watch 全是价格主因、pass = 0——问题不在市场，在币。

| 步骤 | 判据 |
|---|---|
| 选币 | `density` 能用公开难度反推，**且 `diffToHash` 有已发表系数**（KawPow / Autolykos / Etchash）；不自己拟合 |
| 实现 `Coin` | `specOf / revenuePerUnit / deliverableOf` 三个方法，**不碰 allocator** |
| 跑漏斗 | 用两个市场的真实报价，输出 `pass / watch(priceLimited | dataLimited)` |
| **验收** | **`pass > 0` 才算 M3 有价值；`pass = 0` 则是"全行业性结论"，同样值钱** |

$13 在这一步大概率仍不用花（漏斗零成本就能判死绝大多数）。**只有出现 `pass > 0`，那笔钱才是该动的时刻。**

### 时间表（2026-11-05 定稿）

| 时间 | 事 |
|---|---|
| 今晚 | 锚点补 `|Δt|≤10min`（已做）与 pending 两项（etchash/firopow）；密度列改名（已做） |
| 11-06 | 新币监测开关上线（阈值 derivedFrom + CPU 影子腿，已做）；M3 时间盒收口 |
| **11-07 ~ 11-10** | **只跑不写**：让锚点、漏斗、新币信号各积累几天。**不写代码** |
| 11-11 | D14 三判据（保守口径）+ 全灭表作证据附录；大概率判负 → `rentEnabled=false` |

**这五天最重要的是"不写代码"**：连续十轮迭代每轮都对，但边际决策价值在下降。让数据跑几天，比再加三个断言有用。


## 6.16 项目终止条件（2026-11-05 预注册，2026-11-06 补两条，**不需要再开会**）

D14 判的是 **PRL 这个币**。但 M3 之后还有"新币监测"这条路，它同样可能是长尾空跑。
**如果不预先定死终点，我们会在 12 月还在给同一个系统加断言。**

> **终止条件**：若到 **2026-12-31** 为止，新币监测未出现**连续 3 天**满足
> `density ≥ minRentablePrice × 1.467 × 24 ÷ th`（双源取小、CPU 影子腿计入）的标的，则：
> 1. 停止一切自动租用与实验支出；
> 2. 引擎降为**纯只读监测器**（保留锚点表、漏斗、触发板）；
> 3. 项目定性为 **"已验证：在 2026 Q4 的市场条件下，云端租算力挖矿不存在正期望"**——这是一个完整、可交付、有证据的结论，不是失败；
> 4. 工具与文档归档，作为下一次市场变化时的重启包。

### 6.16.1 通过时的预注册动作（2026-11-06 补，防止"当场凭兴奋决定租几台"）

```js
TRIGGER_ACTION = { machines: 1, hours: 1, hardCapUsd: 2, autoRenew: false,
                   record: ['deliveredTh','credited','oom','reclaimed'], cooldownHours: 24 }
```

触发即执行、不讨论；结果写入台账后 **24 小时内不做第二次**。

### 6.16.2 判决词现在就写死（常量，不在 12-31 那天写）

`src/m3/constants.js → TERMINATION_STATEMENT`：

> "已验证：在 2026 Q4 的市场条件下，云端租算力挖矿不存在正期望。证据：40 条租约净 −$0.57；42 币全灭表最优差 1.9×；两个市场 gap 分别 249% 与 2.2–9.1×；供给约束仅存在于 vast。"

**判决词在情绪之外写，才有可信度。** 12-31 只跑脚本。

**理由**：九天里最有效的产出，全部是"多快能证明一件事不成立"（漏斗一天判死 PRL、全灭表两小时判死换币）。
把这条路也预先写死终点，比再优化任何一行代码都值钱；而且它正面回答了最初的问题"长期、稳定、有利润"——
**如果答案是没有，那就用数据、在确定的日期、给出确定的结论。**

## 6.17 D14 执行清单（11-11 只跑不判）

| 判据 | 数据来源 | 通过条件 | 今日预判 |
|---|---|---|---|
| ① ≥1 次净正完整闭环 | 台账 40 条 + 变现记录 | 单次租约"入账 − 实付 − 变现费" > 0 | ⚠ 白名单 97161 三次 **+$0.1036**，但 n=3、341 分钟、未走完变现 → 严格口径**未达成** |
| ② 捕获回放期望为正 且 P(存活≥30min) ≥ 0.3 | 窗口 episode + 报价快照 | 双源取小密度、pooled 45 TH、roiReq 46.7% | ❌ 差距 1.9× → **确定不过** |
| ③ vast 窗口期整卡供给 ≥2 条 | `countOffers(rentable, whole)` | ≥2 台同型号整卡 | ⚠ 1–7（采样下界），边界 |

**② 一旦不过就够判负**，①③ 只是补充说明。模板：`D14 = FAIL(②) → rentEnabled=false → 只读监测 → 余额 $13 冻结`。

## 6.18 11-07 ~ 11-10 的产出就是五行

每天 09:07 一行，字段固定：

```
D-6 | ALERT=none | scan=ok(0.4m) | anchors=ok(pearl 1.13/autolykos 0.99/kawpow 1.10)
    | funnel: pass=0 watch=N priceLimited=N dataLimited=N | newcoin: BNT d8.3 density=0.0x (需 0.0394)
    | inst=0 bal=13.04 | next=D14
```

**出现 A0/A1 才动手，其余时间不动代码**——包括看到"差一点点"的时候，尤其不动。


## 6.19.0 Clore 的 `wholeCardShare` 恒等 1.00（2026-11-12）

Clore 结构上不提供分数卡（全量 2845 台 `specs.gpu` 全是 `Nx MODEL`，**0 条小数表述**）。
所以它的 `wholeCardShare` **恒等于 1.00**，任何 <0.999 的值都是**我们的解析问题**，不是市场变化。

实测教训：`partial_gpu_rental` 是字符串 `"false"` 时被判进 `unknown`，分母虚增 1163 单元 → share 掉到 **0.583**。
差一点被当成"Clore 的整卡优势在削弱"追几周——而我们在 `wholeCardUnits`、`gpu_name` 匹配、`density` 上各追过一次同类幻影。

规则：
- 缺字段/非真值一律按**整卡**算（`partialFieldMissing` 单独记，作解析完整度指标）；
- `share < 0.999` → `normalizeSuspected=true`，**该值永不进结论**；
- 与 vast 的 0.315 **不可比**（分母里有分数卡），这条不变。

## 6.19.0b `measured_density` 只做交叉校验（2026-11-12）

它比两源高 18–23%，但样本只有 **26.87 机时 / 7 条交付 / share 个位数**：

- **短租约 + 少量 share 有系统性向上的选择偏差**：能快速出 share 的租约才被记进"有交付"那批，慢热的租约常在收回前一个 share 都没有；
- 泊松误差：3 shares 时 **±58%**。

规则：单条租约 **≥30 分钟 且 ≥3 shares** 才计入；**永不做主口径**。主口径仍是 `min(ours, wtm)`（11-12 spread 3.8%，两源已收敛，这个选择是稳的）。

## 6.19.1 告警分级：持续偏差降为字段，只报"变化"（2026-11-09）

连续三天每 2 小时响一次 `spread 15.8%` / `bt +14.1%` —— **一个永远亮着的告警等于没有告警**。

| 类型 | 处理 |
|---|---|
| **可修复的故障**（扫描断档、崩溃、字段缺失、整卡 0 条） | 级别告警，命中即响 |
| **已知的持续偏差**（spread、bt 偏移、密度源差） | 降为**日报字段**；只在**变化 > 3 个百分点**时响一次 |

比的是**变化量**，不是绝对值。"偏差在扩大"才是信号，"偏差存在"是常态。

## 6.19 D14 判决脚本必须先 dry-run（2026-11-06）

`tools/d14-verdict.mjs`：默认 dry-run，只读状态、不写不改。11-07 起每天 09:07 跑一次。

**理由**：我们已经因为"第一次跑就是生产"踩过三次（实验钩子、`med()`、采集断档 41h）。
判定脚本本身出 bug 而没被发现，是最难堪的一种失败。

首次 dry-run 实测（2026-11-06）：`verdict=FAIL(②)`，① PASS（40 条里 4 条正收益，最佳 +$0.0809）、
② FAIL（gap 355%，P(≥30min) 15%）、③ PASS（整卡 2 条，边界）。
