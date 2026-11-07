// Interface strings in English and Russian. The language is the "lang"
// setting ("en" / "ru"); empty means follow Arc's interface language.

export const STRINGS = {
  en: {
    checking: "Checking…",
    reconnect: "Reconnect",
    connected: "Connected to Claude",
    connecting: "Connecting…",
    offline: "Server not running",
    offlineHint: "Open the Claude app: the claude-for-arc connector starts with it and the extension connects on its own. No connector yet? Download claude-for-arc.mcpb and double-click it.",
    nokey: "Connection key needed",
    nokeyHint: "Open the Claude app: the connector puts the key into this extension's folder. Installed with install.sh? Enter the key below.",
    badkey: "Keys don't match",
    badkeyHint: "Restart Claude — the connector writes the key into the extension folder again. Installed with install.sh? Enter the key manually below.",
    agentTabs: "Tabs opened by Claude: {n}",
    canControl: "Claude can control the browser",
    pausedText: "Paused: Claude can't do anything",
    pause: "Pause",
    resume: "Resume",
    keyTitle: "Connection key",
    keyInPlace: "Key in place",
    enterManually: "Enter manually",
    keyPlaceholder: "64 characters",
    save: "Save",
    keyHint: "The claude-for-arc connector normally provides the key by itself. Manual entry is only for installs made with install.sh:",
    keyInvalid: "The key is 64 characters, 0–9 and a–f. Copy all of it.",
    accessTitle: "Access",
    scopeOwn: "Only tabs opened by Claude",
    recommended: "(recommended)",
    scopeAll: "All tabs, including mine",
    readOnly: "Read only: no clicks, typing or closing tabs",
    allowHistory: "Allow history and bookmarks",
    blockedTitle: "Blocked sites",
    saveList: "Save list",
    saved: "Saved",
    blockedHint: "One domain per line; subdomains are blocked too. Extension stores are always blocked.",
    logTitle: "Recent actions",
    logEmpty: "Nothing yet.",
    footer: "Based on OpenDia (MIT).",
    badgeConnected: "claude-for-arc: connected",
    badgePaused: "claude-for-arc: paused",
    badgeNokey: "claude-for-arc: connection key needed",
    badgeBadkey: "claude-for-arc: keys don't match",
    badgeOffline: "claude-for-arc: server not running",
  },
  ru: {
    checking: "Проверяю…",
    reconnect: "Переподключить",
    connected: "Подключено к Claude",
    connecting: "Подключаюсь…",
    offline: "Сервер не запущен",
    offlineHint: "Откройте приложение Claude: коннектор claude-for-arc запускается вместе с ним, и расширение подключится само. Коннектора нет — скачайте claude-for-arc.mcpb и откройте его двойным кликом.",
    nokey: "Нужен ключ подключения",
    nokeyHint: "Откройте приложение Claude: коннектор положит ключ в папку расширения. Ставили через install.sh — введите ключ ниже.",
    badkey: "Ключи не совпадают",
    badkeyHint: "Перезапустите Claude — коннектор заново положит ключ в папку расширения. Если ставили через install.sh: вставьте ключ вручную ниже.",
    agentTabs: "Вкладок, открытых Claude: {n}",
    canControl: "Claude может управлять браузером",
    pausedText: "Пауза: Claude ничего не может делать",
    pause: "Пауза",
    resume: "Снять паузу",
    keyTitle: "Ключ подключения",
    keyInPlace: "Ключ на месте",
    enterManually: "Ввести вручную",
    keyPlaceholder: "64 символа",
    save: "Сохранить",
    keyHint: "Обычно ключ приходит от коннектора claude-for-arc сам. Вручную — только для установки через install.sh:",
    keyInvalid: "Ключ — это 64 символа 0–9 и a–f. Скопируйте его целиком.",
    accessTitle: "Доступ",
    scopeOwn: "Только вкладки, открытые Claude",
    recommended: "(рекомендуется)",
    scopeAll: "Все вкладки, включая мои",
    readOnly: "Только чтение: без кликов, ввода и закрытия вкладок",
    allowHistory: "Разрешить историю и закладки",
    blockedTitle: "Запрещённые сайты",
    saveList: "Сохранить список",
    saved: "Сохранено",
    blockedHint: "По одному домену в строке; поддомены тоже закрыты. Магазины расширений закрыты всегда.",
    logTitle: "Последние действия",
    logEmpty: "Пока ничего.",
    footer: "Основано на OpenDia (MIT).",
    badgeConnected: "claude-for-arc: подключено",
    badgePaused: "claude-for-arc: пауза",
    badgeNokey: "claude-for-arc: нужен ключ подключения",
    badgeBadkey: "claude-for-arc: ключи не совпадают",
    badgeOffline: "claude-for-arc: сервер не запущен",
  },
};

export function resolveLang(setting) {
  if (setting === "en" || setting === "ru") return setting;
  let ui = "";
  try { ui = chrome.i18n.getUILanguage(); } catch {}
  return /^ru\b/i.test(ui || "") ? "ru" : "en";
}

export function translator(setting) {
  const table = STRINGS[resolveLang(setting)];
  return (key, vars = {}) =>
    (table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}
