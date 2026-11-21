#!/usr/bin/env python3
"""Lighter 减仓工具：把 PRL 空单 reduce-only 市价买回到目标数量。

为什么要单独一个脚本：sell-and-close.mjs 只负责 Gate 侧，没有 Lighter 下单路径；
而"对冲超配"需要能独立减仓（不是平光），所以这里只做 reduce-only 的【买入】。

用法：
  python3 lighter-close.py                 # 只打印计划（dry run）
  python3 lighter-close.py --target 3.0 --live
  python3 lighter-close.py --target 3.0 --live --slippage 0.005

安全约束：
  - 只允许 reduce_only=True 的买入（不会把空单做成多单）；
  - 目标 >= 0，且不会超过当前空单量；
  - 下单后轮询持仓确认，打印成交价与手续费。
"""
import asyncio
import json
import os
import random
import sys
import time
import urllib.request

API = 'https://mainnet.zklighter.elliot.ai/api/v1'
HOST = 'https://mainnet.zklighter.elliot.ai'
MARKET = 4097          # PRL 永续
SIZE_DEC = 2           # 数量精度：0.01 PRL
ENV_FILE = '/data/prl-automine/.secrets/lighter.env'


def load_env(path):
    out = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.strip()] = v.strip()
    return out


def get(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read().decode())


def account_state(acc_index):
    d = get(f'{API}/account?by=index&value={acc_index}')['accounts'][0]
    pos = [p for p in (d.get('positions') or []) if int(p.get('market_id', -1)) == MARKET]
    short = 0.0
    entry = None
    for p in pos:
        # Lighter 的 position 字段是绝对值，方向在 sign 里（-1 = 空）
        size = float(p.get('position') or 0) * (int(p.get('sign') or 1))
        if size < 0:                     # 负仓 = 空头
            short += -size
            entry = float(p.get('avg_entry_price') or 0) or entry
    return {
        'collateral': float(d.get('collateral') or 0),
        'short': round(short, SIZE_DEC),
        'entry': entry,
    }


def arg(name, default=None, cast=float):
    if name in sys.argv:
        i = sys.argv.index(name)
        return cast(sys.argv[i + 1])
    return default


async def main():
    env = load_env(ENV_FILE)
    acc = int(env['LIGHTER_ACCOUNT_INDEX'])
    key_idx = int(env['LIGHTER_API_KEY_INDEX'])
    key = env['LIGHTER_API_PRIVATE_KEY']
    target = arg('--target', 0.0)
    slippage = arg('--slippage', 0.005)
    live = '--live' in sys.argv

    st = account_state(acc)
    delta = round(st['short'] - target, SIZE_DEC)
    print(f"当前：空单 {st['short']} PRL @ {st['entry']}｜保证金 ${st['collateral']:.2f}")
    print(f"目标：{target} PRL｜需买回 {delta} PRL（reduce-only 市价，滑点上限 {slippage*100:.2f}%）")
    if delta <= 0:
        print('无需减仓（当前空单已 <= 目标）')
        return 0
    if target < 0:
        print('目标为负，拒绝执行')
        return 2
    if not live:
        print('[dry] 未发送订单；加 --live 才会真正下单')
        return 0

    from lighter import SignerClient
    client = SignerClient(url=HOST, account_index=acc, api_private_keys={key_idx: key})
    err = client.check_client()   # 同步方法
    if err:
        print('check_client 失败:', err)
        return 3

    amount = int(round(delta * 10 ** SIZE_DEC))
    tx, resp, err = await client.create_market_order_limited_slippage(
        market_index=MARKET,
        client_order_index=random.randint(1, 2 ** 31 - 1),
        base_amount=amount,
        max_slippage=slippage,
        is_ask=False,        # 买入
        reduce_only=True,    # 只减仓，不会反手做多
        api_key_index=key_idx,
    )
    if err:
        print('下单失败:', err)
        return 4
    print('已提交:', getattr(resp, 'tx_hash', None) or resp)

    for _ in range(12):
        await asyncio.sleep(2)
        now = account_state(acc)
        if now['short'] <= target + 1e-9:
            print(f"成交确认：空单 {st['short']} → {now['short']} PRL，保证金 ${now['collateral']:.2f}")
            return 0
    now = account_state(acc)
    print(f"未完全成交：空单现在 {now['short']} PRL（目标 {target}），请稍后再查")
    return 5


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))