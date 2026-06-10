#!/usr/bin/env bash
# Build the ThunderSub .xpi for submission to addons.thunderbird.net.
# The xpi is a plain zip with manifest.json at the archive root.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
OUT="dist/thundersub-${VERSION}.xpi"

if command -v zip >/dev/null 2>&1; then
  ZIP=zip
elif command -v nix >/dev/null 2>&1; then
  ZIP="nix run nixpkgs#zip --"
else
  echo "error: need 'zip' (or nix) on PATH" >&2
  exit 1
fi

mkdir -p dist
rm -f "$OUT"
$ZIP -r -X "$OUT" manifest.json background.js popup tab icons
echo "Built $OUT"
