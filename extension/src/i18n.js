// Interface strings in English and Russian. The language is the "lang"
// setting ("en" / "ru"); empty means follow Arc's interface language.

export const STRINGS = {
  en: {
    checking: "Checking…",
    reconnect: "Reconnect",
    connected: "Connected to local connector",
    connecting: "Connecting…",
    offline: "Connector unavailable",
    offlineHint: "Start your configured MCP client. The extension connects to its local server automatically.",
    nokey: "Waiting for automatic setup",
    nokeyHint: "Start your MCP client to complete automatic local setup. If needed, restart the client and reload the extension. Manual local setup is available under Advanced.",
    badkey: "Local connection needs repair",
    badkeyHint: "Restart your MCP client and reload the extension to refresh the local connection. Advanced settings offer a manual local key as a fallback.",
    agentTabs: "Tabs opened by the agent: {n}",
    canControl: "Agent browser access is enabled",
    pausedText: "Paused: agent browser access is disabled",
    pause: "Pause",
    resume: "Resume",
    keyTitle: "Advanced: local connection",
    keyInPlace: "Local key configured",
    enterManually: "Enter manually",
    keyPlaceholder: "64 characters",
    save: "Save",
    keyHint: "Automatic setup normally provides this key. For troubleshooting only, enter the local bridge key as described in the installation guide. This is not an account or API key.",
    keyInvalid: "The key is 64 characters, 0–9 and a–f. Copy all of it.",
    accessTitle: "Access",
    scopeOwn: "Only tabs opened by the agent",
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
    badgeConnected: "Agent for Arc: connected",
    badgePaused: "Agent for Arc: paused",
    badgeNokey: "Agent for Arc: waiting for automatic setup",
    badgeBadkey: "Agent for Arc: local connection needs repair",
    badgeOffline: "Agent for Arc: connector unavailable",
  },
  ru: {
    checking: "Проверяю…",
    reconnect: "Переподключить",
    connected: "Подключено к локальному коннектору",
    connecting: "Подключаюсь…",
    offline: "Коннектор недоступен",
    offlineHint: "Запустите настроенный MCP-клиент. Расширение автоматически подключится к его локальному серверу.",
    nokey: "Ожидание автоматической настройки",
    nokeyHint: "Запустите MCP-клиент для автоматической локальной настройки. При необходимости перезапустите клиент и перезагрузите расширение. Ручная настройка доступна в разделе «Дополнительно».",
    badkey: "Нужно восстановить локальное подключение",
    badkeyHint: "Перезапустите MCP-клиент и перезагрузите расширение для обновления локального подключения. В дополнительных настройках доступен резервный ввод локального ключа.",
    agentTabs: "Вкладок, открытых агентом: {n}",
    canControl: "Доступ агента к браузеру включён",
    pausedText: "Пауза: доступ агента к браузеру отключён",
    pause: "Пауза",
    resume: "Снять паузу",
    keyTitle: "Дополнительно: локальное подключение",
    keyInPlace: "Локальный ключ настроен",
    enterManually: "Ввести вручную",
    keyPlaceholder: "64 символа",
    save: "Сохранить",
    keyHint: "Обычно ключ настраивается автоматически. Только для устранения неполадок: введите ключ локального моста по инструкции установки. Это не ключ аккаунта или API.",
    keyInvalid: "Ключ — это 64 символа 0–9 и a–f. Скопируйте его целиком.",
    accessTitle: "Доступ",
    scopeOwn: "Только вкладки, открытые агентом",
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
    badgeConnected: "Agent for Arc: подключено",
    badgePaused: "Agent for Arc: пауза",
    badgeNokey: "Agent for Arc: ожидание автоматической настройки",
    badgeBadkey: "Agent for Arc: нужно восстановить подключение",
    badgeOffline: "Agent for Arc: коннектор недоступен",
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
