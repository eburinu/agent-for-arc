#!/bin/bash
# claude-for-arc installer for macOS.
#
# Copies the extension and server to ~/claude-for-arc (or $CFA_HOME), creates
# the connection key, registers the MCP server with Claude, then walks you
# through loading the extension into Arc. Safe to run again to update.
set -euo pipefail

NAME="claude-for-arc"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${CFA_HOME:-$HOME/claude-for-arc}"
DATA="$HOME/Library/Application Support/$NAME"
INTERACTIVE=0
[ -t 0 ] && [ -t 1 ] && INTERACTIVE=1

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask "question" -> 0 for yes
  [ "$INTERACTIVE" = 1 ] || return 1
  local reply; read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[YyДд] ]]
}
pause() { [ "$INTERACTIVE" = 1 ] && read -r -p "$1" _ || true; }

[ "$(uname -s)" = "Darwin" ] || die "этот установщик работает только на macOS."

step "1/5 Проверяю Node.js"
NODE="${CFA_NODE:-}"
if [ -z "$NODE" ]; then
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
[ -n "$NODE" ] || die "не найден Node.js. Установите LTS-версию с https://nodejs.org и запустите установщик снова."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "нужен Node.js 18 или новее, а установлен $("$NODE" -v)."
say "Node.js $("$NODE" -v): $NODE"
case "$NODE" in
  "$HOME"/.nvm/*|"$HOME"/.fnm/*|"$HOME"/.volta/*)
    say "Внимание: Node.js установлен через менеджер версий. Если удалите эту версию, запустите установщик снова." ;;
esac
[ -d "/Applications/Arc.app" ] || say "Внимание: Arc не найден в /Applications. Расширение можно поставить и позже."

step "2/5 Копирую файлы в $DEST"
if [ -e "$DEST" ] && [ ! -f "$DEST/.claude-for-arc" ]; then
  die "папка $DEST уже есть и это не claude-for-arc. Переименуйте её или задайте другую: CFA_HOME=/путь bash $0"
fi
if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST/scripts"
  rsync -a --delete "$SRC/extension/" "$DEST/extension/"
  rsync -a --delete --exclude test/ "$SRC/server/" "$DEST/server/"
  cp "$SRC/scripts/uninstall.sh" "$SRC/scripts/doctor.sh" "$SRC/scripts/desktop-config.js" "$DEST/scripts/"
  cp "$SRC/LICENSE" "$SRC/README.md" "$DEST/"
fi
touch "$DEST/.claude-for-arc"
if [ ! -f "$DEST/server/node_modules/ws/package.json" ]; then
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="$(command -v npm || true)"
  [ -n "$NPM" ] || die "в папке нет зависимостей сервера, а npm не найден."
  say "Устанавливаю зависимость сервера (ws) по lock-файлу…"
  (cd "$DEST/server" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
fi

step "3/5 Ключ подключения"
mkdir -p "$DATA"
chmod 700 "$DATA"
if [ ! -s "$DATA/token" ]; then
  (umask 077; "$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex") + "\n")' > "$DATA/token")
  say "Создан новый ключ: $DATA/token"
else
  say "Оставляю существующий ключ: $DATA/token"
fi
chmod 600 "$DATA/token"
TOKEN="$(tr -d '\n' < "$DATA/token")"
# The extension picks the key up from its own folder; no pasting needed.
(umask 077; printf '{"token":"%s"}\n' "$TOKEN" > "$DEST/extension/key.json")

# The server must start and answer an MCP handshake before Claude is told about it.
SMOKE_PORT=$(( 49152 + RANDOM % 10000 ))
SMOKE="$( { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; sleep 1; } \
  | CFA_PORT="$SMOKE_PORT" "$NODE" "$DEST/server/server.js" 2>/dev/null || true)"
case "$SMOKE" in
  *'"claude-for-arc"'*) say "Сервер запускается и отвечает." ;;
  *) die "сервер не запустился. Попробуйте вручную: $NODE $DEST/server/server.js" ;;
esac

step "4/5 Подключаю к Claude"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
  "$CLAUDE_BIN" mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
  "$CLAUDE_BIN" mcp add --scope user "$NAME" -- "$NODE" "$DEST/server/server.js" >/dev/null
  say "Добавлено в Claude Code (вкладка Code в приложении Claude)."
else
  say "Не нашёл Claude Code. Если пользуетесь им, добавьте сервер вручную:"
  say "  claude mcp add --scope user $NAME -- \"$NODE\" \"$DEST/server/server.js\""
fi

if ask "Подключить ещё и к обычному чату Claude (вкладка Chat)?"; then
  if ps -axo comm= | grep -x "/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null; then
    say "Приложение Claude открыто — оно может перезаписать настройки чата."
    pause "Закройте Claude полностью (⌘Q) и нажмите Enter… "
  fi
  "$NODE" "$DEST/scripts/desktop-config.js" add "$NODE" "$DEST/server/server.js" \
    || say "Чат не подключён. Закройте Claude (⌘Q) и запустите установщик снова."
fi

step "5/5 Расширение в Arc"
say "1. Откройте в Arc адрес arc://extensions и включите «Режим разработчика» (Developer mode)."
say "2. Нажмите «Загрузить распакованное» (Load unpacked) и выберите папку:"
say "     $DEST/extension"
say "   Сейчас откроется Finder с этой папкой — её можно перетащить в окно выбора."
open -R "$DEST/extension" 2>/dev/null || true
pause "Нажмите Enter, когда расширение появится в Arc… "

say "3. Ключ подключения уже лежит в папке расширения, вставлять его не нужно."
say "4. Начните НОВУЮ сессию во вкладке Code приложения Claude — появятся инструменты"
say "   claude-for-arc, а расширение покажет «Подключено». Сессии, открытые до установки,"
say "   сервер не запускают."
say ""
say "Если расширение пишет «Сервер не запущен»: bash \"$DEST/scripts/doctor.sh\""
say ""
say "Удаление: bash \"$DEST/scripts/uninstall.sh\""
