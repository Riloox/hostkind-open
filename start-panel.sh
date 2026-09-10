#!/usr/bin/env bash
# ============================================================
#  Hostkind - Minecraft server panel launcher (Linux / macOS)
#  Run ./start-panel.sh to start the web panel.
#
#  Checks the dependencies the panel needs and offers to install
#  any that are missing, then builds the frontend and starts the
#  server. Set FLEETDECK_AUTO_INSTALL=1 to install missing deps
#  without prompting, or FLEETDECK_NO_INSTALL=1 to never install.
#  Set FLEETDECK_SKIP_BUILD=1 to serve the existing bundle.
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

# Installed binary mode: the stable launcher owns version selection and
# restart/update handoff. Source checkouts have no launcher and use Node below.
BINARY_LAUNCHER="${HOSTKIND_LAUNCHER_PATH:-}"
if [ -z "$BINARY_LAUNCHER" ]; then BINARY_LAUNCHER="$PWD/hostkind-launcher"; fi
if [ -x "$BINARY_LAUNCHER" ]; then
  exec "$BINARY_LAUNCHER" "$@"
fi

PORT="${FLEETDECK_PORT:-${LODESTONE_PORT:-2121}}"

# ---------------------------------------------------------------------------
# Package-manager detection + dependency helpers
# ---------------------------------------------------------------------------
PM=""              # apt | dnf | pacman | zypper | brew
PM_INSTALL=""      # command prefix to install a package
detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then PM="apt";    PM_INSTALL="sudo apt-get install -y";
  elif command -v dnf  >/dev/null 2>&1; then PM="dnf";     PM_INSTALL="sudo dnf install -y";
  elif command -v pacman >/dev/null 2>&1; then PM="pacman"; PM_INSTALL="sudo pacman -S --noconfirm";
  elif command -v zypper >/dev/null 2>&1; then PM="zypper"; PM_INSTALL="sudo zypper install -y";
  elif command -v brew >/dev/null 2>&1; then PM="brew";     PM_INSTALL="brew install";
  fi
}

# Map a logical dependency to the package name for the detected manager.
pkg_name() {
  local dep="$1"
  case "$dep" in
    node)   case "$PM" in apt) echo nodejs;; dnf) echo nodejs;; pacman) echo nodejs;; zypper) echo nodejs;; brew) echo node;; esac;;
    npm)    case "$PM" in apt) echo npm;; dnf) echo npm;; pacman) echo npm;; zypper) echo npm;; brew) echo node;; esac;;
  esac
}

# Ask the user (default yes) unless overridden by env flags.
confirm_install() {
  local what="$1"
  [ "${FLEETDECK_NO_INSTALL:-${LODESTONE_NO_INSTALL:-0}}" = "1" ] && return 1
  [ "${FLEETDECK_AUTO_INSTALL:-${LODESTONE_AUTO_INSTALL:-0}}" = "1" ] && return 0
  printf "  Install %s now? [Y/n] " "$what"
  read -r ans || ans=""
  case "$ans" in [nN]*) return 1;; *) return 0;; esac
}

# Try to install a logical dependency via the detected package manager.
install_dep() {
  local dep="$1"
  if [ -z "$PM" ]; then
    echo "  No supported package manager found (apt/dnf/pacman/zypper/brew)."
    echo "  Please install '$dep' manually, then re-run this script."
    return 1
  fi
  local pkg; pkg="$(pkg_name "$dep")"
  if [ -z "$pkg" ]; then
    echo "  Don't know the package name for '$dep' on $PM; install it manually."
    return 1
  fi
  echo "  Installing '$pkg' via $PM ..."
  if [ "$PM" = "apt" ]; then sudo apt-get update -qq || true; fi
  # shellcheck disable=SC2086
  $PM_INSTALL "$pkg"
}

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

echo "Checking dependencies..."
detect_pm
[ -n "$PM" ] && echo "  Package manager: $PM" || echo "  No known package manager detected."

