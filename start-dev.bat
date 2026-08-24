@echo off
REM ============================================================
REM  Hostkind - DEVELOPMENT launcher (Windows)
REM  Runs the backend + the Vite dev server with hot reload.
REM  Edit anything under src/ and the browser updates instantly,
REM  no rebuild and no panel restart needed.
REM
REM  For normal use (built bundle, single port) use start-panel.bat.
REM ============================================================

REM Move to the folder where this .bat lives (handles spaces and "N").
cd /d "%~dp0"

title Hostkind Dev

REM --- Determine the backend port (env override, else the default 2121) ---
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
    echo Edit config.json to change the password, port, etc., then restart.
    echo.
  ) else (
    echo [ERROR] Neither config.json nor config.example.json were found.
    echo Re-download the panel files or restore config.example.json next to this script.
    pause
    exit /b 1
  )
)

REM --- Kill any previous backend instance still holding the port ---
call :kill_port "%PORT%"

echo.
echo Starting Hostkind backend ^(port %PORT%^) in a separate window...
start "Hostkind Backend" cmd /c node server.js

echo Starting Vite dev server with hot reload...
echo Open http://localhost:5173 in your browser ^(it should open automatically^).
echo Frontend changes under src/ reload instantly.
echo.
echo IMPORTANT: closing THIS window stops Vite AND the backend (the port
echo sweep on exit kills the backend so no orphaned server is left behind).
echo.

call npm run dev -- --open

echo.
echo The Vite dev server stopped. Stopping the backend...
call :kill_port "%PORT%"

echo.
echo Both stopped. Press a key to close this window.
pause >nul
exit /b 0

REM ------------------------------------------------------------------
REM  Kill any process LISTENING on the given port, IPv4 or IPv6.
REM  Retries until the port is actually free (a killed process can take
REM  a moment to release it, and node would otherwise fail with
REM  EADDRINUSE). Usage: call :kill_port "PORT"
REM ------------------------------------------------------------------
:kill_port
set "KILLPORT=%~1"
for /l %%i in (1,1,10) do (
  set "FOUND="
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%KILLPORT% "') do (
    echo Stopping previous backend instance ^(PID %%p^)...
    taskkill /f /pid %%p >nul 2>nul
    set "FOUND=1"
  )
  if not defined FOUND goto :killport_done
  timeout /t 1 /nobreak >nul
)
:killport_done
exit /b 0
