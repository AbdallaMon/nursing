@echo off
setlocal
cd /d "%~dp0"
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 20 or newer, then try again.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core\package.json" (
  echo Installing the local Playwright dependency...
  call npm install
  if errorlevel 1 (
    echo Installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
