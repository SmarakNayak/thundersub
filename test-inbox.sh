#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

THUNDERSUB_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/thundersub-test-inbox.XXXXXX")"
THUNDERSUB_TEST_PROFILE="$THUNDERSUB_TEST_DIR/profile"
THUNDERSUB_TEST_KEEP=false
THUNDERSUB_TEST_SERVER_PID=""

if [[ "${1:-}" == "--keep" ]]; then
  THUNDERSUB_TEST_KEEP=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: bash test-inbox.sh [--keep]" >&2
  exit 2
fi

cleanup() {
  if [[ -n "$THUNDERSUB_TEST_SERVER_PID" ]]; then
    kill "$THUNDERSUB_TEST_SERVER_PID" 2>/dev/null || true
    wait "$THUNDERSUB_TEST_SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$THUNDERSUB_TEST_KEEP" == true ]]; then
    echo "Test profile kept at: $THUNDERSUB_TEST_PROFILE"
  else
    case "$THUNDERSUB_TEST_DIR" in
      "${TMPDIR:-/tmp}"/thundersub-test-inbox.*) rm -rf -- "$THUNDERSUB_TEST_DIR" ;;
      *) echo "Refusing to remove unexpected path: $THUNDERSUB_TEST_DIR" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

THUNDERBIRD_BIN="${THUNDERBIRD_BIN:-$(command -v thunderbird || true)}"
if [[ -z "$THUNDERBIRD_BIN" ]]; then
  echo "Thunderbird was not found. Set THUNDERBIRD_BIN to its executable." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  NODE=(node)
elif command -v nix >/dev/null 2>&1; then
  NODE=(nix shell nixpkgs#nodejs --command node)
else
  echo "Node.js was not found (and nix is unavailable)." >&2
  exit 1
fi

bash build.sh
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)"

mkdir -p "$THUNDERSUB_TEST_PROFILE/extensions"
cp -R test-inbox/profile/. "$THUNDERSUB_TEST_PROFILE/"

# Give only this isolated build the manifest marker which enables loopback HTTP.
TEST_XPI="$THUNDERSUB_TEST_DIR/thundersub-test-inbox.xpi"
TEST_MANIFEST_DIR="$THUNDERSUB_TEST_DIR/test-manifest"
mkdir -p "$TEST_MANIFEST_DIR"
cp "dist/thundersub-$VERSION.xpi" "$TEST_XPI"
sed 's/"name": "ThunderSub"/"name": "ThunderSub Test Inbox"/' manifest.json \
  > "$TEST_MANIFEST_DIR/manifest.json"
(
  cd "$TEST_MANIFEST_DIR"
  if command -v zip >/dev/null 2>&1; then
    zip -q -X "$TEST_XPI" manifest.json
  else
    nix run nixpkgs#zip -- -q -X "$TEST_XPI" manifest.json
  fi
)
cp "$TEST_XPI" "$THUNDERSUB_TEST_PROFILE/extensions/thundersub@smaraknayak.xpi"

"${NODE[@]}" test-inbox/server.mjs &
THUNDERSUB_TEST_SERVER_PID=$!
sleep 0.2
if ! kill -0 "$THUNDERSUB_TEST_SERVER_PID" 2>/dev/null; then
  wait "$THUNDERSUB_TEST_SERVER_PID" || true
  echo "Failed to start the test server on 127.0.0.1:8765." >&2
  exit 1
fi

echo "Opening isolated ThunderSub test inbox"
echo "Profile: $THUNDERSUB_TEST_PROFILE"
echo "Test server: http://127.0.0.1:8765"
"$THUNDERBIRD_BIN" --no-remote --profile "$THUNDERSUB_TEST_PROFILE"
