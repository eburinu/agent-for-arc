#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) ARCH=arm64 ;;
  Darwin:x86_64) ARCH=x64 ;;
  *) echo "Agent for Arc: this installer requires macOS." >&2; exit 1 ;;
esac
RUNTIME="$ROOT/runtime/$ARCH/node"
if [ ! -x "$RUNTIME" ]; then
  echo "Agent for Arc: bundled Node.js is missing. Extract the complete Codex release ZIP and run install.sh again." >&2
  exit 1
fi
exec "$RUNTIME" "$ROOT/install.cjs" "$@"
