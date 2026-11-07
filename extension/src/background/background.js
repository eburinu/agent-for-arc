// Import WebExtension polyfill at the top
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}

import * as guard from "./guard.js";

// Browser detection (kept for upstream code paths that branch on it)
const browserInfo = {
  isFirefox: false,
  isChrome: true,
  isServiceWorker: true,
  manifestVersion: browser.runtime.getManifest().manifest_version
};

// ---------------------------------------------------------------------------
// Connection to the claude-for-arc server
//
// The server listens on ws://127.0.0.1:<port> (5555 by default). Before this
// extension registers tools or runs a single command, both sides prove they
// hold the same token (pasted into the popup) with an HMAC challenge, so a
// different program listening on the port cannot drive the browser.

const encoder = new TextEncoder();
let hmacKeyPromise = null;
let hmacKeyToken = null;

function hmacKey(token) {
  if (token !== hmacKeyToken) {
    hmacKeyToken = token;
    hmacKeyPromise = crypto.subtle.importKey(
      "raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
  }
  return hmacKeyPromise;
}

async function hmacHex(token, ...parts) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(token), encoder.encode(parts.join("|")));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const KEEPALIVE_MS = 20000;
const RECONNECT_ALARM = "cfa-reconnect";

class ConnectionManager {
  constructor() {
    this.mcpSocket = null;
    this.authenticated = false;
    this.state = "offline"; // offline | connecting | connected | nokey | badkey
    this.keepalive = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
  }

  async connect() {
    if (this.mcpSocket && this.mcpSocket.readyState === WebSocket.OPEN && this.authenticated) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.createConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  setState(state) {
    this.state = state;
    guard.setBadge(state);
  }

  async createConnection() {
    await guard.ready;
    await guard.adoptBundledKey();
    const { token, port } = guard.getSettings();
    this.activeToken = token;
    if (!/^[0-9a-f]{64}$/.test(token || "")) {
      this.setState("nokey");
      throw new Error("Нет ключа подключения");
    }

    this.closeSocket();
    this.setState("connecting");
    const socket = new WebSocket(`ws://127.0.0.1:${Number(port) || 5555}`);
    this.mcpSocket = socket;
    this.authenticated = false;
    const clientNonce = randomHex();
    let serverNonce = null;

    return new Promise((resolve, reject) => {
      const fail = (error) => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => {
        if (this.mcpSocket === socket) this.closeSocket();
        fail(new Error("Сервер claude-for-arc не ответил"));
      }, 8000);

      socket.onmessage = async (event) => {
        if (this.mcpSocket !== socket) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!this.authenticated) {
          if (message.type === "challenge" && /^[0-9a-f]{64}$/.test(message.nonce || "") && !serverNonce) {
            serverNonce = message.nonce;
            socket.send(JSON.stringify({
              type: "auth",
              role: "extension",
              nonce: clientNonce,
              mac: await hmacHex(token, "client", serverNonce, clientNonce),
            }));
          } else if (message.type === "auth_ok" && serverNonce) {
            const expected = await hmacHex(token, "server", clientNonce, serverNonce);
            if (!constantTimeEqual(message.mac, expected)) {
              // Something answered on the port without knowing the token.
              console.warn("claude-for-arc: server failed to prove the token; disconnecting");
              this.closeSocket();
              this.setState("badkey");
              fail(new Error("Сервер на порту не знает ключ"));
              return;
            }
            this.authenticated = true;
            this.reconnectAttempts = 0;
            clearTimeout(timer);
            this.setState("connected");
            this.register();
            this.startKeepalive();
            resolve();
          } else if (message.type === "auth_failed") {
            this.setState("badkey");
            fail(new Error("Сервер отклонил ключ: проверьте, что он скопирован целиком"));
          }
          return; // nothing else is accepted before both sides are verified
        }

        if (message.type === "pong") return;
        if (message.type === "reload") {
          // The server placed a newer version in this extension's folder.
          chrome.runtime.reload();
          return;
        }
        if (typeof message.id === "string" && typeof message.method === "string") {
          await handleMCPRequest(message);
        }
      };

      socket.onclose = (event) => {
        if (this.mcpSocket !== socket) return;
        this.mcpSocket = null;
        this.authenticated = false;
        this.stopKeepalive();
        if (this.state !== "badkey" && this.state !== "nokey") {
          this.setState("offline");
          // A server handing the browser to another session, or restarting,
          // closes us; come back within seconds instead of waiting for the alarm.
          this.scheduleReconnect();
        }
        fail(new Error(`Соединение закрыто (${event.code})`));
      };

      socket.onerror = () => {};
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts || 0), 15000);
    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  register() {
    const tools = guard.decorateTools(getAvailableTools(), guard.getSettings());
    this.mcpSocket.send(JSON.stringify({ type: "register", tools, version: chrome.runtime.getManifest().version }));
  }

  // Re-advertise tools after a settings change (history toggle, scope).
  reregister() {
    if (this.authenticated && this.mcpSocket?.readyState === WebSocket.OPEN) this.register();
  }

  // Traffic every 20s keeps the MV3 service worker (and thus the socket) alive.
  startKeepalive() {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (this.mcpSocket?.readyState === WebSocket.OPEN) {
        this.mcpSocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, KEEPALIVE_MS);
  }

  stopKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = null;
  }

  closeSocket() {
    const socket = this.mcpSocket;
    this.mcpSocket = null;
    this.authenticated = false;
    this.stopKeepalive();
    if (socket) {
      try { socket.close(1000, "client closing"); } catch {}
    }
  }

  send(message) {
    if (!this.authenticated || !this.mcpSocket || this.mcpSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not connected; dropped response for id=${message?.id}`);
    }
    this.mcpSocket.send(JSON.stringify(message));
  }

  getStatus() {
    return { state: this.state, connected: this.authenticated };
  }
}

// Create global connection manager
const connectionManager = new ConnectionManager();

// Content script management for background tabs
// Ping the content script in a tab. Rejects on timeout or extension error.
function pingContentScript(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Content script ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    browser.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
      clearTimeout(timer);
      if (browser.runtime.lastError) {
        reject(new Error(browser.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// claude-for-arc: ask the page's script once; if it is not there (a fresh
// page), inject it right away and poll briefly, instead of three timed retries.
async function ensureContentScriptReady(tabId) {
  const alive = await pingContentScript(tabId, 400).then((r) => r?.success, () => false);
  if (alive) return true;
  const tab = await browser.tabs.get(tabId);
  if (!isInjectableUrl(tab.url)) {
    throw new Error(`Cannot inject content script into ${tab.url} - restricted URL`);
  }
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
  } catch (error) {
    throw new Error(`Failed to inject content script into tab ${tabId}: ${error.message}`);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const ready = await pingContentScript(tabId, 300).then((r) => r?.success, () => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Content script not available in tab ${tabId}`);
}

function isInjectableUrl(url) {
  if (!url) return false;
  
  const restrictedProtocols = ['chrome:', 'chrome-extension:', 'chrome-devtools:', 'edge:', 'moz-extension:', 'about:'];
  const restrictedDomains = ['chrome.google.com', 'addons.mozilla.org'];
  
  // Check protocol
  if (restrictedProtocols.some(protocol => url.startsWith(protocol))) {
    return false;
  }
  
  // Check special browser pages
  if (url.startsWith('https://chrome.google.com/webstore') || 
      url.includes('chrome://') || 
      restrictedDomains.some(domain => url.includes(domain))) {
    return false;
  }
  
  return true;
}

// Get content script readiness status for a tab
async function getTabContentScriptStatus(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    
    if (!isInjectableUrl(tab.url)) {
      return { ready: false, reason: 'restricted_url', url: tab.url };
    }
    
    // A failed ping is the answer here, not an error: report the tab as not loaded.
    const response = await pingContentScript(tabId, 3000).catch(() => null);

    if (response && response.success) {
      return { ready: true, reason: 'active', url: tab.url };
    } else {
      return { ready: false, reason: 'not_loaded', url: tab.url };
    }
    
  } catch (error) {
    return { ready: false, reason: 'tab_error', error: error.message };
  }
}

// Define available browser automation tools for MCP
// Tool list advertised to Claude. Descriptions are kept short: Claude reads
// them on every step, so every word costs time.
const TAB = { type: "number", description: "Tab id (from tab_create / tab_list). Default: the current agent tab." };
const TARGET = {
  element_id: { type: "string", description: "Id from page_analyze." },
  text: { type: "string", description: "Instead of element_id: the button/link text or aria-label, e.g. \"Отправить\"." },
  label: { type: "string", description: "Instead of element_id: a field's label, placeholder or aria-label." },
  selector: { type: "string", description: "Instead of element_id: a CSS selector." },
  index: { type: "number", description: "Which match to use when several fit (0 = best).", default: 0 },
};
const STEP_TOOLS = [
  "tab_create", "page_navigate", "page_wait_for", "element_click", "element_fill", "press_key",
  "page_scroll", "page_analyze", "page_extract_content", "element_get_state", "get_page_links", "tab_close", "sleep",
];

