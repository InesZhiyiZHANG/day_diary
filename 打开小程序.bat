@echo off
setlocal
set "APP=%~dp0index.html"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo 没有找到 Microsoft Edge，请先安装 Edge，或右键 index.html 选择浏览器打开。
  pause
  exit /b 1
)
start "" "%EDGE%" "%APP%"
