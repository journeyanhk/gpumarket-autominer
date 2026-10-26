# 下载便携版 Node.js 到本程序的 runtime\node 目录（不安装到系统、不改环境变量、不需要管理员权限）
# 由「一键启动.bat」在电脑上没有 Node.js 22+ 时自动调用；下载后用官方 SHA256 校验
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 关闭进度条，否则 Windows PowerShell 下载会慢很多
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { '' }
if (-not $arch) { Write-Host '需要 64 位 Windows（Windows 10 / 11）'; exit 1 }

# 官方源在前，国内镜像在后；先试 24 LTS，再试 22 LTS
$sources = @(
  'https://nodejs.org/dist/latest-v24.x/',
  'https://cdn.npmmirror.com/binaries/node/latest-v24.x/',
  'https://nodejs.org/dist/latest-v22.x/',
  'https://cdn.npmmirror.com/binaries/node/latest-v22.x/'
)

# 可以用环境变量 NODE_MIRROR 指定自己的下载源（目录里要有 SHASUMS256.txt）
if ($env:NODE_MIRROR) { $sources = @($env:NODE_MIRROR) + $sources }

foreach ($base in $sources) {
  try {
    Write-Host "  读取版本信息：$base"
    $sums = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri ($base + 'SHASUMS256.txt')
    $text = if ($sums.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($sums.Content) } else { [string]$sums.Content }
    $line = ($text -split "`n") | Where-Object { $_ -match "\snode-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw '没找到 Windows 安装包' }
    $parts = $line.Trim() -split '\s+'
    $hash = $parts[0].ToLower(); $file = $parts[1]
    $zip = Join-Path $env:TEMP $file
    Write-Host "  下载 $file（约 30 MB）..."
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri ($base + $file) -OutFile $zip
    $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $hash) { Remove-Item $zip -Force; throw 'SHA256 校验不通过（文件不完整或被篡改）' }
    Write-Host '  校验通过，解压中...'
    $tmp = Join-Path $runtime '_unpack'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    $dest = Join-Path $runtime 'node'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $inner.FullName $dest
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "  Node.js 已就绪：$file"
    exit 0
  } catch {
    Write-Host "  失败：$($_.Exception.Message)，换下一个下载源"
  }
}
Write-Host '  所有下载源都失败了。请检查网络，或到 https://nodejs.org 手动安装 Node.js（LTS 版）后再双击一键启动。'
exit 1