function getAvailableTools() {
  return [
    {
      name: "run_steps",
      description:
        "Run several browser actions in ONE call, in order, and get one compact report. Use it for any " +
        "multi-step job (open page → fill → click/Enter → check), and for repeating it, e.g. sending N messages: " +
        "it is far faster than one call per action. Each step is {tool, args} with the same args as that tool; " +
        "steps without tab_id use the tab of the previous step (tab_create/page_navigate set it). " +
        "Elements can be named by text/label/selector, so page_analyze is rarely needed. " +
        "Extra step tool: sleep {ms}. Stops at the first failed step unless stop_on_error is false.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: STEP_TOOLS },
                args: { type: "object" },
              },
              required: ["tool"],
            },
          },
          stop_on_error: { type: "boolean", default: true },
          tab_id: TAB,
        },
        required: ["steps"],
      },
    },
    {
      name: "page_analyze",
      description: "List the page's interactive elements (buttons, fields, links) with ids for element_click/element_fill. Often unnecessary: those tools also accept text/label/selector.",
      inputSchema: {
        type: "object",
        properties: {
          intent_hint: { type: "string", description: "What you look for: login, search, send message, submit, menu…" },
          phase: { type: "string", enum: ["discover", "detailed"], default: "discover" },
          max_results: { type: "number", default: 5, maximum: 15 },
          element_ids: { type: "array", items: { type: "string" }, description: "Expand these ids from a discover result." },
          tab_id: TAB,
        },
        required: ["intent_hint"],
      },
    },
    {
      name: "page_extract_content",
      description: "Read the page's main text (article, search results or posts).",
      inputSchema: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["article", "search_results", "posts"] },
          summarize: { type: "boolean", default: true, description: "false = full text (up to 40k chars)." },
          max_items: { type: "number", default: 20 },
          tab_id: TAB,
        },
        required: ["content_type"],
      },
    },
    {
      name: "element_click",
      description: "Click an element, named by element_id, text, label or selector. Waits until the page settles (up to wait_after ms).",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET,
          click_type: { type: "string", enum: ["left", "right", "double"], default: "left" },
          wait_after: { type: "number", default: 1000, description: "Max ms to wait for the page to settle." },
          tab_id: TAB,
        },
      },
    },
    {
      name: "element_fill",
      description: "Type a value into a field (input, textarea, contenteditable), named by element_id, label (placeholder) or selector. Password, code and card fields are refused.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET,
          value: { type: "string" },
          clear_first: { type: "boolean", default: true },
          tab_id: TAB,
        },
        required: ["value"],
      },
    },
    {
      name: "press_key",
      description: "Press a key (Enter, Escape, Tab, Backspace, arrows, a letter) on an element (element_id/text/label/selector) or the focused one. Enter in chat boxes usually sends; in a form field it submits the form.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", default: "Enter" },
          modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "meta", "shift", "alt"] } },
          ...TARGET,
          wait_after: { type: "number", default: 1000, description: "Max ms to wait for the page to settle." },
          tab_id: TAB,
        },
      },
    },
    {
      name: "page_navigate",
      description: "Open a URL in a tab and wait for it to load.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          wait_for: { type: "string", description: "CSS selector to wait for after load." },
          timeout: { type: "number", default: 10000 },
        },
        required: ["url"],
      },
    },
    {
      name: "page_wait_for",
      description: "Wait until an element is visible or a text appears.",
      inputSchema: {
        type: "object",
        properties: {
          condition_type: { type: "string", enum: ["element_visible", "text_present"] },
          selector: { type: "string" },
          text: { type: "string" },
          timeout: { type: "number", default: 5000 },
        },
        required: ["condition_type"],
      },
    },
    {
      name: "tab_create",
      description: "Open a new tab (url) or several (urls) and wait for loading. The tab id it returns is the agent's tab.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          urls: { type: "array", items: { type: "string" }, maxItems: 100 },
          active: { type: "boolean", default: true },
          wait_for: { type: "string", description: "CSS selector to wait for (single tab)." },
          timeout: { type: "number", default: 10000 },
        },
      },
    },
    {
      name: "tab_close",
      description: "Close tab(s) by id, or the current agent tab.",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "number" }, tab_ids: { type: "array", items: { type: "number" } } },
      },
    },
    {
      name: "tab_list",
      description: "List open tabs with ids.",
      inputSchema: {
        type: "object",
        properties: { current_window_only: { type: "boolean", default: true } },
      },
    },
    {
      name: "tab_switch",
      description: "Bring a tab to the front.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } }, required: ["tab_id"] },
    },
    {
      name: "element_get_state",
      description: "Get an element's state and value (element_id, text, label or selector).",
      inputSchema: { type: "object", properties: { ...TARGET, tab_id: TAB } },
    },
    {
      name: "page_scroll",
      description: "Scroll the page (direction/amount) or to an element.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right", "top", "bottom"], default: "down" },
          amount: { type: "string", enum: ["small", "medium", "large", "page", "custom"], default: "medium" },
          pixels: { type: "number" },
          element_id: { type: "string" },
          tab_id: TAB,
        },
      },
    },
    {
      name: "get_page_links",
      description: "List the page's links.",
      inputSchema: {
        type: "object",
        properties: {
          include_internal: { type: "boolean", default: true },
          include_external: { type: "boolean", default: true },
          domain_filter: { type: "string" },
          max_results: { type: "number", default: 100, maximum: 200 },
          tab_id: TAB,
        },
      },
    },
    {
      name: "get_selected_text",
      description: "Get the text the user selected in a tab.",
      inputSchema: { type: "object", properties: { max_length: { type: "number", default: 10000 }, tab_id: TAB } },
    },
    {
      name: "get_bookmarks",
      description: "Search bookmarks.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "add_bookmark",
      description: "Add a bookmark.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" }, parentId: { type: "string" } },
        required: ["title", "url"],
      },
    },
    {
      name: "get_history",
      description: "Search browser history.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: { type: "string" },
          start_date: { type: "string", format: "date-time" },
          end_date: { type: "string", format: "date-time" },
          domains: { type: "array", items: { type: "string" } },
          max_results: { type: "number", default: 50, maximum: 500 },
        },
      },
    },
  ];
}

// Handle MCP requests with enhanced automation tools
async function handleMCPRequest(message) {
  const { id, method } = message;
  try {
    const result = method === "run_steps"
      ? await runSteps(message.params || {})
      : await runTool(method, message.params);
    connectionManager.send({ id, result });
  } catch (error) {
    // Guarded because send() throws when the socket is down, and this is the
    // last handler — an escape here would lose the original error entirely.
    try {
      connectionManager.send({ id, error: { message: error.message, code: -32603 } });
    } catch (sendError) {
      console.error('Could not deliver error response:', error.message, '|', sendError.message);
    }
  }
}

// One tool call through the policy (scope, read-only, pause, blocklist,
// history gate), logged in the popup.
async function runTool(method, rawParams) {
  let host = "";
  try {
    let checked;
    try {
      checked = await guard.checkCall(method, rawParams);
    } catch (error) {
      if (guard.isRefusal(error)) throw new Error(`claude-for-arc: ${error.message}`);
      throw error;
    }
    host = checked.host;
    const result = await executeTool(method, checked.params, checked);
    guard.logCall({ tool: method, host, ok: true });
    return result;
  } catch (error) {
    guard.logCall({ tool: method, host, ok: false, error: String(error.message).slice(0, 200) });
    throw error;
  }
}

const RUN_STEPS_MAX = 100;
const TAB_TOOLS = new Set(STEP_TOOLS.filter((t) => t !== "tab_create" && t !== "sleep"));

