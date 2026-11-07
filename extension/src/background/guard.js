// claude-for-arc: what the model is allowed to touch.
//
// Every tool call from the server passes through checkCall() before the
// upstream OpenDia handler runs it. The rules, all set from the popup:
//
//   scope "own" (default)  only tabs this extension opened (tab_create, or a
//                          page opened from one of them) can be read or driven;
//   scope "all"            any tab, like upstream OpenDia;
//   readOnly               no clicks, typing, styling, closing or bookmarking;
//   paused                 every call is refused;
//   allowHistory           history and bookmark tools exist at all (off by
//                          default; also gated by an optional permission);
//   blocklist              hosts that are never read or driven, plus
//                          ALWAYS_BLOCKED, which the popup cannot remove.
//
// Only http(s) pages can be opened or targeted, so the model cannot navigate
// to javascript:, file:, data: or browser-internal pages.

import {
  DEFAULT_SETTINGS,
  CONTENT_TOOLS,
  WRITE_TOOLS,
  HISTORY_TOOLS,
  urlProblem,
  hostOf,
} from "./policy.js";

export { decorateTools } from "./policy.js";

const LOG_LIMIT = 200;

// ---------------------------------------------------------------------------
// State

let settings = { ...DEFAULT_SETTINGS };
const agentTabs = new Map(); // tabId -> lastUsed ms

export const ready = (async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  settings = { ...DEFAULT_SETTINGS, ...stored };
  const session = await chrome.storage.session.get("agentTabs");
  for (const [id, used] of session.agentTabs || []) agentTabs.set(id, used);
  // Drop tabs that closed while the worker was asleep.
  for (const id of [...agentTabs.keys()]) {
    try {
      await chrome.tabs.get(id);
    } catch {
      agentTabs.delete(id);
    }
  }
  await saveAgentTabs();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in DEFAULT_SETTINGS) settings[key] = newValue === undefined ? DEFAULT_SETTINGS[key] : newValue;
  }
});

export function getSettings() {
  return settings;
}

function saveAgentTabs() {
  return chrome.storage.session.set({ agentTabs: [...agentTabs.entries()] });
}

export async function addAgentTab(tabId) {
  if (typeof tabId !== "number") return;
  agentTabs.set(tabId, Date.now());
  await saveAgentTabs();
}

export function isAgentTab(tabId) {
  return agentTabs.has(tabId);
}

export function agentTabIds() {
  return [...agentTabs.keys()];
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (agentTabs.delete(tabId)) saveAgentTabs();
});

// Pages an agent tab opens (target=_blank, window.open) belong to the agent too.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && agentTabs.has(tab.openerTabId)) addAgentTab(tab.id);
});

// Record every tab a tool result mentions as one the agent opened.
export async function rememberCreatedTabs(result) {
  if (!result) return;
  if (typeof result.tab_id === "number") await addAgentTab(result.tab_id);
  for (const entry of result.created_tabs || result.results || []) {
    if (entry && typeof entry.tab_id === "number") await addAgentTab(entry.tab_id);
  }
}

// ---------------------------------------------------------------------------
// Policy

class Refusal extends Error {}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// The tab a call without tab_id should act on, within the current scope.
async function defaultTab() {
  const active = await activeTab();
  if (settings.scope === "all" || (active && agentTabs.has(active.id))) return active;
  let best = null;
  for (const [id, used] of agentTabs) if (!best || used > best[1]) best = [id, used];
  if (!best) return null;
  try {
    return await chrome.tabs.get(best[0]);
  } catch {
    agentTabs.delete(best[0]);
    return null;
  }
}

async function targetTab(params, { allowUserActiveTab = false } = {}) {
  let tab;
  if (params.tab_id !== undefined && params.tab_id !== null) {
    try {
      tab = await chrome.tabs.get(Number(params.tab_id));
    } catch {
      throw new Refusal(`вкладка ${params.tab_id} не найдена`);
    }
  } else if (allowUserActiveTab) {
    tab = await activeTab();
  } else {
    tab = await defaultTab();
  }
  if (!tab) {
    throw new Refusal(
      settings.scope === "own"
        ? "нет вкладки агента: сначала откройте страницу через tab_create"
        : "нет активной вкладки"
    );
  }
  const userTabAllowed = allowUserActiveTab && params.tab_id == null;
  if (settings.scope === "own" && !agentTabs.has(tab.id) && !userTabAllowed) {
    throw new Refusal(
      `вкладка ${tab.id} открыта пользователем, а не агентом. Откройте свою через tab_create ` +
        "или попросите пользователя разрешить «все вкладки» в окне claude-for-arc"
    );
  }
  const problem = urlProblem(tab.url || tab.pendingUrl, settings.blocklist, { allowBlank: true });
  if (problem) throw new Refusal(problem);
  return tab;
}

