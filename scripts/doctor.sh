#!/bin/bash
# claude-for-arc diagnostics. Checks every link between Claude, the server and
# the extension and says what to fix. Prints no secrets, so the output can be
# sent to whoever helps you.
#
#   bash ~/claude-for-arc/scripts/doctor.sh
set -u  # no pipefail: grep -q closing a pipe early must not count as failure

NAME="claude-for-arc"
DEST="${CFA_HOME:-$HOME/claude-for-arc}"
DATA="$HOME/Library/Application Support/$NAME"
PORT="${CFA_PORT:-5555}"
PROBLEMS=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
info() { printf '    %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "Система"
info "macOS $(sw_vers -productVersion 2>/dev/null), $(uname -m)"
[ -d /Applications/Arc.app ] && ok "Arc установлен" || bad "Arc не найден в /Applications"
[ -d /Applications/Claude.app ] && ok "Приложение Claude установлено" || bad "Приложение Claude не найдено в /Applications"
ps -axo comm= | grep -x "/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null && ok "Приложение Claude запущено" || bad "Приложение Claude не запущено — откройте его"

head_ "Файлы"
if [ -f "$DEST/server/server.js" ]; then ok "Сервер: $DEST/server/server.js"; else bad "Нет $DEST/server/server.js — запустите установщик"; fi
if [ -f "$DEST/server/node_modules/ws/package.json" ]; then ok "Зависимость ws на месте"; else bad "Нет $DEST/server/node_modules/ws — запустите установщик ещё раз"; fi
if [ -f "$DEST/extension/manifest.json" ]; then
  ok "Расширение: $DEST/extension (версия $(grep -o '"version": *"[^"]*"' "$DEST/extension/manifest.json" | cut -d'"' -f4))"
else
  bad "Нет $DEST/extension"
fi
if [ -s "$DATA/token" ]; then
  PERMS="$(stat -f '%Lp' "$DATA/token")"
  [ "$PERMS" = "600" ] && ok "Ключ подключения есть (права 600)" || bad "У файла ключа права $PERMS, нужно 600: chmod 600 \"$DATA/token\""
else
  bad "Нет ключа $DATA/token — запустите установщик"
fi

head_ "Подключение к Claude"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)"
NODE_FROM_CONFIG=""
if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
  GET="$("$CLAUDE_BIN" mcp get "$NAME" 2>&1 || true)"
  if printf '%s' "$GET" | grep -q "Command:"; then
    NODE_FROM_CONFIG="$(printf '%s\n' "$GET" | sed -n 's/^ *Command: //p')"
    ok "Сервер зарегистрирован в Claude Code ($(printf '%s\n' "$GET" | sed -n 's/^ *Scope: //p'))"
    info "Команда: $NODE_FROM_CONFIG $(printf '%s\n' "$GET" | sed -n 's/^ *Args: //p')"
    if printf '%s' "$GET" | grep -q "✔ Connected"; then
      ok "Claude Code может запустить сервер"
    else
      bad "Claude Code не может запустить сервер:"
      printf '%s\n' "$GET" | sed -n 's/^ *Status: /    /p'
    fi
  else
    bad "В Claude Code сервер не зарегистрирован — запустите установщик"
  fi
else
  bad "Не найден Claude Code (откройте вкладку Code в приложении Claude хотя бы раз)"
fi
CHAT_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if grep -qs "\"$NAME\"" "$CHAT_CONFIG"; then ok "Подключён и к обычному чату Claude"; else info "К вкладке Chat не подключён (это нормально, если пользуетесь вкладкой Code)"; fi

head_ "Node.js"
NODE="${NODE_FROM_CONFIG:-$(command -v node 2>/dev/null || true)}"
if [ -n "$NODE" ] && [ -x "$NODE" ]; then
  V="$("$NODE" -v 2>/dev/null)"; MAJOR="${V#v}"; MAJOR="${MAJOR%%.*}"
  [ "${MAJOR:-0}" -ge 18 ] && ok "$NODE ($V)" || bad "$NODE ($V) — нужна версия 18 или новее"
else
  bad "Node.js не найден по пути «${NODE:-—}». Установите его с nodejs.org и запустите установщик ещё раз"
fi

head_ "Сервер сейчас"
PIDS="$(pgrep -f "$DEST/server/server.js" | tr '\n' ' ')"
if [ -n "$PIDS" ]; then ok "Запущено процессов сервера: $(echo $PIDS | wc -w | tr -d ' ') (по одному на открытую сессию Claude)"; else bad "Ни один сервер не запущен"; fi
LISTENER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1" (pid "$2")"}' | head -1)"
if [ -n "$LISTENER" ]; then
  if pgrep -f "$DEST/server/server.js" | grep -qx "$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"; then
    ok "Порт $PORT слушает сервер claude-for-arc — расширение должно подключиться"
  else
    bad "Порт $PORT занят другой программой: $LISTENER"
  fi
else
  bad "Порт $PORT никто не слушает"
  if [ -z "$PIDS" ]; then
    info "→ Сервер запускается, только пока открыта сессия Claude. Начните НОВУЮ сессию"
    info "  во вкладке Code (старые, открытые до установки, сервер не видят)."
  fi
fi

if [ -z "$LISTENER" ] && [ -n "$NODE" ] && [ -f "$DEST/server/server.js" ]; then
  head_ "Пробный запуск сервера (20 секунд)"
  info "Пока он работает, нажмите в окне расширения «Переподключить» — оно должно показать «Подключено»."
  LOG="$( { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; sleep 20; } \
    | "$NODE" "$DEST/server/server.js" 2>&1 >/dev/null )"
  printf '%s\n' "$LOG" | sed 's/^/    /' | grep -v '^    $' | head -15
  if printf '%s' "$LOG" | grep -q "authenticated"; then
    ok "Расширение подключилось к пробному серверу — значит, дело только в запуске из Claude"
  elif printf '%s' "$LOG" | grep -q "wrong token"; then
    bad "Расширение подключилось, но с другим ключом: вставьте ключ заново (cat \"$DATA/token\" | pbcopy)"
  elif printf '%s' "$LOG" | grep -q "Listening on"; then
    bad "Сервер работает, но расширение не подключилось: проверьте, что оно включено в arc://extensions и в нём сохранён ключ"
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