// claude-for-arc: several actions in one call. Each step goes through the same
// policy as a single call; the tab carries over from step to step.
async function runSteps({ steps, stop_on_error = true, tab_id = null }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("run_steps: steps is empty");
  if (steps.length > RUN_STEPS_MAX) throw new Error(`run_steps: at most ${RUN_STEPS_MAX} steps per call`);
  let tab = tab_id ?? null;
  const report = [];
  for (const [index, step] of steps.entries()) {
    const tool = step?.tool;
    const args = { ...(step?.args || {}) };
    const started = Date.now();
    try {
      if (!STEP_TOOLS.includes(tool)) throw new Error(`run_steps: «${tool}» is not a step tool`);
      let result;
      if (tool === "sleep") {
        const ms = Math.min(Math.max(Number(args.ms) || 0, 0), 10000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        result = { success: true, slept: ms };
      } else {
        if (TAB_TOOLS.has(tool) && args.tab_id == null && tab != null) args.tab_id = tab;
        result = await runTool(tool, args);
        const newTab = result?.tab_id ?? result?.tabId ?? result?.tabs?.[0]?.id ?? result?.created_tabs?.[0]?.tab_id;
        if ((tool === "tab_create" || tool === "page_navigate") && newTab != null) tab = newTab;
        else if (args.tab_id != null && tool !== "tab_close") tab = args.tab_id;
      }
      report.push({ index, tool, ok: true, ms: Date.now() - started, result });
    } catch (error) {
      report.push({ index, tool, ok: false, ms: Date.now() - started, error: error.message });
      if (stop_on_error) break;
    }
  }
  return {
    success: report.every((r) => r.ok) && report.length === steps.length,
    steps_total: steps.length,
    steps_run: report.length,
    tab_id: tab,
    report,
  };
}

async function executeTool(method, params, checked) {
  let result;
  switch (method) {
    case "page_analyze":
      return sendToContentScript('analyze', params, params.tab_id);
    case "page_extract_content":
      return sendToContentScript('extract_content', params, params.tab_id);
    case "element_click":
      return sendToContentScript('element_click', params, params.tab_id);
    case "element_fill":
      return sendToContentScript('element_fill', params, params.tab_id);
    case "press_key":
      return sendToContentScript('press_key', params, params.tab_id);
    case "page_navigate":
      result = await navigateToUrl(params.url, params.wait_for, params.timeout, params.tab_id, params.open_new_tab);
      await guard.rememberCreatedTabs(params.open_new_tab ? result : null);
      return result;
    case "page_wait_for":
      return sendToContentScript('wait_for', params, params.tab_id);
    case "tab_create":
      result = await createTab(params);
      await guard.rememberCreatedTabs(result);
      return result;
    case "tab_close":
      return closeTabs(params);
    case "tab_list":
      result = await listTabs(params);
      if (checked.filterTabs) {
        const hiddenCount = result.tabs.filter((tab) => !guard.isAgentTab(tab.id)).length;
        result.tabs = result.tabs.filter((tab) => guard.isAgentTab(tab.id));
        result.count = result.tabs.length;
        result.summary = {
          total_tabs: result.tabs.length,
          active_tab: result.tabs.find((tab) => tab.active)?.id || null,
          hidden_user_tabs: hiddenCount,
          note: "claude-for-arc: only tabs opened by the agent are listed; the user's own tabs are hidden.",
        };
      }
      return result;
    case "tab_switch":
      return switchToTab(params.tab_id);
    case "element_get_state":
      return sendToContentScript('get_element_state', params, params.tab_id);
    case "get_bookmarks":
      return getBookmarks(params);
    case "add_bookmark":
      return addBookmark(params);
    case "get_history":
      return getHistory(params);
    case "get_selected_text":
      return getSelectedText(params);
    case "page_scroll":
      return sendToContentScript('page_scroll', params, params.tab_id);
    case "get_page_links":
      return sendToContentScript('get_page_links', params, params.tab_id);
    case "page_style":
      return sendToContentScript('page_style', params, params.tab_id);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// Content script communication, targeting a specific tab or the active one
// Resolve the tab a tool should act on: an explicit tab id, else the active tab.
async function resolveTargetTab(tabId = null) {
  if (tabId) {
    try {
      return await browser.tabs.get(tabId);
    } catch (error) {
      // tabs.get also rejects for reasons other than "not found" (bad id type,
      // incognito access denied), so keep the underlying message.
      throw new Error(`Tab ${tabId} not found or inaccessible: ${error.message}`);
    }
  }

  // tabs.query legitimately returns [] when there is no focused normal window.
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab) {
    throw new Error('No active tab found');
  }
  return activeTab;
}

async function sendToContentScript(action, data, targetTabId = null) {
  const targetTab = await resolveTargetTab(targetTabId);

  // Ensure content script is available in the target tab
  await ensureContentScriptReady(targetTab.id);
  
  return new Promise((resolve, reject) => {
    browser.tabs.sendMessage(targetTab.id, { action, data }, (response) => {
      if (browser.runtime.lastError) {
        reject(new Error(`Tab ${targetTab.id}: ${browser.runtime.lastError.message}`));
      } else if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(`Tab ${targetTab.id}: ${response?.error || 'Unknown error'}`));
      }
    });
  });
}

// claude-for-arc: resolve once a tab has finished loading, so the next tool
// call sees the new page rather than the one being replaced. With
// requireLoading, a "complete" is only trusted after a "loading" (the old page
// is already complete); a same-document #hash change never loads, so that case
// resolves after 2s without one.
function waitForTabLoad(tabId, timeout = 15000, { requireLoading = false } = {}) {
  return new Promise((resolve) => {
    let seenLoading = !requireLoading;
    let finished = false;
    let noLoadTimer = null;
    const finish = (loaded) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      clearTimeout(noLoadTimer);
      resolve(loaded);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") seenLoading = true;
      if (info.status === "complete" && seenLoading) finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), timeout);
    if (requireLoading) {
      noLoadTimer = setTimeout(() => { if (!seenLoading) finish(true); }, 2000);
    } else {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete" && tab.url && tab.url !== "about:blank") finish(true);
      }).catch(() => finish(false));
    }
  });
}

