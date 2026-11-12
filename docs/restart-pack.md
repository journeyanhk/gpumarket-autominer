# 重启包（2027 年市场变了怎么在 30 分钟内重新开动）

> 写给**别人**看的，不是写给写它的人看的。任何一步都需要能独立执行。

## 0. 一句话背景

2026-10-27 ~ 11-11，我们在 vast/Clore 上验证了「云端租算力挖 Pearl(PRL)」：
**40 条租约，best +$0.0702、median −$0.0115、mean −$0.0161、合计 −$0.6450；判据②（回放期望）差 264%。**
结论不是"我们不会做"，是"当时那个市场不存在正期望"。详见 `docs/d14-archive.md`。

## 1. 四个数字的推导（不要重新发明）

| 数 | 值 | 来源 |
|---|---|---|
| `roiReq` | **46.7%** | `(targetProfitPct 20% + deployPct 3.33%) ÷ P 0.5`；P 是房东存活概率 |
| 门槛乘数 | **1.467** | `1 + roiReq/100`：收入必须 ≥ 租金 × 1.467 |
| `needDensity` | `bid × 1.467 × 24 ÷ th` | 与 `isRentable` 同源，不许另写一份 |
| `th` | **pooled 口径**（无整卡样本时 = `min(规格×0.6, 台账实测比×规格)`） | `expectedDeliveredTh` |

## 2. 三条必须重新验证的东西

1. **密度双源取小**：`pricing = min(ours, wtm)`。单源会系统性高估 19%（实测密度 0.0215 vs 我们 0.0174）。
2. **锚点表**：`node tools/unit-anchor-check.mjs`，三个锚点 ratio 必须都在 `[0.8,1.25]`；`etchash/firopow/fishhash/karlsen/cuckatoo32` 仍是 pending，**用这些算法的币只能 watch**。
3. **整卡口径**：`frac ≥ 0.99` 且 `fracKnown`；`bidFrom.offerId` 必须是整卡报价。半卡价折整卡会让门槛虚低一半。

## 3. 开关在哪

```
/data/gpumarket-autominer/data/config.json → autoRent
   false = 只读监测（当前）｜true = 允许自动下单
   改法：POST /api/settings {"autoRent":true}   ← 建议先 false→观察一天→再 true
```

其余门槛：`targetProfitPct / pSurviveDefault / deployCostMin / maxHourlySpend / dailyFailBudget`。

## 4. 重新开动的最小步骤（30 分钟）

```bash
cd /data/gpumarket-autominer
node tools/unit-anchor-check.mjs          # 1. 锚点必须全 ok
node tools/triggers.mjs                   # 2. 看 T4 阈值与 bid 出处
node tools/m3-funnel.mjs --live           # 3. 看 pass 是否 > 0
# 4. pass>0 才动钱：1 台 / 1 小时 / ≤$2（TRIGGER_ACTION）
curl -X POST 127.0.0.1:8290/api/settings -d '{"autoRent":true}' -H 'content-type: application/json'
```

**判据：`pass > 0` 才允许开 `autoRent`。`pass = 0` 时开它等于把钱交给概率。**

## 5. 别再犯的五个错（每个都花了钱）

1. 用"看起来合理"的派生数下结论（`0.0533`、`2786<2845`、`0.582`）——**比例进结论前必须能打印分子分母**；
2. 拿尾部价当市场（`$0.0499` vs 中位 7.3×）；
3. 用记忆里的量级质疑实测（RVN 4–5 TH/s 是 2021 年的数）；
4. 单位换算手打（48 MH/s 写成 0.048 TH/s，差 10⁶）；
5. 让一个偏差字段每 2 小时响一次——**永远亮着的告警等于没有告警**。

## 6. 一句话结论

**在 2026 Q4 的市场条件下，云端租算力挖矿不存在正期望。**（`src/m3/constants.js → TERMINATION_STATEMENT`）
