#!/bin/bash
# Builds dist/claude-for-arc-<version>.mcpb: the server as a Claude desktop
# extension. Double-clicking it installs claude-for-arc into the Claude app
# (Chat and the Code tab), which runs it on its own built-in Node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/mcpb/manifest.json")"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)/claude-for-arc"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "Рабочая копия не чистая — сначала закоммитьте изменения." >&2; exit 1; }
for f in extension/manifest.json server/package.json; do
  v="$(node -p 'require(process.argv[1]).version' "$ROOT/$f")"
  [ "$v" = "$VERSION" ] || { echo "Версия в $f ($v) не совпадает с mcpb/manifest.json ($VERSION)." >&2; exit 1; }
done

mkdir -p "$STAGE/server" "$OUT"
cp mcpb/manifest.json LICENSE "$STAGE/"
cp mcpb/icon.png "$STAGE/icon.png"
cp server/server.js server/format.js server/deploy.js server/package.json server/package-lock.json "$STAGE/server/"
git archive HEAD extension | tar -x -C "$STAGE"
rm -f "$STAGE/extension/key.json"
(cd "$STAGE/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

npx -y @anthropic-ai/mcpb@2.1.2 validate "$STAGE/manifest.json"
rm -f "$OUT/claude-for-arc-$VERSION.mcpb"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT/claude-for-arc-$VERSION.mcpb"
# Fixed name for the release asset, so .../releases/latest/download/claude-for-arc.mcpb always works.
cp "$OUT/claude-for-arc-$VERSION.mcpb" "$OUT/claude-for-arc.mcpb"
(cd "$OUT" && shasum -a 256 "claude-for-arc-$VERSION.mcpb" > "claude-for-arc-$VERSION.mcpb.sha256")
echo "Готово: dist/claude-for-arc-$VERSION.mcpb"