async function navigateToUrl(url, waitFor, timeout = 10000, tabId = null, openNewTab = false) {
  if (openNewTab) {
    const created = await createSingleTab(url, true, waitFor, timeout);
    return { ...created, opened_new_tab: true };
  }
  const activeTab = await resolveTargetTab(tabId);

  const loaded = waitForTabLoad(activeTab.id, timeout, { requireLoading: true });
  await browser.tabs.update(activeTab.id, { url });
  const didLoad = await loaded;
  
  // If waitFor is specified, wait for the element to appear
  if (waitFor) {
    try {
      await waitForElement(activeTab.id, waitFor, timeout);
    } catch (error) {
      return { success: true, tabId: activeTab.id, warning: `Navigation completed but wait condition failed: ${error.message}` };
    }
  }
  
  const after = await browser.tabs.get(activeTab.id).catch(() => null);
  return {
    success: true,
    tabId: activeTab.id,
    url: after?.url || url,
    title: after?.title,
    ...(didLoad ? {} : { warning: `Page did not finish loading within ${timeout}ms` }),
  };
}

async function waitForElement(tabId, selector, timeout = 5000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const result = await browser.tabs.sendMessage(tabId, {
        action: 'wait_for',
        data: { 
          condition_type: 'element_visible', 
          selector: selector,
          timeout: 1000
        }
      });
      
      if (result.success) {
        return true;
      }
    } catch (error) {
      // Content script might not be ready yet, continue waiting
    }
    
    // Wait 500ms before next check
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  throw new Error(`Timeout waiting for element: ${selector}`);
}

// Tab management, single and batched
async function createTab(params) {
  const { 
    url, 
    urls, 
    count = 1, 
    active = true, 
    wait_for, 
    timeout = 10000,
    batch_settings = {}
  } = params;
  
  // Smart hint: If creating single tab but description suggests multiple, provide guidance
  if (count === 1 && !urls) {
    console.log(`💡 Single tab creation. For multiple identical tabs, use count parameter: {"url": "${url}", "count": N}`);
  }
  
  // Validate parameters
  const validation = validateTabCreateParams(params);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  
  console.log(`🎯 Tab creation request:`, { url, urls, count, batch_settings, hasBatchSettings: !!batch_settings });
  
  // Determine operation type
  if (urls && urls.length > 0) {
    // Batch creation with multiple URLs
    console.log(`🚀 Using batch mode with ${urls.length} URLs`);
    return await createTabsBatch(urls, active, wait_for, timeout, batch_settings);
  } else if (url && count > 1) {
    // Batch creation with same URL repeated
    console.log(`🔄 Using repeat mode: ${count} copies of ${url}`);
    const urlArray = Array(count).fill(url);
    return await createTabsBatch(urlArray, active, wait_for, timeout, batch_settings);
  } else {
    // Single tab creation
    console.log(`📱 Using single tab mode for: ${url || 'about:blank'}`);
    return await createSingleTab(url, active, wait_for, timeout);
  }
}

// Parameter validation
function validateTabCreateParams(params) {
  const { url, urls, count = 1 } = params;
  
  // Check for conflicting parameters
  if (url && urls) {
    return { valid: false, error: "Cannot specify both 'url' and 'urls' parameters" };
  }
  
  if (urls && count > 1) {
    return { valid: false, error: "Cannot use 'count' with 'urls' array" };
  }
  
  // Allow empty URL for about:blank tabs
  if (!url && !urls && count > 1) {
    return { valid: false, error: "Must specify 'url' when using 'count' parameter" };
  }
  
  // Validate URLs array
  if (urls) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { valid: false, error: "'urls' must be a non-empty array" };
    }
    
    if (urls.length > 100) {
      return { valid: false, error: "Maximum 100 URLs allowed in batch operation" };
    }
    
    // Validate each URL
    for (let i = 0; i < urls.length; i++) {
      if (typeof urls[i] !== 'string' || !urls[i].trim()) {
        return { valid: false, error: `Invalid URL at index ${i}: must be a non-empty string` };
      }
    }
  }
  
  // Validate count. Both comparisons coerce, so a string or fractional count
  // passed the range check and then broke Array(count): "5" yielded a single tab
  // reported as a full success, 2.5 threw an opaque "Invalid array length".
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    return { valid: false, error: "Count must be an integer between 1 and 50" };
  }
  
  return { valid: true };
}

// Single tab creation
async function createSingleTab(url, active, wait_for, timeout) {
  const createProperties = { active };
  if (url) {
    createProperties.url = url;
  }
  
  console.log(`🔍 Creating single tab with properties:`, createProperties);
  const newTab = await browser.tabs.create(createProperties);
  console.log(`📝 Tab created:`, { id: newTab.id, url: newTab.url, pendingUrl: newTab.pendingUrl });
  
  // Wait for the page to load (claude-for-arc: was a fixed 500ms)
  if (url) {
    await waitForTabLoad(newTab.id, timeout);
    
    // Check if tab loaded correctly
    try {
      const updatedTab = await browser.tabs.get(newTab.id);
      console.log(`🔄 Tab after load check:`, { id: updatedTab.id, url: updatedTab.url, status: updatedTab.status });
      
      // If URL was provided and wait_for is specified, wait for the element
      if (wait_for) {
        try {
          await waitForElement(newTab.id, wait_for, timeout);
        } catch (error) {
          return {
            success: true,
            tab_id: newTab.id,
            url: updatedTab.url,
            actual_url: updatedTab.url,
            requested_url: url,
            warning: `Tab created but wait condition failed: ${error.message}`
          };
        }
      }
      
      return {
        success: true,
        tab_id: newTab.id,
        url: updatedTab.url || updatedTab.pendingUrl || url,
        actual_url: updatedTab.url || updatedTab.pendingUrl,
        requested_url: url,
        active: updatedTab.active,
        status: updatedTab.status,
        title: updatedTab.title || 'New Tab',
        note: updatedTab.url === 'about:blank' && updatedTab.pendingUrl ? 'Tab is still loading' : undefined
      };
    } catch (error) {
      console.error(`❌ Error checking tab status:`, error);
      return {
        success: true,
        tab_id: newTab.id,
        url: newTab.url || 'about:blank',
        actual_url: newTab.url,
        requested_url: url,
        active: newTab.active,
        title: newTab.title || 'New Tab',
        warning: `Tab created but status check failed: ${error.message}`
      };
    }
  }
  
  return {
    success: true,
    tab_id: newTab.id,
    url: newTab.url || 'about:blank',
    active: newTab.active,
    title: newTab.title || 'New Tab'
  };
}

