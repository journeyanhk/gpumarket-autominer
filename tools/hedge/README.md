# 对冲与出金（hedge / exit）脚本

**这组脚本不进自动决策链路**：它们只在"要把 PRL 卖掉 / 要把空头平掉"时由人手动执行，或由巡检任务只读调用。

## 前提：密钥放在仓库外

所有脚本从 `/data/prl-automine/.secrets/` 读取，**仓库里没有任何 key**：

```
.secrets/gate.env      → GATE_API_KEY=…  GATE_API_SECRET=…
.secrets/lighter.env   → LIGHTER_API_PRIVATE_KEY=…  LIGHTER_ACCOUNT_INDEX=…  LIGHTER_API_KEY_INDEX=…
```

`.gitignore` 已屏蔽 `.secrets/`、`*.env`、`credentials*.txt`。**不要把 key 写进脚本或配置文件。**

## 六个脚本

| 脚本 | 作用 | 是否动钱 |
|---|---|---|
| `hedge-status.py` | 只读：Lighter collateral / 持仓 / 资金费 24h | 否 |
| `swap-policy.mjs` | 只读：给定价差，算"该换还是该等"（含手续费与最小成交额） | 否 |
| `gate-deposit.mjs` | 把链上 PRL 存进 Gate（SOL 链） | 转账 |
| `watch-gate.mjs` | 只读：等 Gate 到账 | 否 |
| `sell-and-close.mjs` | 在 Gate 市价卖出 PRL，并按净额平掉 Lighter 空头 | **是** |
| `lighter-close.py` | 只平 Lighter 空头（不动现货） | **是** |

## 用法

```bash
python3 tools/hedge/hedge-status.py                 # 先看状态
node    tools/hedge/swap-policy.mjs --price 2.31    # 再算政策
node    tools/hedge/sell-and-close.mjs --dry-run    # 干跑，不提交
node    tools/hedge/sell-and-close.mjs --live       # 真卖（需 --live 才动手）
```

## 三条硬约束（踩过坑，写死）

1. **`--dry-run` 是默认**：不带 `--live` 一律只打印计划，不提交任何订单；
2. **卖出量取 `min(现货, 空头名义)`**：只卖能对冲掉的那部分，避免裸多/裸空；
3. **Gate 的最小成交额是 $3（`min_quote_amount`）**，不是 1 PRL——`$2.31` 时 1 PRL 只值 $2.31，卖不出去。这个门槛会随币价变化，脚本里用 `min_base/min_quote` 双条件判断。

## 与主程序的关系

- 主程序（`src/`）负责"租不租"，这组脚本负责"卖不卖"；
- 两者**共享同一份 `.secrets`**，但主程序只读 Gate 的余额接口，不持有下单权限。