// Throws a Refusal (with a message for the model) or returns the params to
// run the call with; tab-targeting calls get an explicit tab_id filled in.
export async function checkCall(method, rawParams) {
  await ready;
  const params = { ...(rawParams || {}) };

  if (settings.paused) throw new Refusal("пользователь поставил claude-for-arc на паузу");
  if (settings.readOnly && WRITE_TOOLS.has(method)) {
    throw new Refusal("включён режим «только чтение»: клики, ввод и изменения страниц запрещены");
  }
  if (HISTORY_TOOLS.has(method) && !settings.allowHistory) {
    throw new Refusal("доступ к истории и закладкам выключен в окне claude-for-arc");
  }

  if (CONTENT_TOOLS.has(method)) {
    const tab = await targetTab(params);
    params.tab_id = tab.id;
    touch(tab.id);
    return { params, host: hostOf(tab.url) };
  }

  switch (method) {
    case "get_selected_text": {
      // A selection is something the user made on purpose, so the active tab is
      // fine even if the agent did not open it.
      const tab = await targetTab(params, { allowUserActiveTab: true });
      params.tab_id = tab.id;
      return { params, host: hostOf(tab.url) };
    }

    case "page_navigate": {
      const problem = urlProblem(params.url, settings.blocklist);
      if (problem) throw new Refusal(problem);
      let tab = null;
      try {
        tab = await targetTab(params);
      } catch (error) {
        if (params.tab_id != null || settings.scope !== "own") throw error;
      }
      // No agent tab yet: open one rather than taking over a user's tab.
      if (tab) {
        params.tab_id = tab.id;
        touch(tab.id);
      } else {
        params.open_new_tab = true;
      }
      return { params, host: hostOf(params.url) };
    }

    case "tab_create": {
      const urls = Array.isArray(params.urls) ? params.urls : [params.url];
      for (const url of urls) {
        const problem = urlProblem(url, settings.blocklist, { allowBlank: true });
        if (problem) throw new Refusal(problem);
      }
      return { params, host: hostOf(urls[0]) };
    }

    case "tab_close": {
      const ids = Array.isArray(params.tab_ids)
        ? params.tab_ids.map(Number)
        : params.tab_id != null
          ? [Number(params.tab_id)]
          : [];
      if (ids.length === 0) {
        const tab = await defaultTab();
        if (!tab) throw new Refusal("нечего закрывать: нет вкладки агента");
        ids.push(tab.id);
      }
      if (settings.scope === "own") {
        const foreign = ids.filter((id) => !agentTabs.has(id));
        if (foreign.length) throw new Refusal(`вкладки ${foreign.join(", ")} открыты не агентом — закрыть нельзя`);
      }
      params.tab_ids = ids;
      delete params.tab_id;
      return { params, host: "" };
    }

    case "tab_switch": {
      const tab = await targetTab({ tab_id: params.tab_id });
      touch(tab.id);
      return { params, host: hostOf(tab.url) };
    }

    case "tab_list":
      return { params, host: "", filterTabs: settings.scope === "own" };

    default:
      return { params, host: "" };
  }
}

function touch(tabId) {
  if (agentTabs.has(tabId)) {
    agentTabs.set(tabId, Date.now());
    saveAgentTabs();
  }
}

export function isRefusal(error) {
  return error instanceof Refusal;
}

// ---------------------------------------------------------------------------
// Activity log and badge

export async function logCall(entry) {
  const { log = [] } = await chrome.storage.session.get("log");
  log.unshift({ t: Date.now(), ...entry });
  await chrome.storage.session.set({ log: log.slice(0, LOG_LIMIT) });
}

const BADGES = {
  connected: { text: "ON", color: "#16a34a", title: "claude-for-arc: подключено" },
  paused: { text: "II", color: "#6b7280", title: "claude-for-arc: пауза" },
  nokey: { text: "!", color: "#dc2626", title: "claude-for-arc: вставьте ключ подключения" },
  badkey: { text: "!", color: "#dc2626", title: "claude-for-arc: неверный ключ" },
  offline: { text: "", color: "#6b7280", title: "claude-for-arc: сервер не запущен" },
};

export function setBadge(state) {
  const badge = settings.paused && state === "connected" ? BADGES.paused : BADGES[state] || BADGES.offline;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setTitle({ title: badge.title });
}
