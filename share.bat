@echo off
chcp 65001 > nul
cd /d %~dp0
title 신공학관 내비게이션 - 인터넷 공유

where cloudflared > nul 2> nul
if errorlevel 1 (
  echo [안내] cloudflared가 없습니다. 아래 명령을 한 번만 실행한 뒤, 창을 닫고 다시 실행하세요.
  echo        winget install --id Cloudflare.cloudflared
  pause
  exit /b
)

if not exist node_modules (
  echo [1/3] 처음 실행이라 npm install 진행 중...
  call npm install
)

echo [2/3] 서버 시작 (새 창)
start "내비게이션 서버" cmd /k node server.js
timeout /t 3 > nul

echo [3/3] 인터넷 주소 만드는 중...
echo.
echo  아래에 나오는 https://xxxx.trycloudflare.com 주소를 다른 사람에게 보내세요.
echo  이 창과 서버 창을 닫으면 공유가 끝납니다.
echo.
cloudflared tunnel --url http://localhost:3001
