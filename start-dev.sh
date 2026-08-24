#!/usr/bin/env bash
# ============================================================
#  Hostkind - DEVELOPMENT launcher (Linux / macOS)
#  Runs the backend + the Vite dev server with hot reload.
#  Edit anything under src/ and the browser updates instantly,
#  no rebuild and no panel restart needed.
#
#  For normal use (built bundle, single port) use start-panel.sh.
#  Same dependency-check env flags as start-panel.sh apply
#  (FLEETDECK_AUTO_INSTALL / FLEETDECK_NO_INSTALL).
# ============================================================
set -euo pipefail

# Move to the folder where this script lives (handles spaces and "ñ").
# `readlink -f` is GNU-only; fall back to a portable cd+pwd when unavailable
# (macOS ships BSD readlink, which has no -f flag).
SCRIPT_SRC="${BASH_SOURCE[0]:-$0}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$SCRIPT_SRC" >/dev/null 2>&1; then
  cd "$(dirname "$(readlink -f "$SCRIPT_SRC")")"
else
  cd "$(dirname "$SCRIPT_SRC")" && cd "$(pwd -P)"
fi

PORT="${FLEETDECK_PORT:-${LODESTONE_PORT:-2121}}"

# ---------------------------------------------------------------------------
# Package-manager detection + dependency helpers (kept in sync with start-panel.sh)
# ---------------------------------------------------------------------------
PM=""
PM_INSTALL=""
detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then PM="apt";    PM_INSTALL="sudo apt-get install -y";
  elif command -v dnf  >/dev/null 2>&1; then PM="dnf";     PM_INSTALL="sudo dnf install -y";
  elif command -v pacman >/dev/null 2>&1; then PM="pacman"; PM_INSTALL="sudo pacman -S --noconfirm";
  elif command -v zypper >/dev/null 2>&1; then PM="zypper"; PM_INSTALL="sudo zypper install -y";
  elif command -v brew >/dev/null 2>&1; then PM="brew";     PM_INSTALL="brew install";
  fi
}
pkg_name() {
  local dep="$1"
  case "$dep" in
    node)   case "$PM" in apt) echo nodejs;; dnf) echo nodejs;; pacman) echo nodejs;; zypper) echo nodejs;; brew) echo node;; esac;;
    npm)    case "$PM" in apt) echo npm;; dnf) echo npm;; pacman) echo npm;; zypper) echo npm;; brew) echo node;; esac;;
  esac
}
confirm_install() {
  local what="$1"
  [ "${FLEETDECK_NO_INSTALL:-${LODESTONE_NO_INSTALL:-0}}" = "1" ] && return 1
  [ "${FLEETDECK_AUTO_INSTALL:-${LODESTONE_AUTO_INSTALL:-0}}" = "1" ] && return 0
  printf "  Install %s now? [Y/n] " "$what"
  read -r ans || ans=""
  case "$ans" in [nN]*) return 1;; *) return 0;; esac
}
install_dep() {
  local dep="$1"
  if [ -z "$PM" ]; then
    echo "  No supported package manager found; install '$dep' manually and re-run."
    return 1
  fi
  local pkg; pkg="$(pkg_name "$dep")"
  [ -z "$pkg" ] && { echo "  Don't know the package name for '$dep' on $PM."; return 1; }
  echo "  Installing '$pkg' via $PM ..."
  [ "$PM" = "apt" ] && { sudo apt-get update -qq || true; }
  # shellcheck disable=SC2086
  $PM_INSTALL "$pkg"
}
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

echo "Checking dependencies..."
detect_pm
[ -n "$PM" ] && echo "  Package manager: $PM" || echo "  No known package manager detected."

if ! command -v node >/dev/null 2>&1; then
  echo "[MISSING] Node.js is not installed (need version 22 or newer)."
  if confirm_install "Node.js"; then install_dep node || true; fi
fi
command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js still not available. Install Node 22+ and retry."; exit 1; }
if [ "$(node_major)" -lt 22 ] 2>/dev/null; then
  echo "[ERROR] Node $(node -v) is unsupported. Hostkind requires Node.js 22+ for its SQLite foundation."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[MISSING] npm is not installed."
  if confirm_install "npm"; then install_dep npm || true; fi
fi
command -v npm >/dev/null 2>&1 || { echo "[ERROR] npm still not available. Install it and retry."; exit 1; }
# Java is NOT checked here: the panel downloads and manages the correct Java
# runtime per Minecraft version itself (see runtimes/ in the panel folder).
echo

# --- Install dependencies the first time (if node_modules is missing) ---
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies with npm..."
  npm install || { echo "[ERROR] npm install failed. Check your internet connection."; exit 1; }
fi

# Native addons are tied to the Node.js ABI. A Node upgrade or switching Node
# installations can leave better-sqlite3 present but unloadable.
if ! sh -c 'node -e "const Database = require('\''better-sqlite3'\''); const db = new Database('\'':memory:'\''); db.close()"' >/dev/null 2>&1; then
  echo "Rebuilding the SQLite module for Node $(node -v)..."
  npm rebuild better-sqlite3 || {
    echo "[ERROR] Could not rebuild better-sqlite3 for Node $(node -v)."
    exit 1
  }
fi

# --- Seed config.json from the template on first run (never overwrite an existing one) ---
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    echo "First run: creating config.json from config.example.json..."
    cp config.example.json config.json
    echo "Edit config.json to change the password, port, etc., then restart."
    echo
  else
    echo "[ERROR] Neither config.json nor config.example.json were found."
    exit 1
  fi
fi

# --- Free the port if a previous backend instance is still holding it ---
# Prefer lsof; fall back to fuser or ss so the launcher works without lsof.
OLD_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  OLD_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  OLD_PIDS="$(fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\n' || true)"
elif command -v ss >/dev/null 2>&1; then
  OLD_PIDS="$(ss -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { gsub(/.*pid=/, "", $NF); gsub(/,.*/, "", $NF); print $NF }' || true)"
fi
if [ -n "$OLD_PIDS" ]; then
  echo "Stopping previous backend instance (PID $OLD_PIDS)..."
  # shellcheck disable=SC2086
  kill $OLD_PIDS 2>/dev/null || true
  for _ in {1..50}; do
    REMAINING=""
    if command -v lsof >/dev/null 2>&1; then
      REMAINING="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    elif command -v fuser >/dev/null 2>&1; then
      REMAINING="$(fuser "$PORT/tcp" 2>/dev/null || true)"
    elif command -v ss >/dev/null 2>&1; then
      REMAINING="$(ss -tln 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { print $NF }' || true)"
    fi
    [ -z "$REMAINING" ] && break
    sleep 0.1
  done
  [ -z "${REMAINING:-}" ] || {
    echo "[ERROR] Port $PORT is still in use after stopping the previous backend."
    exit 1
  }
fi

# --- Start the backend in the background, then Vite in the foreground ---
echo
echo "Starting Hostkind backend (port $PORT)..."
node server.js &
BACKEND_PID=$!
# Stop the backend when this script exits (Ctrl+C on Vite), and also on
# SIGINT/SIGTERM so the backend is never left orphaned behind a killed script.
cleanup() {
  echo
  echo "Stopping backend (PID $BACKEND_PID)..."
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Vite dev server with hot reload..."
echo "Open http://localhost:5173 in your browser (it should open automatically)."
echo "Frontend changes under src/ reload instantly. Press Ctrl+C to stop both."
echo

npm run dev -- --open
