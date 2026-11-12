@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title dsh-ui-editor demo

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)

echo ============================================
echo   dsh-ui-editor demo
echo   opens the web workbench with demo/ project
echo   (Ctrl+C to stop)
echo ============================================
echo.

node "tools\standalone\launcher.mjs" --dir "demo" --port 19391 --open
if errorlevel 1 (
  echo.
  echo [x] Launch failed. See messages above.
  pause
)
endlocal
exit /b 0
