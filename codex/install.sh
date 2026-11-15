#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) ARCH=arm64 ;;
  Darwin:x86_64) ARCH=x64 ;;
  *) echo "This installer requires macOS." >&2; exit 1 ;;
esac
exec "$ROOT/runtime/$ARCH/node" "$ROOT/install.cjs" "$@"
