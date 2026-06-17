#!/usr/bin/env bash
# Mjolnirsoft first-run setup.
#
# Validates required tooling, installs dependencies, and scaffolds local config.
# Runs in Git Bash on Windows and in POSIX shells on Linux/macOS:
#
#   ./setup.sh
#
# Testing/automation hooks (not for normal use):
#   SETUP_ROOT=<dir>          operate against <dir> instead of the repo root
#   SETUP_DRY_RUN=1           announce the install step instead of running it
#   SETUP_PRETEND_MISSING="node npm"   treat the listed commands as absent
set -euo pipefail

REPO_ROOT="${SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

info() { printf '  %s\n' "$1"; }
ok()   { printf '\xe2\x9c\x93 %s\n' "$1"; }
err()  { printf '\xe2\x9c\x97 %s\n' "$1" >&2; }

# --- 1. Validate required dependencies -------------------------------------
missing=0
for cmd in node npm; do
  pretend_missing=0
  for m in ${SETUP_PRETEND_MISSING:-}; do
    [ "$m" = "$cmd" ] && pretend_missing=1
  done
  if [ "$pretend_missing" -eq 1 ] || ! command -v "$cmd" >/dev/null 2>&1; then
    err "Required dependency not found: $cmd"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  err ""
  err "Install Node.js LTS (it bundles npm), then re-run ./setup.sh:"
  err "  Windows:  winget install OpenJS.NodeJS.LTS"
  err "  macOS:    brew install node"
  err "  Any OS:   https://nodejs.org/en/download"
  exit 1
fi
ok "Required tooling present (node $(node --version), npm $(npm --version))"

# --- 2. Install project dependencies ---------------------------------------
if [ -f "$REPO_ROOT/package-lock.json" ]; then
  install_cmd="npm ci"
else
  install_cmd="npm install"
fi
if [ "${SETUP_DRY_RUN:-0}" = "1" ]; then
  info "[dry-run] would run: $install_cmd"
else
  ( cd "$REPO_ROOT" && $install_cmd )
  ok "Dependencies installed ($install_cmd)"
fi

# --- 3. Scaffold local config ----------------------------------------------
local_env="$REPO_ROOT/.local.env"
example_env="$REPO_ROOT/.local.env.example"
if [ -f "$local_env" ]; then
  info ".local.env already exists — leaving it untouched"
elif [ -f "$example_env" ]; then
  cp "$example_env" "$local_env"
  ok "Created .local.env from .local.env.example"
else
  err ".local.env.example missing — cannot scaffold .local.env"
  exit 1
fi

ok "Setup complete."
