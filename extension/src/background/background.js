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

async function ensureContentScriptReady(tabId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Test if content script is responsive
      const response = await pingContentScript(tabId, 2000);

      if (response && response.success) {
        console.log(`✅ Content script ready in tab ${tabId}`);
        return true;
      }
    } catch (error) {
      console.log(`⚠️ Content script not responsive in tab ${tabId}, attempt ${attempt}/${retries}`);
      
      if (attempt === retries) {
        // Last attempt - try to inject content script
        try {
          const tab = await browser.tabs.get(tabId);
          
          // Check if tab URL is injectable (not chrome://, chrome-extension://, etc.)
          if (!isInjectableUrl(tab.url)) {
            throw new Error(`Cannot inject content script into ${tab.url} - restricted URL`);
          }
          
          console.log(`🔄 Injecting content script into tab ${tabId}`);
          
          // Use appropriate API based on browser
          if (browser.scripting) {
            // Chrome MV3
            await browser.scripting.executeScript({
              target: { tabId: tabId },
              files: ['src/content/content.js']
            });
          } else {
            // Firefox MV2 - check if already injected first
            try {
              const result = await browser.tabs.executeScript(tabId, {
                code: 'typeof window.OpenDiaContentScriptLoaded !== "undefined"'
              });
              
              if (result && result[0]) {
                console.log(`🔄 Content script already present in tab ${tabId}`);
                return true;
              }
            } catch (e) {
              // Continue with injection if check fails
            }
            
            await browser.tabs.executeScript(tabId, {
              file: 'src/content/content.js'
            });
          }
          
          // Wait a moment for script to initialize
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Test again
          const testResponse = await pingContentScript(tabId, 3000);

          if (testResponse && testResponse.success) {
            console.log(`✅ Content script successfully injected into tab ${tabId}`);
            return true;
          }
          
        } catch (injectionError) {
          throw new Error(`Failed to inject content script into tab ${tabId}: ${injectionError.message}`);
        }
      }
      
      // Wait before retry
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  throw new Error(`Content script not available in tab ${tabId} after ${retries} attempts`);
}

