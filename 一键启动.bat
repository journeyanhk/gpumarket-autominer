@echo off
chcp 65001 >nul
title PRL 自动租卡挖矿控制台
cd /d "%~dp0"

rem 优先用本文件夹里自动下载的便携版 Node.js
if exist "runtime\node\node.exe" goto use_portable

rem 其次用电脑上已安装的 Node.js（需要 22 或以上）
where node >nul 2>nul
if errorlevel 1 goto install
set "NODEMAJOR="
for /f "tokens=1 delims=v." %%a in ('node -v') do set "NODEMAJOR=%%a"
if not defined NODEMAJOR goto install
if %NODEMAJOR% LSS 22 goto install
set "NODE_EXE=node"
goto run

:install
echo.
echo  没有找到 Node.js 22 或以上版本，正在自动下载便携版...
echo  只放在本文件夹的 runtime 目录里，不会安装到系统，也不需要管理员权限。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1"
if not exist "runtime\node\node.exe" (
  echo.
  echo  自动下载失败。请到 https://nodejs.org 下载安装 LTS 版 Node.js，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

:use_portable
set "NODE_EXE=%~dp0runtime\node\node.exe"

:run
"%NODE_EXE%" server.js
echo.
echo  程序已退出。如果上面有报错，请截图发到 Issues。
pause
