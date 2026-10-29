#!/usr/bin/env bash
# Builds dist/kerio-mcp-installer.zip for Windows users.
# Usage: installer/build.sh [mail-server-host]
# The host (for example mail.example.com) is stored only in the package, never in the repository;
# without it the installer asks for the server address.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:-}"
OUT=dist/kerio-mcp-installer

rm -rf dist
mkdir -p "$OUT/app/installer"
cp server.js package.json package-lock.json "$OUT/app/"
cp -r src "$OUT/app/src"
cp installer/setup.js installer/get-node.ps1 installer/uninstall.bat "$OUT/app/installer/"
cp installer/install.bat "$OUT/install.bat"
cp installer/INSTALL.txt "$OUT/INSTALL.txt"
(cd "$OUT/app" && npm ci --omit=dev --no-audit --no-fund --silent)
if [ -n "$HOST" ]; then
  printf '{\n  "host": "%s"\n}\n' "$HOST" > "$OUT/app/installer/defaults.json"
fi
(cd dist && zip -qr kerio-mcp-installer.zip kerio-mcp-installer)
echo "Built $(pwd)/dist/kerio-mcp-installer.zip ($(du -h dist/kerio-mcp-installer.zip | cut -f1))"
