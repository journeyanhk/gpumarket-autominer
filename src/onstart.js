// 生成 GPU 机器开机自动执行的脚本：按矿池选矿工 → 下载解压 → 守护进程挖矿（崩溃自动重启）
// 矿工名 = v + vast 实例号，控制端靠它把矿池算力对应到每台机器
// cnFirst：国内机器连 GitHub 基本不通，先走镜像源，省掉等待超时的时间
//
// 多矿池 + 热切换：
//   租的时候把所有已配置钱包的矿池参数都写进脚本；机器每分钟用 vast 给每台机器自带的
//   CONTAINER_API_KEY 读一次自己的标签，标签里的 pool=xxx 就是要挖的矿池。
//   控制端改标签 → 机器 1 分钟内停掉矿工、改连新矿池，不用重启机器。
// 脚本版本 4：每个矿池可以用不同的矿工（Pearlhash 用 WildRig，Kryptex 用 SRBMiner），用到时才下载。
// 与 v3 的区别：每个候选包在解压前必须通过 miners/manifest.json 里 pin 的 sha256；
// 所有源都失败就拒绝启动矿工（宁可挖不到，也不执行来路不明的二进制）。
export const SCRIPT_VERSION = 5;

const SAFE = /^[A-Za-z0-9@=.:/_$+,-]+$/; // 写进脚本的参数只允许这些字符，防止注入

