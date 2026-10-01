@echo off
rem Double-click to start the EXPERIMENTAL 3D Globe extension server for Tableau Desktop.
rem Keep the window open while you use the extension; close it to stop the server.
title 3D Globe EXPERIMENTAL - Tableau extension server
cd /d "%~dp0globe-viz-experimental"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

rem Don't start a second copy if the server is already running.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo The experimental globe server is already running at http://localhost:8766
  echo You can use the extension in Tableau now.
  echo.
  pause
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo Starting the EXPERIMENTAL 3D Globe server at http://localhost:8766
echo Keep this window open while you use the extension in Tableau.
echo Close this window to stop the server.
echo.
call npm run dev

echo.
echo The server stopped.
pause