// Check if URL allows content script injection
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
function getAvailableTools() {
  return [
    /*
    🎯 BACKGROUND TAB WORKFLOW GUIDE:
    
    1. DISCOVER TABS: Use tab_list with check_content_script=false to see all tabs and their IDs
    2. TARGET SPECIFIC TABS: Add tab_id parameter to any tool to work on background tabs
    3. MULTI-TAB OPERATIONS: Process multiple tabs without switching between them
    
    Example Multi-Tab Workflow:
    - tab_list({check_content_script: false}) → Get tab IDs quickly
    - page_analyze({intent_hint: "article", tab_id: 12345}) → Analyze background research tab
    - page_extract_content({content_type: "article", tab_id: 12345}) → Extract content without switching
    - get_selected_text({tab_id: 67890}) → Get quotes from another background tab
    
    Perfect for: Research workflows, content analysis, form processing, social media management
    */
    
    // Page Analysis Tools
    {
      name: "page_analyze",
      description: "🔍 BACKGROUND TAB READY: Analyze any tab without switching to it! Two-phase intelligent page analysis with token efficiency optimization. Use tab_id parameter to analyze background tabs while staying on current page.",
      inputSchema: {
        type: "object",
        examples: [
          { intent_hint: "analyze", phase: "discover" },  // Current tab quick analysis
          { intent_hint: "login", tab_id: 12345 },  // Background tab login form analysis
          { intent_hint: "post_create", tab_id: 67890, phase: "detailed" }  // Background tab detailed analysis
        ],
        properties: {
          intent_hint: {
            type: "string",
            description: "User intent: login, signup, search, post_create, comment, menu, submit, etc."
          },
          phase: {
            type: "string",
            enum: ["discover", "detailed"],
            default: "discover",
            description: "Analysis phase: 'discover' for quick scan (<100 tokens), 'detailed' for full analysis"
          },
          focus_areas: {
            type: "array",
            items: { type: "string" },
            description: "Areas to analyze in detail: buttons, forms, navigation, search_elements"
          },
          max_results: {
            type: "number",
            default: 5,
            maximum: 15,
            description: "Maximum number of elements to return"
          },
          element_ids: {
            type: "array",
            items: { type: "string" },
            description: "Expand specific quick match IDs from discover phase (e.g. ['q1', 'q2'])"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Specify tab ID to analyze background tabs without switching! Get tab IDs from tab_list. If omitted, analyzes current active tab."
          }
        },
        required: ["intent_hint"]
      }
    },
    {
      name: "page_extract_content",
      description: "📄 BACKGROUND TAB READY: Extract content from any tab without switching! Perfect for analyzing multiple research tabs, articles, or pages simultaneously. Use tab_id to target specific background tabs.",
      inputSchema: {
        type: "object",
        examples: [
          { content_type: "article" },  // Extract from current tab
          { content_type: "article", tab_id: 12345 },  // Extract from background research tab
          { content_type: "posts", tab_id: 67890, max_items: 10 }  // Extract social media posts from background tab
        ],
        properties: {
          content_type: {
            type: "string",
            enum: ["article", "search_results", "posts"],
            description: "Type of content to extract"
          },
          max_items: {
            type: "number",
            description: "Maximum number of items to extract (for lists/collections)",
            default: 20
          },
          summarize: {
            type: "boolean",
            default: true,
            description: "Return summary instead of full content to save tokens"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Extract content from specific background tab without switching! Use tab_list to get tab IDs. Perfect for processing multiple research tabs."
          }
        },
        required: ["content_type"]
      }
    },
    
    // Element Interaction Tools
    {
      name: "element_click",
      description: "🖱️ BACKGROUND TAB READY: Click elements in any tab without switching! Perform actions on background tabs while staying on current page. Use tab_id to target specific tabs.",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Unique element identifier from page_analyze"
          },
          click_type: {
            type: "string",
            enum: ["left", "right", "double"],
            default: "left"
          },
          wait_after: {
            type: "number",
            description: "Milliseconds to wait after click",
            default: 500
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Click elements in background tabs without switching! Get tab IDs from tab_list to interact with multiple tabs efficiently."
          }
        },
        required: ["element_id"]
      }
    },
    {
      name: "element_fill",
      description: "✏️ BACKGROUND TAB READY: Fill forms in any tab without switching! Enhanced focus and event simulation for modern web apps. Use tab_id to fill forms in background tabs.",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Unique element identifier from page_analyze"
          },
          value: {
            type: "string",
            description: "Text value to input"
          },
          clear_first: {
            type: "boolean",
            description: "Clear existing content before filling",
            default: true
          },
          force_focus: {
            type: "boolean",
            description: "Use enhanced focus sequence with click simulation for modern apps",
            default: true
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Fill forms in background tabs without switching! Perfect for batch form filling across multiple tabs. Get tab IDs from tab_list."
          }
        },
        required: ["element_id", "value"]
      }
    },
    
    // Navigation Tools
    {
      name: "page_navigate",
      description: "Navigate CURRENT tab to a new URL. Use tab_create instead if you want to open a NEW tab with a URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to"
          },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after navigation (ensures page is ready)"
          },
          timeout: {
            type: "number",
            description: "Maximum wait time in milliseconds",
            default: 10000
          }
        },
        required: ["url"]
      }
    },
    {
      name: "page_wait_for",
      description: "Wait for specific element or condition on current page",
      inputSchema: {
        type: "object",
        properties: {
          condition_type: {
            type: "string",
            enum: ["element_visible", "text_present"],
            description: "Type of condition to wait for"
          },
          selector: {
            type: "string",
            description: "CSS selector for element-based conditions"
          },
          text: {
            type: "string",
            description: "Text to wait for (when condition_type is 'text_present')"
          },
          timeout: {
            type: "number",
            description: "Maximum wait time in milliseconds",
            default: 5000
          }
        },
        required: ["condition_type"]
      }
    },
    
    // Tab Management Tools
    {
      name: "tab_create",
      description: "Creates tabs. CRITICAL: For multiple identical tabs, ALWAYS use 'count' parameter! Examples: {url: 'https://x.com', count: 5} creates 5 Twitter tabs. {url: 'https://github.com', count: 10} creates 10 GitHub tabs. Single tab: {url: 'https://example.com'}. Multiple different URLs: {urls: ['url1', 'url2']}.",
      inputSchema: {
        type: "object",
        examples: [
          { url: "https://x.com", count: 5 },  // CORRECT: Creates 5 identical Twitter tabs in one batch
          { url: "https://github.com", count: 10 },  // CORRECT: Creates 10 GitHub tabs 
          { urls: ["https://x.com/post1", "https://x.com/post2", "https://google.com"] },  // CORRECT: Different URLs in batch
          { url: "https://example.com" }  // Single tab only
        ],
        properties: {
          url: {
            type: "string",
            description: "Single URL to open. Can be used with 'count' to create multiple identical tabs"
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description: "PREFERRED FOR MULTIPLE URLS: Array of URLs to open ALL AT ONCE in a single batch operation. Pass ALL URLs here instead of making multiple calls! Example: ['https://x.com/post1', 'https://x.com/post2', 'https://google.com']",
            maxItems: 100
          },
          count: {
            type: "number",
            default: 1,
            minimum: 1,
            maximum: 50,
            description: "REQUIRED FOR MULTIPLE IDENTICAL TABS: Set this to N to create N copies of the same URL. For '5 Twitter tabs' use count=5 with url='https://x.com'. DO NOT make 5 separate calls!"
          },
          active: {
            type: "boolean",
            default: true,
            description: "Whether to activate the last created tab (single tab only)"
          },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after tab creation (single tab only)"
          },
          timeout: {
            type: "number",
            default: 10000,
            description: "Maximum wait time per tab in milliseconds"
          },
          batch_settings: {
            type: "object",
            description: "Performance control settings for batch operations",
            properties: {
              chunk_size: {
                type: "number",
                default: 5,
                minimum: 1,
                maximum: 10,
                description: "Number of tabs to create per batch"
              },
              delay_between_chunks: {
                type: "number",
                default: 1000,
                minimum: 100,
                maximum: 5000,
                description: "Delay between batches in milliseconds"
              },
              delay_between_tabs: {
                type: "number",
                default: 200,
                minimum: 50,
                maximum: 1000,
                description: "Delay between individual tabs in milliseconds"
              }
            }
          }
        }
      }
    },
    {
      name: "tab_close",
      description: "Close specific tab(s) by ID or close current tab",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Specific tab ID to close (optional, closes current tab if not provided)"
          },
          tab_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of tab IDs to close multiple tabs"
          }
        }
      }
    },
    {
      name: "tab_list",
      description: "📋 TAB DISCOVERY: Get list of all open tabs with IDs for background tab targeting! Shows content script readiness status and tab details. Essential for multi-tab workflows - use tab IDs with other tools to work on background tabs.",
      inputSchema: {
        type: "object",
        examples: [
          { check_content_script: false },  // RECOMMENDED: Default false to avoid timeouts
          { current_window_only: false, check_content_script: false }  // Get all tabs across windows
        ],
        properties: {
          current_window_only: {
            type: "boolean",
            default: true,
            description: "Only return tabs from the current window"
          },
          include_details: {
            type: "boolean",
            default: true,
            description: "Include additional tab details (title, favicon, etc.)"
          },
          check_content_script: {
            type: "boolean",
            default: false,
            description: "🔍 ESSENTIAL FOR BACKGROUND TABS: Check which tabs are ready for background operations! Set to true when planning multi-tab workflows to see which tabs can be targeted."
          }
        }
      }
    },
    {
      name: "tab_switch",
      description: "Switch to a specific tab by ID",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Tab ID to switch to"
          }
        },
        required: ["tab_id"]
      }
    },
    
    // Element State Tools
    {
      name: "element_get_state",
      description: "Get detailed state information for a specific element (disabled, clickable, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Element ID from page_analyze"
          }
        },
        required: ["element_id"]
      }
    },
    // Workspace and Reference Management Tools
    {
      name: "get_bookmarks",
      description: "Get all bookmarks or search for specific bookmarks",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for bookmarks (optional)"
          }
        }
      }
    },
    {
      name: "add_bookmark",
      description: "Add a new bookmark",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the bookmark"
          },
          url: {
            type: "string",
            description: "URL of the bookmark"
          },
          parentId: {
            type: "string",
            description: "ID of the parent folder (optional)"
          }
        },
        required: ["title", "url"]
      }
    },
    {
      name: "get_history",
      description: "Search browser history with comprehensive filters for finding previous work by date/keywords",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description: "Search keywords to match in page titles and URLs"
          },
          start_date: {
            type: "string",
            format: "date-time",
            description: "Start date for history search (ISO 8601 format)"
          },
          end_date: {
            type: "string",
            format: "date-time",
            description: "End date for history search (ISO 8601 format)"
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Filter by specific domains (e.g., ['github.com', 'stackoverflow.com'])"
          },
          min_visit_count: {
            type: "number",
            default: 1,
            description: "Minimum visit count threshold"
          },
          max_results: {
            type: "number",
            default: 50,
            maximum: 500,
            description: "Maximum number of results to return"
          },
          sort_by: {
            type: "string",
            enum: ["visit_time", "visit_count", "title"],
            default: "visit_time",
            description: "Sort results by visit time, visit count, or title"
          },
          sort_order: {
            type: "string",
            enum: ["desc", "asc"],
            default: "desc",
            description: "Sort order (descending or ascending)"
          }
        }
      }
    },
    {
      name: "get_selected_text",
      description: "📝 BACKGROUND TAB READY: Get selected text from any tab without switching! Perfect for collecting quotes, citations, or highlighted content from multiple research tabs simultaneously.",
      inputSchema: {
        type: "object",
        properties: {
          include_metadata: {
            type: "boolean",
            default: true,
            description: "Include metadata about the selection (element info, position, etc.)"
          },
          max_length: {
            type: "number",
            default: 10000,
            description: "Maximum length of text to return"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Get selected text from background tabs without switching! Perfect for collecting quotes or snippets from multiple research tabs."
          }
        }
      }
    },
    {
      name: "page_scroll",
      description: "📜 BACKGROUND TAB READY: Scroll any tab without switching! Critical for long pages. Navigate through content in background tabs while staying on current page. Use tab_id to target specific tabs.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right", "top", "bottom"],
            default: "down",
            description: "Direction to scroll"
          },
          amount: {
            type: "string",
            enum: ["small", "medium", "large", "page", "custom"],
            default: "medium",
            description: "Amount to scroll"
          },
          pixels: {
            type: "number",
            description: "Custom pixel amount (when amount is 'custom')"
          },
          smooth: {
            type: "boolean",
            default: true,
            description: "Use smooth scrolling animation"
          },
          element_id: {
            type: "string",
            description: "Scroll to specific element (overrides direction/amount)"
          },
          wait_after: {
            type: "number",
            default: 500,
            description: "Milliseconds to wait after scrolling"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Scroll content in background tabs without switching! Perfect for navigating long documents or pages in multiple tabs simultaneously."
          }
        }
      }
    },
    {
      name: "get_page_links",
      description: "Get all hyperlinks on the current page with filtering options",
      inputSchema: {
        type: "object",
        properties: {
          include_internal: {
            type: "boolean",
            default: true,
            description: "Include links pointing at the current domain"
          },
          include_external: {
            type: "boolean",
            default: true,
            description: "Include links pointing off the current domain"
          },
          domain_filter: {
            type: "string",
            description: "Only return links whose domain contains this string (optional)"
          },
          max_results: {
            type: "number",
            default: 100,
            maximum: 200,
            description: "Maximum links to return"
          }
        }
      }
    },
    {
      name: "page_style",
      description: "🎨 Transform page appearance with themes, colors, fonts, and fun effects! Apply preset themes like 'dark_hacker', 'retro_80s', or create custom styles. Perfect for making boring pages fun or improving readability.",
      inputSchema: {
        type: "object",
        examples: [
          { mode: "preset", theme: "dark_hacker" },
          { mode: "custom", background: "#000", text_color: "#00ff00", font: "monospace" },
          { mode: "ai_mood", mood: "cozy coffee shop vibes", intensity: "strong" },
          { mode: "effect", effect: "matrix_rain", duration: 30 }
        ],
        properties: {
          mode: {
            type: "string", 
            enum: ["preset", "custom", "ai_mood", "effect", "reset"],
            description: "Styling mode to use"
          },
          theme: {
            type: "string",
            enum: ["dark_hacker", "retro_80s", "rainbow_party", "minimalist_zen", "high_contrast", "cyberpunk", "pastel_dream", "newspaper"],
            description: "Preset theme name (when mode=preset)"
          },
          background: { 
            type: "string", 
            description: "Background color/gradient" 
          },
          text_color: { 
            type: "string", 
            description: "Text color" 
          },
          font: { 
            type: "string", 
            description: "Font family" 
          },
          font_size: { 
            type: "string", 
            description: "Font size (e.g., '1.2em', '16px')" 
          },
          mood: { 
            type: "string", 
            description: "Describe desired mood/feeling (when mode=ai_mood)" 
          },
          intensity: { 
            type: "string", 
            enum: ["subtle", "medium", "strong"], 
            default: "medium" 
          },
          effect: { 
            type: "string", 
            enum: ["matrix_rain", "floating_particles", "cursor_trail", "neon_glow", "typing_effect"] 
          },
          duration: { 
            type: "number", 
            description: "Effect duration in seconds", 
            default: 10 
          },
          remember: { 
            type: "boolean", 
            description: "Remember this style for this website", 
            default: false 
          }
        },
        required: ["mode"]
      }
    },
  ];
}