# --- Node.js (>=22) - required by the SQLite foundation ---
if ! command -v node >/dev/null 2>&1; then
  echo "[MISSING] Node.js is not installed (need version 22 or newer)."
  if confirm_install "Node.js"; then install_dep node || true; fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is still not available. Install Node 22+ from https://nodejs.org/ and retry."
  exit 1
fi
if [ "$(node_major)" -lt 22 ] 2>/dev/null; then
  echo "[ERROR] Node $(node -v) is unsupported. Hostkind requires Node.js 22+ for its SQLite foundation."
  echo "        Install a current Node LTS release, then re-run this launcher."
  exit 1
fi

# --- npm - required to install deps and build ---
if ! command -v npm >/dev/null 2>&1; then
  echo "[MISSING] npm is not installed."
  if confirm_install "npm"; then install_dep npm || true; fi
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm is still not available. Install it (usually shipped with Node.js) and retry."
  exit 1
fi
# Java is NOT checked here: the panel downloads and manages the correct Java
# runtime per Minecraft version itself (see runtimes/ in the panel folder).
echo

# ---------------------------------------------------------------------------
# Install node deps / build / config / launch
# ---------------------------------------------------------------------------

# --- Install dependencies the first time (if node_modules is missing) ---
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies with npm..."
  if ! npm install; then
    echo "[ERROR] npm install failed. Check your internet connection."
    exit 1
  fi
fi

# Native addons must be rebuilt after changing Node.js versions.
if ! node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()" >/dev/null 2>&1; then
  echo "Rebuilding the SQLite module for Node $(node -v)..."
  npm rebuild better-sqlite3 || {
    echo "[ERROR] Could not rebuild better-sqlite3 for Node $(node -v)."
    exit 1
  }
fi

# --- Build the frontend on every launch so source edits always take effect ---
if [ "${FLEETDECK_SKIP_BUILD:-${LODESTONE_SKIP_BUILD:-0}}" = "1" ]; then
  echo "Skipping frontend build (FLEETDECK_SKIP_BUILD=1)."
else
  echo "Building frontend..."
  if ! npm run build; then
    echo "[ERROR] Frontend build failed. Check the output above for details."
    exit 1
  fi
fi

# --- Seed config.json from the template on first run (never overwrite an existing one) ---
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    echo "First run: creating config.json from config.example.json..."
    cp config.example.json config.json
    echo "Edit config.json to change the password, port, etc., then restart the panel."
    echo
  else
    echo "[ERROR] Neither config.json nor config.example.json were found."
    echo "Re-download the panel files or restore config.example.json next to start-panel.sh."
    exit 1
  fi
fi

# --- Free the port if a previous panel instance is still holding it ---
# Prefer lsof (macOS ships it; most Linux distros have it); fall back to
# fuser or ss so the launcher works where lsof is absent.
OLD_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  OLD_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  OLD_PIDS="$(fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\n' || true)"
elif command -v ss >/dev/null 2>&1; then
  OLD_PIDS="$(ss -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { gsub(/.*pid=/, "", $NF); gsub(/,.*/, "", $NF); print $NF }' || true)"
fi
if [ -n "$OLD_PIDS" ]; then
  echo "Stopping previous panel instance (PID $OLD_PIDS)..."
  # shellcheck disable=SC2086
  kill $OLD_PIDS 2>/dev/null || true
  # Wait for the port to actually be released; a listener that is only
  # SIGTERM'd lingers briefly and would otherwise make the new server exit
  # with EADDRINUSE.
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
    echo "[ERROR] Port $PORT is still in use after stopping the previous panel."
    exit 1
  }
fi

echo
echo "Starting Hostkind panel..."
echo "Open http://localhost:$PORT in your browser (default port)."
echo "Press Ctrl+C to stop the panel."
echo

exec node server.js
