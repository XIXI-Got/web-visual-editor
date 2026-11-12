@echo off
setlocal
title dsh-ui-editor standalone launcher
set "ROOT=%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)
if "%NODE%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [x] Node.js not found. Please install Node.js 18+ first: https://nodejs.org/
    pause
    exit /b 1
  )
)

set "DIR=%~1"
if not "%DIR%"=="" goto :have_dir
set "DIR=%DIR:"=%"
  echo ============================================
  echo   dsh-ui-editor standalone launcher
  echo ============================================
  echo   Drag a project folder onto this .bat,
  echo   or type a folder path below.
  echo.
  set /p DIR=Project folder: 
:have_dir

if "%DIR%"=="" (
  echo [x] No folder selected.
  pause
  exit /b 1
)
if not exist "%DIR%" (
  echo [x] Folder not found: %DIR%
  pause
  exit /b 1
)

echo.
echo Launching for: %DIR%
echo (Vite projects: dev server will be started automatically)
chcp 65001 >nul 2>nul
echo.
"%NODE%" "%ROOT%tools\standalone\launcher.mjs" --dir "%DIR%" --open
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [x] Launcher exited with code %CODE%. See messages above.
  pause
)
endlocal
exit /b 0
