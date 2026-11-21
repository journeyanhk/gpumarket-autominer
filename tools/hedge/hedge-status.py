#!/usr/bin/env python3
# 对冲腿状态（只读）：持仓、入场、标记价、未实现盈亏、已付资金费、与挖矿产出的覆盖比
# 用法：python3 hedge-status.py [--json]
import json, sys, urllib.request, os

ENV = '/data/prl-automine/.secrets/lighter.env'
API = 'https://mainnet.zklighter.elliot.ai/api/v1'
MARKET = 4097

def get(url):
    # 上游抖动容错（2026-11-01）：Lighter 会返回 502/503 + HTML，原来直接抛 HTTPError 让整个脚本崩。
    # 持仓/资金费是巡检必报项，宁可报「不可用」，也不要只留一个 traceback。
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.load(r)
    except Exception as e:
        raise SystemExit(f'⚠ Lighter 不可用（{type(e).__name__}: {getattr(e, "code", "")}）：持仓与资金费本轮无法读取；'
                         f'venueGuard 会把它记为场所降级。上游恢复后自动正常。')

env = {}
for line in open(ENV):
    if '=' in line:
        k, v = line.strip().split('=', 1)
        env[k] = v
acc = int(env['LIGHTER_ACCOUNT_INDEX'])

acc_d = get(f'{API}/account?by=index&value={acc}')['accounts'][0]
coll = float(acc_d.get('collateral') or 0)
avail = float(acc_d.get('available_balance') or 0)
pos = [p for p in acc_d.get('positions', []) if float(p.get('position') or 0) != 0]

book = get(f'{API}/orderBookDetails?market_id={MARKET}')['order_book_details'][0]
mark_bid = None
try:
    ob = get(f'{API}/orderBookOrders?market_id={MARKET}&limit=1')
    mark_bid = float(ob['bids'][0]['price']) if ob.get('bids') else None
    mark_ask = float(ob['asks'][0]['price']) if ob.get('asks') else None
except Exception:
    mark_ask = None

# 挖矿侧产出（读本地控制台）
mine = {}
try:
    st = get('http://127.0.0.1:8290/api/state')
    price = st['market']['price']
    mine = {
        'prl_per_hr': (st['summary']['revenueHr'] or 0) / price if price else 0,
        'prl_per_day': ((st['summary']['revenueHr'] or 0) / price * 24) if price else 0,
        'rigs': len(st['instances']),
        'spot_price': price,
    }
except Exception:
    pass

out = {
    'account': acc,
    'collateral': coll,
    'available': avail,
    'positions': [{'symbol': p.get('symbol'), 'side': 'short' if p.get('sign') == -1 else 'long',
                   'size': p.get('position'), 'entry': p.get('avg_entry_price')} for p in pos],
    'mark_bid': mark_bid, 'mark_ask': mark_ask,
    'market': {'oi': book.get('open_interest'), 'taker_fee': book.get('taker_fee')},
    'mining': mine,
}

if pos:
    p = pos[0]
    size = float(p['position']); entry = float(p['avg_entry_price'])
    sign = -1 if p.get('sign') == -1 else 1
    if mark_ask and sign < 0:
        upnl = (entry - mark_ask) * size
    elif mark_bid and sign > 0:
        upnl = (mark_bid - entry) * size
    else:
        upnl = None
    out['unrealized_pnl_usd'] = round(upnl, 4) if upnl is not None else None
    out['notional_usd'] = round(size * entry, 2)
    out['margin_usd'] = round(coll - avail, 2)
    out['hedge_days'] = round(size / mine['prl_per_day'], 1) if mine.get('prl_per_day') else None

# 资金费（近 24h 累计，年化）与保证金缓冲
try:
    import time
    now = int(time.time())
    fu = get(f'{API}/fundings?market_id={MARKET}&resolution=1h&start_timestamp={now-86400}&end_timestamp={now}&count_back=24')
    rows = fu.get('fundings', [])
    short_pay = sum(float(r['value']) for r in rows if r.get('direction') == 'short')
    long_pay = sum(float(r['value']) for r in rows if r.get('direction') == 'long')
    out['funding'] = {
        'samples': len(rows),
        'short_pays_24h_pct': round(short_pay * 100, 3),
        'long_pays_24h_pct': round(long_pay * 100, 3),
        'net_for_short_24h_pct': round((long_pay - short_pay) * 100, 3),
        'annualized_for_short_pct': round((long_pay - short_pay) / 1 * 365 * 100, 1) if rows else None,
    }
