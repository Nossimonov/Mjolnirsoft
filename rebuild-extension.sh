#!/usr/bin/env bash
set -euo pipefail

# Always run from the repo root, regardless of cwd.
cd "$(dirname "${BASH_SOURCE[0]}")"

# Source .local.env without clobbering already-set env vars.
if [ -f .local.env ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [ -z "$key" ] && continue
    if [ -z "${!key+x}" ]; then
      export "$key"="$value"
    fi
  done < .local.env
fi

# Resolve node binary: NODE_BIN → node/node.exe on PATH → common fallback → error.
NODE=""
if [ -n "${NODE_BIN:-}" ]; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE="node"
elif command -v node.exe >/dev/null 2>&1; then
  NODE="node.exe"
elif [ -f "/c/Program Files/nodejs/node.exe" ]; then
  NODE="/c/Program Files/nodejs/node.exe"
else
  echo "Error: cannot find node." >&2
  echo "  Set NODE_BIN in .local.env to the absolute path of node (or node.exe on Windows)." >&2
  echo "  Example: NODE_BIN=/c/Program Files/nodejs/node.exe" >&2
  exit 1
fi

# Type-check the extension workspace before building (mirrors CI's
# `npm run check-types -w extension`). Resolves tsc via Node's module lookup so
# npm need not be on the PATH.
echo "Type-checking extension workspace..."
TSC="$("$NODE" --input-type=commonjs -e "process.stdout.write(require.resolve('typescript/bin/tsc'))")"
"$NODE" "$TSC" --noEmit -p extension/tsconfig.json
echo "Extension workspace type-check passed."
echo ""

# Build from extension/ — esbuild.mjs uses paths relative to that directory.
cd extension
"$NODE" esbuild.mjs "$@"

echo ""
echo "Bundle rebuilt at extension/dist/extension.js."
echo "Reload the VS Code window (Command Palette → Developer: Reload Window) to load the new bundle."
echo "Only newly (re)launched sessions pick up new code or instructions."
