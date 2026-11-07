import { DEFAULT_SETTINGS, parseBlocklist } from "../background/policy.js";
import { translator, resolveLang } from "../i18n.js";

const $ = (id) => document.getElementById(id);

let t = translator("");
let lastStatus = { state: "offline" };

const STATUS = {
  connected: ["connected", null],
  connecting: ["connecting", null],
  offline: ["offline", "offlineHint"],
  nokey: ["nokey", "nokeyHint"],
  badkey: ["badkey", "badkeyHint"],
};

function applyLanguage(setting) {
  t = translator(setting);
  const lang = resolveLang(setting);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const button of document.querySelectorAll(".lang button")) button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
}

async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

async function refreshStatus() {
  let status = { state: "offline" };
  try {
    status = await chrome.runtime.sendMessage({ action: "getStatus" });
  } catch {}
  lastStatus = status && status.state ? status : { state: "offline" };
  renderStatus();
}

function renderStatus() {
  const status = lastStatus;
  const [text, hint] = STATUS[status.state] || STATUS.offline;
  $("dot").className = `dot ${status.state}`;
  $("statusText").textContent = t(text);
  $("statusHint").textContent =
    status.state === "connected" && status.agentTabs
      ? t("agentTabs", { n: status.agentTabs })
      : hint ? t(hint) : "";
}

function renderPause(paused) {
  $("pauseRow").classList.toggle("on", paused);
  $("pauseText").textContent = paused ? t("pausedText") : t("canControl");
  $("pause").textContent = paused ? t("resume") : t("pause");
}

function renderKey(token) {
  const saved = /^[0-9a-f]{64}$/.test(token || "");
  $("keySaved").hidden = !saved;
  $("keyForm").hidden = saved;
}

function time(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderLog() {
  const { log = [] } = await chrome.storage.session.get("log");
  const list = $("log");
  list.replaceChildren();
  $("logEmpty").hidden = log.length > 0;
  // Hosts and errors come from web pages: textContent only, never innerHTML.
  for (const entry of log.slice(0, 30)) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = time(entry.t);
    const mark = document.createElement("span");
    mark.className = entry.ok ? "ok" : "err";
    mark.textContent = entry.ok ? "✓" : "✗";
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = [entry.tool, entry.host].filter(Boolean).join(" · ");
    if (entry.error) li.title = entry.error;
    li.append(t, mark, what);
    list.append(li);
  }
}

async function init() {
  const settings = await loadSettings();
  applyLanguage(settings.lang);
  renderPause(settings.paused);
  renderKey(settings.token);
  for (const radio of document.querySelectorAll("input[name=scope]")) radio.checked = radio.value === settings.scope;
  $("readOnly").checked = settings.readOnly;
  $("allowHistory").checked =
    settings.allowHistory && (await chrome.permissions.contains({ permissions: ["history", "bookmarks"] }));
  $("blocklist").value = settings.blocklist.join("\n");

  for (const button of document.querySelectorAll(".lang button")) {
    button.addEventListener("click", async () => {
      await chrome.storage.local.set({ lang: button.dataset.lang });
      applyLanguage(button.dataset.lang);
      renderPause((await loadSettings()).paused);
      renderStatus();
    });
  }

  $("reconnect").addEventListener("click", async () => {
    $("reconnect").disabled = true;
    await chrome.runtime.sendMessage({ action: "reconnect" }).catch(() => {});
    $("reconnect").disabled = false;
    refreshStatus();
  });

  $("pause").addEventListener("click", async () => {
    const { paused } = await loadSettings();
    await chrome.storage.local.set({ paused: !paused });
    renderPause(!paused);
  });

  $("saveToken").addEventListener("click", async () => {
    const token = $("token").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      $("statusHint").textContent = t("keyInvalid");
      return;
    }
    await chrome.storage.local.set({ token });
    $("token").value = "";
    renderKey(token);
    setTimeout(refreshStatus, 1500);
  });

  $("changeKey").addEventListener("click", () => {
    $("keySaved").hidden = true;
    $("keyForm").hidden = false;
    $("token").focus();
  });

  for (const radio of document.querySelectorAll("input[name=scope]")) {
    radio.addEventListener("change", () => chrome.storage.local.set({ scope: radio.value }));
  }

  $("readOnly").addEventListener("change", (e) => chrome.storage.local.set({ readOnly: e.target.checked }));

  $("allowHistory").addEventListener("change", async (e) => {
    if (e.target.checked) {
      // Chrome asks the user to confirm the extra permission here.
      const granted = await chrome.permissions.request({ permissions: ["history", "bookmarks"] });
      e.target.checked = granted;
      await chrome.storage.local.set({ allowHistory: granted });
    } else {
      await chrome.storage.local.set({ allowHistory: false });
      await chrome.permissions.remove({ permissions: ["history", "bookmarks"] }).catch(() => {});
    }
  });

  $("saveBlocklist").addEventListener("click", async () => {
    const blocklist = parseBlocklist($("blocklist").value);
    await chrome.storage.local.set({ blocklist });
    $("blocklist").value = blocklist.join("\n");
    $("blocklistSaved").hidden = false;
    setTimeout(() => { $("blocklistSaved").hidden = true; }, 1500);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.log) renderLog();
    if (area === "local" && changes.token) renderKey(changes.token.newValue);
  });

  refreshStatus();
  renderLog();
  setInterval(refreshStatus, 2000);
}

init();