// Batch tab creation with performance throttling
async function createTabsBatch(urls, active, wait_for, timeout, batch_settings = {}) {
  console.log('🔍 createTabsBatch called with:', { urls: urls.length, batch_settings });
  
  const {
    chunk_size: requested_chunk_size = 5,
    delay_between_chunks = 1000,
    delay_between_tabs = 200
  } = batch_settings || {};

  // A destructuring default only covers undefined, so an explicit 0 or a negative
  // survived and the chunk loop never advanced - an unbounded spin in the worker
  // while the server call timed out at 30s.
  const chunk_size = Number.isInteger(requested_chunk_size) && requested_chunk_size > 0
    ? requested_chunk_size
    : 5;

  const startTime = Date.now();
  const totalTabs = urls.length;
  const createdTabs = [];
  const errors = [];
  
  // Performance warnings
  const warnings = [];
  if (totalTabs > 20) {
    warnings.push(`Creating ${totalTabs} tabs may impact browser performance`);
  }
  if (totalTabs > 45) {
    warnings.push(`Large batch (${totalTabs} tabs) may hit Chrome's tab limits or cause memory issues`);
  }
  
  console.log(`🚀 Starting batch tab creation: ${totalTabs} tabs in chunks of ${chunk_size}`);
  
  // Process in chunks
  for (let chunkStart = 0; chunkStart < urls.length; chunkStart += chunk_size) {
    const chunkEnd = Math.min(chunkStart + chunk_size, urls.length);
    const chunk = urls.slice(chunkStart, chunkEnd);
    const chunkIndex = Math.floor(chunkStart / chunk_size) + 1;
    const totalChunks = Math.ceil(urls.length / chunk_size);
    
    // Reduced logging for better performance
    if (totalTabs > 10) {
      console.log(`📦 Chunk ${chunkIndex}/${totalChunks}`);
    }
    
    // Create tabs in current chunk with delays
    for (let i = 0; i < chunk.length; i++) {
      const url = chunk[i];
      const globalIndex = chunkStart + i;
      const isLastTab = globalIndex === totalTabs - 1;
      
      try {
        // Only activate the very last tab if active=true
        const shouldActivate = active && isLastTab;
        
        const tab = await browser.tabs.create({
          url: url,
          active: shouldActivate
        });
        
        // Wait a moment and check actual URL
        await new Promise(resolve => setTimeout(resolve, 300));
        const updatedTab = await browser.tabs.get(tab.id);
        
        createdTabs.push({
          tab_id: tab.id,
          url: updatedTab.url || url,
          requested_url: url,
          index: globalIndex,
          active: updatedTab.active,
          title: updatedTab.title || `Tab ${globalIndex + 1}`
        });
        
        // Only log for small batches to avoid context overflow
        if (totalTabs <= 5) {
          console.log(`✅ Created tab ${globalIndex + 1}/${totalTabs}: ${url} (ID: ${tab.id})`);
        }
        
        // Wait between individual tabs (except last in chunk)
        if (i < chunk.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay_between_tabs));
        }
        
      } catch (error) {
        console.error(`❌ Failed to create tab ${globalIndex + 1}: ${error.message}`);
        errors.push({
          index: globalIndex,
          url: url,
          error: error.message
        });
      }
    }
    
    // Wait between chunks (except after last chunk)
    if (chunkEnd < urls.length) {
      if (totalTabs <= 10) {
        console.log(`⏳ Waiting ${delay_between_chunks}ms before next chunk...`);
      }
      await new Promise(resolve => setTimeout(resolve, delay_between_chunks));
    }
  }
  
  const executionTime = Date.now() - startTime;
  const successCount = createdTabs.length;
  const errorCount = errors.length;
  
  console.log(`🏁 Batch creation complete: ${successCount}/${totalTabs} successful in ${executionTime}ms`);
  
  // Prepare result - simplified to avoid context overflow
  const result = {
    success: errorCount === 0,
    batch_operation: true,
    summary: {
      total_requested: totalTabs,
      successful: successCount,
      failed: errorCount,
      chunks_processed: Math.ceil(totalTabs / chunk_size),
      execution_time_ms: executionTime
    },
    // Only include full tab details for small batches
    created_tabs: totalTabs <= 10 ? createdTabs : createdTabs.map(tab => ({
      tab_id: tab.tab_id,
      url: tab.url
    }))
  };
  
  // Add warnings if any
  if (warnings.length > 0) {
    result.warnings = warnings;
  }
  
  // Add errors if any
  if (errors.length > 0) {
    result.errors = errors;
    result.partial_success = successCount > 0;
  }
  
  // Add active tab info
  const activeTabs = createdTabs.filter(tab => tab.active);
  if (activeTabs.length > 0) {
    result.active_tab = activeTabs[0];
  }
  
  return result;
}

