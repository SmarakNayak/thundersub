#!/usr/bin/env bash
# Regenerate the ATN listing screenshots by rendering the real tab UI
# (tab/tab.html + tab.css + tab.js, unmodified) in headless Chromium with
# mock.js stubbing the browser.runtime backend with demo data.
set -euo pipefail
cd "$(dirname "$0")"

if command -v chromium >/dev/null 2>&1; then
  CHROMIUM=chromium
elif command -v nix >/dev/null 2>&1; then
  CHROMIUM="nix run nixpkgs#chromium --"
else
  echo "error: need chromium (or nix) on PATH" >&2
  exit 1
fi

HARNESS=$(mktemp -d)
trap 'rm -rf "$HARNESS"' EXIT
cp ../../tab/tab.css ../../tab/tab.js mock.js "$HARNESS/"
sed 's|<script src="tab.js"></script>|<script src="mock.js"></script>\n<script src="tab.js"></script>|' \
  ../../tab/tab.html > "$HARNESS/tab.html"

shoot() { # $1 = scenario, $2 = output file
  $CHROMIUM --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1600,1000 \
    --virtual-time-budget=8000 --run-all-compositor-stages-before-draw \
    --screenshot="$PWD/$2" "file://$HARNESS/tab.html?shot=$1" 2>/dev/null
  echo "captured $2"
}

shoot dashboard    01-dashboard.png
shoot modal        02-unsubscribe-modal.png
shoot scan         03-scan-progress.png
shoot unsubscribed 04-unsubscribed.png
