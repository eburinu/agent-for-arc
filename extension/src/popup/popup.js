import { DEFAULT_SETTINGS, parseBlocklist } from "../background/policy.js";

const $ = (id) => document.getElementById(id);

const STATUS = {
  connected: ["Подключено к Claude", ""],
  connecting: ["Подключаюсь…", ""],
  offline: ["Сервер не запущен", "Сервер работает, только пока в приложении Claude открыта сессия во вкладке Code. Начните новую сессию (открытые до установки не подойдут) — расширение подключится само. Не помогло: bash ~/claude-for-arc/scripts/doctor.sh в Терминале."],
  nokey: ["Нужен ключ подключения", "Вставьте ключ из установщика ниже."],
  badkey: ["Неверный ключ", "Ключ не совпадает с ключом сервера. Скопируйте его заново из установщика."],
};

async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

async function refreshStatus() {
  let status = { state: "offline" };
  try {
    status = await chrome.runtime.sendMessage({ action: "getStatus" });
  } catch {}
  const [text, hint] = STATUS[status.state] || STATUS.offline;
  $("dot").className = `dot ${status.state}`;
  $("statusText").textContent = text;
  $("statusHint").textContent =
    status.state === "connected" && status.agentTabs
      ? `Вкладок, открытых Claude: ${status.agentTabs}`
      : hint;
}

function renderPause(paused) {
  $("pauseRow").classList.toggle("on", paused);
  $("pauseText").textContent = paused ? "Пауза: Claude ничего не может делать" : "Claude может управлять браузером";
  $("pause").textContent = paused ? "Снять паузу" : "Пауза";
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
  renderPause(settings.paused);
  renderKey(settings.token);
  for (const radio of document.querySelectorAll("input[name=scope]")) radio.checked = radio.value === settings.scope;
  $("readOnly").checked = settings.readOnly;
  $("allowHistory").checked =
    settings.allowHistory && (await chrome.permissions.contains({ permissions: ["history", "bookmarks"] }));
  $("blocklist").value = settings.blocklist.join("\n");

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
      $("statusHint").textContent = "Ключ — это 64 символа 0–9 и a–f. Скопируйте его целиком.";
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
  });

  refreshStatus();
  renderLog();
  setInterval(refreshStatus, 2000);
}

init();