async function closeTabs(params) {
  const { tab_id, tab_ids } = params;
  
  let tabsToClose = [];
  
  if (tab_ids && Array.isArray(tab_ids)) {
    // Close multiple tabs
    tabsToClose = tab_ids;
  } else if (tab_id) {
    // Close specific tab
    tabsToClose = [tab_id];
  } else {
    // Close current tab
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab) {
      tabsToClose = [activeTab.id];
    }
  }
  
  if (tabsToClose.length === 0) {
    throw new Error('No tabs specified to close');
  }
  
  // Close tabs
  await browser.tabs.remove(tabsToClose);
  
  return {
    success: true,
    closed_tabs: tabsToClose,
    count: tabsToClose.length
  };
}

async function listTabs(params) {
  const { 
    current_window_only = true, 
    include_details = true,
    check_content_script = false 
  } = params;
  
  const queryOptions = {};
  if (current_window_only) {
    queryOptions.currentWindow = true;
  }
  
  const tabs = await browser.tabs.query(queryOptions);
  
  // Check content script status if requested
  const contentScriptStatuses = new Map();
  if (check_content_script) {
    const statusPromises = tabs.map(async (tab) => {
      try {
        const status = await getTabContentScriptStatus(tab.id);
        return [tab.id, status];
      } catch (error) {
        return [tab.id, { ready: false, reason: 'error', error: error.message }];
      }
    });
    
    const results = await Promise.all(statusPromises);
    results.forEach(([tabId, status]) => {
      contentScriptStatuses.set(tabId, status);
    });
  }
  
  const tabList = tabs.map(tab => {
    const basicInfo = {
      id: tab.id,
      url: tab.url,
      active: tab.active,
      title: tab.title
    };
    
    // Add content script status if checked
    if (check_content_script) {
      const scriptStatus = contentScriptStatuses.get(tab.id);
      basicInfo.content_script = {
        ready: scriptStatus?.ready || false,
        reason: scriptStatus?.reason || 'unknown',
        injectable: isInjectableUrl(tab.url)
      };
    }
    
    if (include_details) {
      return {
        ...basicInfo,
        index: tab.index,
        pinned: tab.pinned,
        status: tab.status,
        favIconUrl: tab.favIconUrl,
        windowId: tab.windowId,
        incognito: tab.incognito
      };
    }
    
    return basicInfo;
  });
  
  // Calculate summary statistics
  const summary = {
    total_tabs: tabList.length,
    active_tab: tabs.find(tab => tab.active)?.id || null
  };
  
  if (check_content_script) {
    const readyTabs = tabList.filter(tab => tab.content_script?.ready).length;
    const injectableTabs = tabList.filter(tab => tab.content_script?.injectable).length;
    
    summary.content_script_stats = {
      ready_count: readyTabs,
      injectable_count: injectableTabs,
      restricted_count: tabList.length - injectableTabs
    };
  }
  
  return {
    success: true,
    tabs: tabList,
    count: tabList.length,
    summary
  };
}

async function switchToTab(tabId) {
  // First, get tab info to ensure it exists
  const tab = await browser.tabs.get(tabId);
  
  if (!tab) {
    throw new Error(`Tab with ID ${tabId} not found`);
  }
  
  // Switch to the tab
  await browser.tabs.update(tabId, { active: true });
  
  // Also focus the window containing the tab
  await browser.windows.update(tab.windowId, { focused: true });
  
  return {
    success: true,
    tab_id: tabId,
    url: tab.url,
    title: tab.title,
    window_id: tab.windowId
  };
}

// Workspace and Reference Management Functions
async function getBookmarks(params) {
  const { query } = params;
  
  let bookmarks;
  if (query) {
    bookmarks = await browser.bookmarks.search(query);
  } else {
    bookmarks = await browser.bookmarks.getTree();
  }
  
  return {
    success: true,
    bookmarks,
    count: bookmarks.length
  };
}

async function addBookmark(params) {
  const { title, url, parentId } = params;
  
  const bookmark = await browser.bookmarks.create({
    title,
    url,
    parentId
  });
  
  return {
    success: true,
    bookmark
  };
}

