#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
NODE_VERSION=v24.18.0
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
STAGE="$BUILD/claude-for-arc-codex"
mkdir -p "$STAGE/server" "$STAGE/extension" "$OUT"
OUT="$(cd "$OUT" && pwd)"

cp "$ROOT"/server/{server.js,format.js,deploy.js,package.json,package-lock.json} "$STAGE/server/"
cp "$ROOT/codex/install.sh" "$ROOT/codex/install.cjs" "$ROOT/LICENSE" "$STAGE/"
rsync -a --exclude /key.json "$ROOT/extension/" "$STAGE/extension/"
(cd "$STAGE/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

# The checksum values come from the signed list on the official release page:
# https://nodejs.org/en/blog/release/v24.18.0
for ARCH in arm64 x64; do
  case "$ARCH" in
    arm64) SHA=e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1 ;;
    x64) SHA=dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080 ;;
  esac
  NAME="node-$NODE_VERSION-darwin-$ARCH"
  ARCHIVE="${CFA_NODE_ARCHIVES:-$BUILD}/$NAME.tar.gz"
  if [ ! -f "$ARCHIVE" ]; then
    curl --fail --silent --show-error --location "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.gz" -o "$ARCHIVE"
  fi
  ACTUAL="$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)"
  [ "$ACTUAL" = "$SHA" ] || { echo "Invalid checksum for $NAME" >&2; exit 1; }
  DEST="$STAGE/runtime/$ARCH"
  mkdir -p "$DEST"
  tar -xzf "$ARCHIVE" -C "$DEST" --strip-components 2 "$NAME/bin/node"
  tar -xOzf "$ARCHIVE" "$NAME/LICENSE" > "$STAGE/NODE-LICENSE"
done

(cd "$BUILD" && zip -qr claude-for-arc-codex.zip claude-for-arc-codex)
mv "$BUILD/claude-for-arc-codex.zip" "$OUT/"
(cd "$OUT" && shasum -a 256 claude-for-arc-codex.zip > claude-for-arc-codex.zip.sha256)
echo "$OUT/claude-for-arc-codex.zip"
