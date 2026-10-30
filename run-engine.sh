#!/bin/sh
# 控制台守护（零依赖）：进程退出 3 秒内拉起，并把退出码/时间写进 engine-exits.log。
#
# 为什么不用 systemd/pm2（2026-10-30 实测本机）：PID 1 是 init，没有 systemctl；也没有 pm2。
# 而 pm2 自己的守护进程同样会随工作区重启消失，还要多装一套依赖。
# 这个脚本的边界也要说清楚：
#   · 它能扛「node 进程崩溃 / 被 OOM kill / 未捕获异常」→ 秒级拉起；
#   · 它扛不住「整个工作区/容器重启」——那种情况只有平台侧定时任务能兜底
#     （巡检发现 8290 不可达 → 拉起守护脚本）。
#
# 用法：setsid nohup /data/gpumarket-autominer/run-engine.sh >> /data/prl-automine/supervisor.log 2>&1 &
set -u

APP=/data/gpumarket-autominer
LOG=/data/prl-automine/engine.log
EXITS=/data/prl-automine/engine-exits.log
NODE=/opt/memoh/toolkit/node-glibc/bin/node
BACKOFF=3

restarts=0
window_start=$(date +%s)

cd "$APP" || exit 1
echo "[$(date -u +%FT%TZ)] supervisor start (pid $$)" >> "$EXITS"

while :; do
  start=$(date +%s)
  PRL_NO_BROWSER=1 "$NODE" server.js >> "$LOG" 2>&1
  code=$?
  end=$(date +%s)
  ran=$((end - start))

  # 上次尝试前 10 分钟内启动次数过多 → 退避，避免崩溃风暴把日志刷爆
  now=$(date +%s)
  if [ $((now - window_start)) -gt 600 ]; then restarts=0; window_start=$now; fi
  restarts=$((restarts + 1))

  tail_n=$(tail -n 3 "$LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-300)
  echo "[$(date -u +%FT%TZ)] server.js exited code=$code after ${ran}s (restart #$restarts in window) last: $tail_n" >> "$EXITS"

  if [ "$restarts" -ge 10 ]; then
    echo "[$(date -u +%FT%TZ)] 10 次重启/10 分钟 → 退避 60s（疑似持续性故障，请看 engine-crash.log）" >> "$EXITS"
    sleep 60
    restarts=0; window_start=$(date +%s)
  else
    sleep "$BACKOFF"
  fi
done