// History Management Function
async function getHistory(params) {
  const {
    keywords = "",
    start_date,
    end_date,
    domains = [],
    min_visit_count = 1,
    max_results = 50,
    sort_by = "visit_time",
    sort_order = "desc"
  } = params;

  try {
    // Browser History API search configuration
    const searchQuery = {
      text: keywords,
      maxResults: Math.min(max_results * 3, 1000), // Over-fetch for filtering
    };

    // Add date range if specified
    if (start_date) {
      searchQuery.startTime = new Date(start_date).getTime();
    }
    if (end_date) {
      searchQuery.endTime = new Date(end_date).getTime();
    }

    // Execute history search
    const historyItems = await browser.history.search(searchQuery);
    
    // Apply advanced filters
    let filteredItems = historyItems.filter(item => {
      // Domain filter
      if (domains.length > 0) {
        try {
          const itemDomain = new URL(item.url).hostname;
          if (!domains.some(domain => itemDomain.includes(domain))) {
            return false;
          }
        } catch (e) {
          // Skip items with invalid URLs
          return false;
        }
      }
      
      // Visit count filter
      if (item.visitCount < min_visit_count) {
        return false;
      }
      
      return true;
    });

    // Sort results
    filteredItems.sort((a, b) => {
      let aVal, bVal;
      switch (sort_by) {
        case "visit_count":
          aVal = a.visitCount;
          bVal = b.visitCount;
          break;
        case "title":
          aVal = (a.title || "").toLowerCase();
          bVal = (b.title || "").toLowerCase();
          break;
        default: // visit_time
          aVal = a.lastVisitTime;
          bVal = b.lastVisitTime;
      }
      
      if (sort_order === "asc") {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });

    // Limit results
    const results = filteredItems.slice(0, max_results);
    
    // Format response with comprehensive metadata
    return {
      success: true,
      history_items: results.map(item => {
        let domain;
        try {
          domain = new URL(item.url).hostname;
        } catch (e) {
          domain = "invalid-url";
        }
        
        return {
          id: item.id,
          url: item.url,
          title: item.title || "Untitled",
          last_visit_time: new Date(item.lastVisitTime).toISOString(),
          visit_count: item.visitCount,
          domain: domain,
          typed_count: item.typedCount || 0
        };
      }),
      metadata: {
        total_found: filteredItems.length,
        returned_count: results.length,
        search_params: {
          keywords: keywords || null,
          date_range: start_date && end_date ?
            `${start_date} to ${end_date}` :
            start_date ? `from ${start_date}` :
            end_date ? `until ${end_date}` : null,
          domains: domains.length > 0 ? domains : null,
          min_visit_count,
          sort_by,
          sort_order
        },
        execution_time: new Date().toISOString(),
        over_fetched: historyItems.length,
        filters_applied: {
          domain_filter: domains.length > 0,
          visit_count_filter: min_visit_count > 1,
          date_filter: !!(start_date || end_date),
          keyword_filter: !!keywords
        }
      }
    };

  } catch (error) {
    // Returning an empty history_items here rendered as "No history items
    // found" via formatHistoryResult, which never reads success/error — a
    // permissions failure was indistinguishable from an empty result.
    throw new Error(`History search failed: ${error.message}`);
  }
}

// Selected Text Management Function
async function getSelectedText(params) {
  const {
    include_metadata = true,
    max_length = 10000,
    tab_id
  } = params;

  try {
    const targetTab = await resolveTargetTab(tab_id);

    // Execute script to get selected text - handle browser differences
    let results;
    if (browser.scripting) {
      // Chrome MV3
      results = await browser.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: getSelectionFunction
      });
    } else {
      // Firefox MV2
      results = await browser.tabs.executeScript(targetTab.id, {
        code: `(${getSelectionFunction.toString()})()`
      });
    }

    const result = results[0]?.result || results[0];
    
    if (!result) {
      throw new Error("Failed to execute selection script");
    }

    if (!result.hasSelection) {
      return {
        success: true,
        selected_text: "",
        has_selection: false,
        message: "No text is currently selected on the page",
        metadata: {
          execution_time: new Date().toISOString(),
          tab_info: {
            id: targetTab.id,
            url: targetTab.url,
            title: targetTab.title
          }
        }
      };
    }

    // Truncate text if it exceeds max_length
    let selectedText = result.text;
    let truncated = false;
    if (selectedText.length > max_length) {
      selectedText = selectedText.substring(0, max_length);
      truncated = true;
    }

    const response = {
      success: true,
      selected_text: selectedText,
      has_selection: true,
      character_count: result.text.length,
      truncated: truncated,
      metadata: {
        execution_time: new Date().toISOString(),
        tab_info: {
          id: targetTab.id,
          url: targetTab.url,
          title: targetTab.title
        }
      }
    };

    // Include detailed metadata if requested
    if (include_metadata && result.metadata) {
      response.selection_metadata = result.metadata;
    }

    return response;

  } catch (error) {
    // Throw rather than returning has_selection:false, which the formatter
    // renders as "No text selected" - a failure indistinguishable from success.
    throw new Error(`Failed to get selected text: ${error.message}`);
  }
}

// Function to execute in page context
function getSelectionFunction() {
  const selection = window.getSelection();
  const selectedText = selection.toString();
  
  if (!selectedText) {
    return {
      text: "",
      hasSelection: false,
      metadata: null
    };
  }

  // Get metadata about the selection
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  // Get parent element info
  const commonAncestor = range.commonAncestorContainer;
  const parentElement = commonAncestor.nodeType === Node.TEXT_NODE
    ? commonAncestor.parentElement
    : commonAncestor;
  
  const metadata = {
    length: selectedText.length,
    word_count: selectedText.trim().split(/\s+/).filter(word => word.length > 0).length,
    line_count: selectedText.split('\n').length,
    position: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    parent_element: {
      tag_name: parentElement.tagName?.toLowerCase(),
      class_name: parentElement.className,
      id: parentElement.id,
      text_content_length: parentElement.textContent?.length || 0
    },
    page_info: {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname
    },
    selection_info: {
      anchor_offset: selection.anchorOffset,
      focus_offset: selection.focusOffset,
      range_count: selection.rangeCount,
      is_collapsed: selection.isCollapsed
    }
  };

  return {
    text: selectedText,
    hasSelection: true,
    metadata: metadata
  };
}

// ---------------------------------------------------------------------------
// Startup, reconnection and popup messages

function tryConnect() {
  connectionManager.connect().catch((error) => console.log("claude-for-arc:", error.message));
}

// MV3 workers sleep; an alarm wakes this one to reconnect when the server
// (started by Claude) comes up later or restarts.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !connectionManager.getStatus().connected) tryConnect();
});
chrome.runtime.onStartup.addListener(tryConnect);
chrome.runtime.onInstalled.addListener(tryConnect);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // A key adopted from key.json by the connection being set up is not a
  // reason to tear that connection down.
  if (changes.port || (changes.token && changes.token.newValue !== connectionManager.activeToken)) {
    connectionManager.closeSocket();
    tryConnect();
  } else if (changes.allowHistory || changes.scope) {
    connectionManager.reregister();
  }
  if (changes.paused || changes.lang) guard.setBadge(connectionManager.getStatus().state);
});

// Only this extension's own pages (the popup) may ask for status; content
// scripts run inside web pages and are ignored.
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (request.action === "getStatus") {
    sendResponse({ ...connectionManager.getStatus(), agentTabs: guard.agentTabIds().length });
  } else if (request.action === "reconnect") {
    connectionManager.connect()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  return false;
});

tryConnect();
