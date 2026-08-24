@echo off
REM ============================================================
REM  Hostkind - Minecraft server panel launcher (Windows)
REM  Double-click this file to start the web panel.
REM ============================================================

REM Move to the folder where this .bat lives (handles spaces and "N").
cd /d "%~dp0"

title Hostkind Panel

REM --- Determine the panel port (env override, else the default 2121) ---
set "PORT=2121"
if defined FLEETDECK_PORT set "PORT=%FLEETDECK_PORT%"
if defined LODESTONE_PORT set "PORT=%LODESTONE_PORT%"

REM --- Check Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Install it from https://nodejs.org/ ^(LTS, version 22 or newer^) and try again.
  echo.
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
  echo [ERROR] Node.js %NODE_MAJOR% is unsupported. Hostkind requires Node.js 22+ for its SQLite foundation.
  echo Install a current Node LTS release, then re-run this launcher.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH. Reinstall Node.js with npm included.
  echo.
  pause
  exit /b 1
)

REM --- Install dependencies the first time (if node_modules is missing) ---
if not exist "node_modules" (
  echo First run: installing dependencies with npm...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

REM --- Rebuild the native SQLite addon after a Node.js upgrade ---
node -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()" >nul 2>nul
if errorlevel 1 (
  echo Rebuilding the SQLite module for Node.js...
  call npm rebuild better-sqlite3
  if errorlevel 1 (
    echo [ERROR] Could not rebuild better-sqlite3 for this Node.js version.
    pause
    exit /b 1
  )
)

REM --- Build the frontend on every launch so source edits always take effect ---
REM  (Set FLEETDECK_SKIP_BUILD=1 before running to skip and serve the existing bundle.)
if "%FLEETDECK_SKIP_BUILD%"=="1" (
  echo Skipping frontend build ^(FLEETDECK_SKIP_BUILD=1^).
) else (
  echo Building frontend...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Frontend build failed. Check the output above for details.
    pause
    exit /b 1
  )
)

REM --- Seed config.json from the template on first run (never overwrite an existing one) ---
if not exist "config.json" (
  if exist "config.example.json" (
    echo First run: creating config.json from config.example.json...
    copy /y "config.example.json" "config.json" >nul
    if errorlevel 1 (
      echo [ERROR] Failed to create config.json. Check folder permissions.
      pause
      exit /b 1
    )
    echo Edit config.json to change the password, port, etc., then restart the panel.
    echo.
  ) else (
    echo [ERROR] Neither config.json nor config.example.json were found.
    echo Re-download the panel files or restore config.example.json next to start-panel.bat.
    pause
    exit /b 1
  )
)

REM --- Kill any previous panel instance still holding the port ---
REM netstat shows the listener as 0.0.0.0:PORT (IPv4) or [::]:PORT (IPv6),
REM so match any LISTENING line whose local address ends in ":PORT ". Retry
REM until the port is actually free; a killed process can take a moment to
REM release it and would otherwise make the new server exit with EADDRINUSE.
for /l %%i in (1,1,10) do (
  set "FOUND="
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
    echo Stopping previous panel instance ^(PID %%p^)...
    taskkill /f /pid %%p >nul 2>nul
    set "FOUND=1"
  )
  if not defined FOUND goto portfree
  timeout /t 1 /nobreak >nul
)
:portfree

echo.
echo Starting Hostkind panel...
echo Open http://localhost:%PORT% in your browser ^(default port^).
echo Press Ctrl+C in this window to stop the panel.
echo.

node server.js

echo.
echo The panel stopped. Press a key to close this window.
pause >nul
