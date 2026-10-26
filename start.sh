#!/usr/bin/env bash
# macOS / Linux 一键启动：有 Node.js 22+ 就直接用，没有就下载便携版到 ./runtime/node（不安装到系统）
set -e
cd "$(dirname "$0")"

node_ok() { command -v "$1" >/dev/null 2>&1 && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }

NODE=""
if [ -x runtime/node/bin/node ]; then NODE="runtime/node/bin/node"
elif node_ok node; then NODE="node"
else
  case "$(uname -s)" in Darwin) os=darwin; ext=tar.gz;; Linux) os=linux; ext=tar.xz;; *) echo "不支持的系统，请手动安装 Node.js 22+"; exit 1;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo "不支持的 CPU 架构 $(uname -m)"; exit 1;; esac
  echo "没有找到 Node.js 22+，正在下载便携版到 runtime/ ..."
  # 可以用环境变量 NODE_MIRROR 指定自己的下载源（目录里要有 SHASUMS256.txt）
  for base in ${NODE_MIRROR:-} https://nodejs.org/dist/latest-v24.x/ https://cdn.npmmirror.com/binaries/node/latest-v24.x/ https://nodejs.org/dist/latest-v22.x/ https://cdn.npmmirror.com/binaries/node/latest-v22.x/; do
    line=$(curl -fsSL --max-time 30 "${base}SHASUMS256.txt" 2>/dev/null | grep -E " node-v[0-9.]+-${os}-${arch}\.${ext}$" | head -1) || true
    [ -n "$line" ] || { echo "  $base 不可用，换下一个"; continue; }
    hash=${line%% *}; file=${line##* }
    tmp=$(mktemp -d)
    echo "  下载 $file ..."
    if curl -fL --progress-bar --max-time 900 -o "$tmp/$file" "$base$file"; then
      got=$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$file" || shasum -a 256 "$tmp/$file") | cut -d' ' -f1)
      if [ "$got" = "$hash" ]; then
        rm -rf runtime/node && mkdir -p runtime && tar -xf "$tmp/$file" -C runtime && mv "runtime/${file%.$ext}" runtime/node
        rm -rf "$tmp"; NODE="runtime/node/bin/node"; echo "  Node.js 已就绪：$file"; break
      fi
      echo "  SHA256 校验不通过，换下一个下载源"
    fi
    rm -rf "$tmp"
  done
  [ -n "$NODE" ] || { echo "下载失败，请到 https://nodejs.org 安装 Node.js 22+ 后重试"; exit 1; }
fi
exec "$NODE" server.js
