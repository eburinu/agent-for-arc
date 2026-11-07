#!/bin/bash
# Builds dist/claude-for-arc-<version>.zip: everything a friend needs, with the
# server's single dependency (ws) vendored from the lock file so installing
# needs no network and runs no npm scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/extension/manifest.json")"
NAME="claude-for-arc-$VERSION"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)/$NAME"

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "Рабочая копия не чистая — сначала закоммитьте изменения." >&2; exit 1; }

node --test --test-concurrency=1 server/test/ tests/ >/dev/null && node tests/worker.e2e.mjs >/dev/null 2>&1 || { echo "Тесты не прошли." >&2; exit 1; }

mkdir -p "$STAGE/server" "$STAGE/scripts" "$OUT"
git archive HEAD extension | tar -x -C "$STAGE"
git archive HEAD server/server.js server/format.js server/package.json server/package-lock.json | tar -x -C "$STAGE"
git archive HEAD scripts/install.sh scripts/uninstall.sh scripts/desktop-config.js | tar -x -C "$STAGE"
git archive HEAD README.md LICENSE | tar -x -C "$STAGE"
(cd "$STAGE/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

cat > "$STAGE/Установить.command" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")" && bash scripts/install.sh
EOF
chmod +x "$STAGE/Установить.command" "$STAGE/scripts/"*.sh

rm -f "$OUT/$NAME.zip"
(cd "$(dirname "$STAGE")" && zip -qr -X "$OUT/$NAME.zip" "$NAME")
(cd "$OUT" && shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256")
rm -rf "$(dirname "$STAGE")"
echo "Готово: dist/$NAME.zip"
cat "$OUT/$NAME.zip.sha256"