// Handle MCP requests with enhanced automation tools
async function handleMCPRequest(message) {
  const { id, method } = message;
  let host = "";

  try {
    // claude-for-arc policy: scope, read-only, pause, blocklist, history gate.
    let checked;
    try {
      checked = await guard.checkCall(method, message.params);
    } catch (error) {
      if (guard.isRefusal(error)) throw new Error(`claude-for-arc: ${error.message}`);
      throw error;
    }
    const params = checked.params;
    host = checked.host;

    let result;

    switch (method) {
      // New automation tools with background tab support
      case "page_analyze":
        result = await sendToContentScript('analyze', params, params.tab_id);
        break;
      case "page_extract_content":
        result = await sendToContentScript('extract_content', params, params.tab_id);
        break;
      case "element_click":
        result = await sendToContentScript('element_click', params, params.tab_id);
        break;
      case "element_fill":
        result = await sendToContentScript('element_fill', params, params.tab_id);
        break;
      case "page_navigate":
        result = await navigateToUrl(params.url, params.wait_for, params.timeout, params.tab_id, params.open_new_tab);
        await guard.rememberCreatedTabs(params.open_new_tab ? result : null);
        break;
      case "page_wait_for":
        result = await sendToContentScript('wait_for', params, params.tab_id);
        break;
        
      // Tab management tools
      case "tab_create":
        result = await createTab(params);
        await guard.rememberCreatedTabs(result);
        break;
      case "tab_close":
        result = await closeTabs(params);
        break;
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
        break;
      case "tab_switch":
        result = await switchToTab(params.tab_id);
        break;
        
      // Element state tools
      case "element_get_state":
        result = await sendToContentScript('get_element_state', params, params.tab_id);
        break;
      // Workspace and Reference Management Tools
      case "get_bookmarks":
        result = await getBookmarks(params);
        break;
      case "add_bookmark":
        result = await addBookmark(params);
        break;
      case "get_history":
        result = await getHistory(params);
        break;
      case "get_selected_text":
        result = await getSelectedText(params);
        break;
      case "page_scroll":
        result = await sendToContentScript('page_scroll', params, params.tab_id);
        break;
      case "get_page_links":
        result = await sendToContentScript('get_page_links', params, params.tab_id);
        break;
      case "page_style":
        result = await sendToContentScript('page_style', params, params.tab_id);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    guard.logCall({ tool: method, host, ok: true });
    // Send success response
    connectionManager.send({
      id,
      result,
    });
  } catch (error) {
    guard.logCall({ tool: method, host, ok: false, error: String(error.message).slice(0, 200) });
    // Send error response. Guarded because send() now throws when the socket
    // is down, and this is the last handler — an escape here would be an
    // unhandled rejection that loses the original error entirely.
    try {
      connectionManager.send({
        id,
        error: {
          message: error.message,
          code: -32603,
        },
      });
    } catch (sendError) {
      console.error('Could not deliver error response:', error.message, '|', sendError.message);
    }
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
  if (changes.paused) guard.setBadge(connectionManager.getStatus().state);
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