// foreground：args 启动模式下脚本就是容器的主进程，最后要一直挂在前台（否则容器会退出）
export function buildOnstart({ pools, def, miners, extraArgs = '', cnFirst = false, foreground = false }) {
  if (!pools?.length) throw new Error('没有可用的矿池（钱包未填写）');
  if (!pools.some(p => p.id === def)) def = pools[0].id;
  // 矿工必须是清单里 pin 过的版本：没有 pin 就直接拒绝租用（不是降级，是拒绝）
  for (const p of pools) {
    const bin = p.bin || 'wr';
    const m = miners?.[bin];
    if (!m) throw new Error(`矿工 ${bin} 没有 pin 版本（miners/manifest.json）`);
    if (!/^[a-f0-9]{64}$/.test(String(m.sha256 || ''))) throw new Error(`矿工 ${bin} 的 sha256 不合法`);
    if (!/^https:\/\/[^\s'"]+$/.test(String(m.url || ''))) throw new Error(`矿工 ${bin} 的下载地址不合法`);
    if (!/^[A-Za-z0-9._-]+$/.test(String(m.exec || ''))) throw new Error(`矿工 ${bin} 的可执行文件名不合法`);
    if (!/^[a-z]+$/.test(p.id) || !p.cmd.split(' ').every(a => SAFE.test(a))) throw new Error(`矿池 ${p.id} 参数含有不允许的字符`);
  }
  if (extraArgs && !extraArgs.split(/\s+/).every(a => !a || /^[A-Za-z0-9=._,:-]+$/.test(a))) throw new Error('矿工额外参数含有不允许的字符');
  const bins = [...new Set(pools.map(p => p.bin || 'wr'))];
  const mirrorList = url => {
    const proxied = [`https://ghfast.top/${url}`, `https://gh-proxy.com/${url}`, `https://ghproxy.net/${url}`];
    return (cnFirst ? [...proxied, url] : [url, ...proxied]).map(u => `'${u}'`).join(' ');
  };
  const LOGFN = [
    // 写进 boot.log，同时写到容器主输出（/proc/1/fd/1），这样 vast 的「机器日志」里能看到每一步
    'out(){ m=$(cat); echo "$m" >> /root/prl/boot.log; { echo "$m" > /proc/1/fd/1; } 2>/dev/null; true; }',
    'log(){ echo "[prl] $(date +%T) $*" | out; }',
  ];
  return [
    '#!/bin/bash',
    'mkdir -p /root/prl && cd /root/prl',
    ...LOGFN,
    // vast 的环境变量在不同启动方式下位置不同：当前环境 → 1 号进程 → /etc/environment
    'envget(){ v="$(printenv "$1")"; [ -n "$v" ] || v="$(tr \'\\0\' \'\\n\' < /proc/1/environ 2>/dev/null | grep "^$1=" | head -1 | cut -d= -f2-)"; [ -n "$v" ] || v="$(grep "^$1=" /etc/environment 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')"; echo "$v"; }',
    'ID=$(envget CONTAINER_ID); [ -n "$ID" ] || ID=$(hostname | tr -cd 0-9)',
    'KEY=$(envget CONTAINER_API_KEY)',
    'W=v$ID',
    'rm -f /root/prl/.lbl',
    'log "worker=$W gpu=$(nvidia-smi --query-gpu=name,power.limit --format=csv,noheader 2>&1 | head -2 | tr \'\\n\' \';\')"',
    'printf "ID=\'%s\'\\nKEY=\'%s\'\\nW=\'%s\'\\n" "$ID" "$KEY" "$W" > rig.env && chmod 600 rig.env',
    "cat > pools.sh <<'EOF'",
    `DEF='${def}'`,
    ...LOGFN,
    // 每个矿池用哪个矿工、完整参数（$W 在机器上展开成矿工名）
    'pool_bin(){ case "$1" in',
    ...pools.map(p => `  ${p.id}) echo ${p.bin || 'wr'};;`),
    '  *) return 1;; esac; }',
    'pool_cmd(){ case "$1" in',
    ...pools.map(p => `  ${p.id}) echo "${p.bin || 'wr'} ${p.cmd}${(p.bin || 'wr') === 'wr' && extraArgs ? ' ' + extraArgs : ''}";;`),
    '  *) return 1;; esac; }',
    // 矿工不存在就下载：每个源最多等 15 秒连上、3 分钟下完，失败立刻换下一个
    'ensure(){ b=$1; [ -x /root/prl/$b ] && return 0; case "$b" in',
    ...bins.map(b => `  ${b}) F=${miners[b].exec}; SHA=${miners[b].sha256}; URLS="${mirrorList(miners[b].url).replace(/'/g, '')}";;`),
    '  *) return 1;; esac',
    '  command -v sha256sum >/dev/null 2>&1 || { log "sha256sum not available, refusing to run an unpinned miner"; return 1; }',
    // 所有下载源同时下，谁先下完用谁（有些机器访问 GitHub 只有一两百 KB/s，顺序重试要白等好几分钟）
    '  D=/root/prl/dl-$b; rm -rf $D; mkdir -p $D; T0=$(date +%s); i=0; PIDS=""',
    '  log "download $b from $(echo $URLS | wc -w) sources in parallel"',
    '  for U in $URLS; do i=$((i+1)); ( (curl -fsSL --connect-timeout 15 --max-time 300 -o $D/$i.part "$U" || wget -q -T 15 -t 1 -O $D/$i.part "$U") && [ "$(sha256sum "$D/$i.part" 2>/dev/null | cut -d" " -f1)" = "$SHA" ] && tar -tf $D/$i.part >/dev/null 2>&1 && mv $D/$i.part $D/ok-$i.tar ) & PIDS="$PIDS $!"; done',
    '  G=""; while :; do G=$(ls $D/ok-*.tar 2>/dev/null | head -1); [ -n "$G" ] && break; A=0; for p in $PIDS; do kill -0 $p 2>/dev/null && A=1; done; [ $A = 0 ] && break; [ $(( $(date +%s) - T0 )) -gt 320 ] && break; sleep 1; done',
    '  for p in $PIDS; do kill $p 2>/dev/null; done; pkill -f "$D/" 2>/dev/null',
    '  if [ -n "$G" ]; then N=${G##*ok-}; N=${N%.tar}; log "downloaded $b in $(( $(date +%s) - T0 ))s from $(echo $URLS | cut -d" " -f$N)"; rm -rf /root/prl/pkg-$b && mkdir -p /root/prl/pkg-$b && tar -xf "$G" -C /root/prl/pkg-$b; fi',
    '  rm -rf $D',
    '  B=$(find /root/prl/pkg-$b -name "$F" -type f | head -1)',
    '  [ -n "$B" ] || { log "DOWNLOAD FAILED $b（没有下载源通过 sha256 校验）"; return 1; }',
    '  chmod +x "$B" && ln -sf "$B" /root/prl/$b && log "miner ready: $b $(timeout 8 /root/prl/$b --version 2>&1 | grep -v "^ *#" | grep -m1 -i -E "[0-9]+\\.[0-9]+")"; }',
    'EOF',
    "cat > run.sh <<'EOF'",
    'cd /root/prl',
    '. ./rig.env; . ./pools.sh',
    // 读自己的标签，取出 pool=xxx；读不到就返回空（继续挖当前矿池）
    'want(){',
    '  [ -n "$KEY" ] || { [ -f .lbl ] || { log "label-api: no CONTAINER_API_KEY, pool switching disabled"; touch .lbl; }; return 1; }',
    '  R=$(curl -s --max-time 15 -w "\\n%{http_code}" -H "Authorization: Bearer $KEY" "https://console.vast.ai/api/v0/instances/$ID/?owner=me" 2>/dev/null)',
    '  C=$(echo "$R" | tail -n1)',
    '  P=$(echo "$R" | grep -o \'"label": *"[^"]*"\' | head -1 | grep -o \'pool=[a-z]*\' | cut -d= -f2)',
    '  [ -f .lbl ] || { log "label-api: http=$C pool=${P:-none}"; touch .lbl; }',
    '  [ -n "$P" ] && pool_cmd "$P" >/dev/null && echo "$P"',
    '}',
    'killminers(){ pkill -9 -f "/root/prl/(wr|srb) " 2>/dev/null || for p in /proc/[0-9]*; do grep -qaE "/root/prl/(wr|srb)" $p/cmdline 2>/dev/null && kill -9 ${p#/proc/} 2>/dev/null; done; }',
    'dump(){ { echo "[prl] $(date +%T) miner exited, last output:"; tail -n 8 /root/prl/miner.log; echo "[prl] restart in 10s"; } | out; }',
    // 每次启动 90 秒后把矿工最近的输出打到机器日志里（能看到是否连上矿池、有没有提交份额）
    'peek(){ ( sleep 90; { echo "[prl] $(date +%T) miner output ($1):"; tail -n 14 /root/prl/miner.log | grep -v "^ *#*$" | cut -c1-200; } | out ) & }',
    'start(){ echo "$cur" > pool.cur; log "mining on $cur ($(pool_bin "$cur"))"; ( while true; do ensure "$(pool_bin "$cur")" || { sleep 30; continue; }; /root/prl/$(pool_cmd "$cur") >> /root/prl/miner.log 2>&1; dump; sleep 10; done ) & MP=$!; peek "$cur"; ( while true; do sleep 600; peek "$cur"; done ) & PP=$!; }',
    'cur=$(want); [ -n "$cur" ] || cur=$(cat pool.cur 2>/dev/null); pool_cmd "$cur" >/dev/null 2>&1 || cur=$DEF',
    'start',
    'while true; do',
    '  sleep 60',
    '  w=$(want)',
    '  if [ -n "$w" ] && [ "$w" != "$cur" ]; then log "switch pool $cur -> $w"; kill $MP $PP 2>/dev/null; killminers; sleep 2; cur=$w; start; fi',
    'done',
    'EOF',
    ...(foreground ? ['log "started (args mode)"', 'exec bash run.sh'] : ['nohup bash run.sh > /dev/null 2>&1 &', 'log "started"']),
  ].join('\n');
}

export const workerName = id => `v${id}`;
