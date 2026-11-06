// 预注册常量（2026-11-06 用户判定：判决词必须在情绪之外写死，12-31 那天只跑脚本）
export const TERMINATION_STATEMENT =
  '已验证：在 2026 Q4 的市场条件下，云端租算力挖矿不存在正期望。' +
  '证据：40 条租约净 −$0.57；42 币全灭表最优差 1.9×；两个市场 gap 分别 249% 与 2.2–9.1×；供给约束仅存在于 vast。';

// 新币监测命中时的预注册动作（防止"当场凭兴奋决定租几台"）
export const TRIGGER_ACTION = {
  machines: 1,
  hours: 1,
  hardCapUsd: 2,
  autoRenew: false,
  record: ['deliveredTh', 'credited', 'oom', 'reclaimed'],
  cooldownHours: 24,
  note: '触发即执行，不讨论；24h 内不做第二次',
};

export const TERMINATION_DEADLINE = '2026-12-31';
export const NEWCOIN_REQUIRE_DAYS = 3;   // 连续 3 天达标才算"出现标的"
