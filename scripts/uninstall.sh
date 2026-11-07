#!/bin/bash
# Removes claude-for-arc: the Claude registrations, the installed files and,
# if you agree, the connection key. The extension itself is removed in Arc.
set -euo pipefail

# Wrapped in a function: bash reads it whole before running, so deleting
# $DEST (which may contain this very script) cannot cut it off midway.
main() {

  NAME="claude-for-arc"
  DEST="${CFA_HOME:-$HOME/claude-for-arc}"
  DATA="$HOME/Library/Application Support/$NAME"
  say() { printf '%s\n' "$*"; }

  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
  if [ -z "$CLAUDE_BIN" ]; then
    CLAUDE_BIN="$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)"
  fi
  if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    "$CLAUDE_BIN" mcp remove --scope user "$NAME" >/dev/null 2>&1 && say "Удалено из Claude Code." || say "В Claude Code не был подключён."
  fi

  NODE="$(command -v node 2>/dev/null || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1 || true)"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CHAT_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  if [ -n "$NODE" ] && [ -f "$SCRIPT_DIR/desktop-config.js" ] && grep -qs "\"$NAME\"" "$CHAT_CONFIG"; then
    if pgrep -xq Claude; then say "Закройте Claude (⌘Q), чтобы он не вернул настройки чата обратно."; read -r -p "Нажмите Enter… " _ || true; fi
    "$NODE" "$SCRIPT_DIR/desktop-config.js" remove || true
  fi

  if [ -f "$DEST/.claude-for-arc" ]; then
    rm -rf "$DEST"
    say "Удалена папка $DEST."
  elif [ -e "$DEST" ]; then
    say "Папка $DEST не похожа на claude-for-arc — не трогаю её."
  fi

  if [ -d "$DATA" ]; then
    read -r -p "Удалить и ключ подключения ($DATA)? [y/N] " reply || reply=""
    if [[ "$reply" =~ ^[YyДд] ]]; then rm -rf "$DATA"; say "Ключ удалён."; fi
  fi

  say ""
  say "Осталось удалить само расширение: arc://extensions → claude-for-arc → «Удалить»."
}

main "$@"
