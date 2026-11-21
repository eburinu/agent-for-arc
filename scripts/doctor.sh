#!/bin/bash
# Agent for Arc diagnostics for the local MCP bridge and browser extension.
# Does not print the local connection key.
#
#   bash ~/claude-for-arc/scripts/doctor.sh
set -u  # no pipefail: grep -q closing a pipe early must not count as failure

NAME="claude-for-arc"
DEST="${CFA_HOME:-$HOME/claude-for-arc}"
DATA="${CFA_DATA_DIR:-$HOME/Library/Application Support/$NAME}"
PORT="${CFA_PORT:-5555}"
SERVER="$DEST/server/server.js"
NODE="${CFA_NODE:-$(command -v node 2>/dev/null || true)}"
if [ -r "$DATA/codex/current/server/server.js" ] && [ -x "$DATA/codex/current/node" ]; then
  SERVER="$(cd "$DATA/codex/current" && pwd -P)/server/server.js"
  NODE="$(dirname "$(dirname "$SERVER")")/node"
fi
EXTENSION="${CFA_EXTENSION_DIR:-$DEST/extension}"
[ -f "$EXTENSION/manifest.json" ] || EXTENSION="$DATA/extension"
PROBLEMS=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
info() { printf '    %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "Система"
info "macOS $(sw_vers -productVersion 2>/dev/null), $(uname -m)"
[ -d /Applications/Arc.app ] && ok "Arc установлен" || bad "Arc не найден в /Applications"

head_ "Файлы"
if [ -f "$SERVER" ]; then ok "Сервер: $SERVER"; else bad "Нет $SERVER — запустите установщик"; fi
if [ -f "$(dirname "$SERVER")/node_modules/ws/package.json" ]; then ok "Зависимость ws на месте"; else bad "Нет зависимости ws рядом с сервером"; fi
if [ -f "$EXTENSION/manifest.json" ]; then
  ok "Расширение: $EXTENSION (версия $(grep -o '"version": *"[^"]*"' "$EXTENSION/manifest.json" | cut -d'"' -f4))"
else
  bad "Нет $EXTENSION"
fi
if [ -s "$DATA/token" ]; then
  PERMS="$(stat -f '%Lp' "$DATA/token")"
  [ "$PERMS" = "600" ] && ok "Ключ подключения есть (права 600)" || bad "У файла ключа права $PERMS, нужно 600: chmod 600 \"$DATA/token\""
else
  bad "Нет ключа $DATA/token — запустите установщик"
fi

head_ "Node.js"
if [ -n "$NODE" ] && [ -x "$NODE" ]; then
  V="$("$NODE" -v 2>/dev/null)"; MAJOR="${V#v}"; MAJOR="${MAJOR%%.*}"
  [ "${MAJOR:-0}" -ge 18 ] && ok "$NODE ($V)" || bad "$NODE ($V) — нужна версия 18 или новее"
else
  bad "Node.js не найден по пути «${NODE:-—}». Установите его с nodejs.org и запустите установщик ещё раз"
fi

head_ "Сервер сейчас"
PIDS="$(pgrep -f "$SERVER" | tr '\n' ' ')"
if [ -n "$PIDS" ]; then ok "Запущено процессов сервера: $(echo $PIDS | wc -w | tr -d ' ') (на открытые сессии MCP-клиентов)"; else bad "Ни один сервер не запущен"; fi
LISTENER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1" (pid "$2")"}' | head -1)"
if [ -n "$LISTENER" ]; then
  if pgrep -f "$SERVER" | grep -qx "$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"; then
    ok "Порт $PORT слушает сервер Agent for Arc — расширение должно подключиться"
  else
    bad "Порт $PORT занят другой программой: $LISTENER"
  fi
else
  bad "Порт $PORT никто не слушает"
  if [ -z "$PIDS" ]; then
    info "Откройте новую сессию в MCP-клиенте, в котором настроен Agent for Arc."
  fi
fi

if [ -z "$LISTENER" ] && [ -n "$NODE" ] && [ -f "$SERVER" ]; then
  head_ "Пробный запуск сервера (20 секунд)"
  info "Пока он работает, нажмите в окне расширения «Переподключить» — оно должно показать «Подключено»."
  LOG="$( { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; sleep 20; } \
    | CFA_PORT="$PORT" CFA_DATA_DIR="$DATA" "$NODE" "$SERVER" 2>&1 >/dev/null )"
  printf '%s\n' "$LOG" | sed 's/^/    /' | grep -v '^    $' | head -15
  if printf '%s' "$LOG" | grep -q "authenticated"; then
    ok "Расширение подключилось к пробному серверу. Проверьте настройки выбранного MCP-клиента."
  elif printf '%s' "$LOG" | grep -q "wrong token"; then
    bad "Локальный ключ не совпадает. Повторите установку и нажмите «Переподключить»."
  elif printf '%s' "$LOG" | grep -q "Listening on"; then
    bad "Сервер работает, но расширение не подключилось: проверьте, что оно включено на странице arc://extensions"
  else
    bad "Сервер не запустился (см. вывод выше)"
  fi
fi

head_ "Итог"
if [ "$PROBLEMS" -eq 0 ]; then
  ok "Всё в порядке"
else
  info "Проблем: $PROBLEMS. Пришлите этот вывод тому, кто помогает с установкой — секретов в нём нет."
fi