except Exception as e:
    out['funding'] = {'error': str(e)[:80]}

if pos:
    out['margin_initial_pct'] = round(out['margin_usd'] / out['notional_usd'] * 100, 1)
    out['collateral_buffer_pct'] = round(coll / out['notional_usd'] * 100, 1)
    liq_move_pct = (coll / float(pos[0]['position'])) / float(pos[0]['avg_entry_price']) * 100 if float(pos[0]['position']) else None
    out['price_rise_to_liquidation_pct'] = round(liq_move_pct, 1) if liq_move_pct else None

if '--json' in sys.argv:
    print(json.dumps(out, ensure_ascii=False, indent=2))
else:
    print(f"Lighter 对冲：collateral ${coll:.2f}（可用 ${avail:.2f}，占用 ${coll-avail:.2f}）")
    if out['positions']:
        q = out['positions'][0]
        print(f"  持仓 {q['symbol']} {q['side']} {q['size']} @ {q['entry']}｜标记 {mark_bid}/{mark_ask}｜未实现 ${out['unrealized_pnl_usd']}")
        print(f"  名义 ${out['notional_usd']}｜覆盖挖矿 {out['hedge_days']} 天" + (f"（当前 {mine['prl_per_day']:.2f} PRL/天）" if mine else ''))
    else:
        print("  无持仓")
    f = out.get('funding') or {}
    if f.get('samples'):
        print(f"  资金费 24h：空头付 {f['short_pays_24h_pct']}% / 多头付 {f['long_pays_24h_pct']}%（对空头净 {f['net_for_short_24h_pct']:+}%，年化 {f['annualized_for_short_pct']:+}%）")
    if out.get('margin_initial_pct') is not None:
        print(f"  保证金：初始 {out['margin_initial_pct']}% 名义｜账户缓冲 {out['collateral_buffer_pct']}% 名义｜可承受价格上涨 {out['price_rise_to_liquidation_pct']}% 才接近强平")
    if mine:
        print(f"  对照：现货 ${mine['spot_price']}，在跑机器 {mine['rigs']} 台")
    # 裸露空单的触发条件（用户 2026-10-27 约定）：PRL > $2.0 或初始保证金 < 60% → 应减到库存量
    warns = []
    if mine.get('spot_price') and mine['spot_price'] > 2.0 and out.get('positions'):
        warns.append(f"PRL 已 ${mine['spot_price']} > $2.0：按约定应把空单减到与库存/在途匹配")
    # 「保证金 ≥ 名义 50%」在账户层面等价于：账户缓冲 ≤ 200% 名义时才告警
    # （初始保证金率由平台杠杆决定，Lighter 3x 下恒为 ~33%，用它告警会天天误报）
    # 资金费转负且年化差到 −30% 以下：空头从「收费」变成「付费」，对冲的意义窗口缩短
    # （用户 2026-10-27 约定：这是把持仓视野缩短的触发器，不是自动平仓）
    f2 = out.get('funding') or {}
    if f2.get('samples') and f2.get('annualized_for_short_pct') is not None and f2['annualized_for_short_pct'] < -30:
        warns.append(f"资金费对空头年化 {f2['annualized_for_short_pct']:+.1f}% < −30%：空头开始倒贴，按约定缩短持仓视野（币卖掉就平，不再为吃费率续持）")
    if out.get('collateral_buffer_pct') is not None and out['collateral_buffer_pct'] < 200 and float(pos[0]['position']) > 0:
        warns.append(f"账户缓冲 {out['collateral_buffer_pct']}% 名义（<200%，相当于保证金<名义 50%）：追加抵押或减仓")
    for w in warns:
        print('  ⚠ ' + w)