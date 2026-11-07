// claude-for-arc: pure policy helpers shared by the background worker and the
// popup. No chrome.* access here, so test/policy.test.mjs can run it in node.

export const DEFAULT_SETTINGS = Object.freeze({
  token: "",
  lang: "", // "en" / "ru"; empty: follow Arc's language
  port: 5555,
  scope: "own",
  readOnly: false,
  paused: false,
  allowHistory: false,
  blocklist: [
    "1password.com",
    "bitwarden.com",
    "lastpass.com",
    "dashlane.com",
    "keepersecurity.com",
    "passwords.google.com",
  ],
});

// Extension galleries: a page there can install or remove extensions.
export const ALWAYS_BLOCKED = Object.freeze([
  "chromewebstore.google.com",
  "chrome.google.com",
  "microsoftedge.microsoft.com",
  "addons.mozilla.org",
]);

export const CONTENT_TOOLS = new Set([
  "page_analyze",
  "page_extract_content",
  "element_click",
  "element_fill",
  "page_wait_for",
  "element_get_state",
  "page_scroll",
  "get_page_links",
  "page_style",
  "press_key",
]);
export const WRITE_TOOLS = new Set(["element_click", "element_fill", "press_key", "page_style", "tab_close", "add_bookmark"]);
export const HISTORY_TOOLS = new Set(["get_history", "get_bookmarks", "add_bookmark"]);

// ---------------------------------------------------------------------------
// Helpers

export function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#:].*$/, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export function parseBlocklist(text) {
  const hosts = String(text || "")
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes("."));
  return [...new Set(hosts)];
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// Returns null when the URL may be opened or targeted, else a reason.
export function urlProblem(rawUrl, blocklist, { allowBlank = false } = {}) {
  if (allowBlank && (!rawUrl || rawUrl === "about:blank")) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return `«${String(rawUrl).slice(0, 80)}» — не похоже на адрес страницы`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `адреса «${url.protocol}» запрещены: разрешены только http и https`;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const domain of ALWAYS_BLOCKED) {
    if (hostMatches(host, domain)) return `${host} — магазин расширений, доступ к нему закрыт всегда`;
  }
  for (const domain of blocklist || []) {
    if (hostMatches(host, domain)) return `${host} в списке запрещённых сайтов claude-for-arc`;
  }
  return null;
}

export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

// Adjusts the tool list the extension advertises to match the settings.
export function decorateTools(tools, settings) {
  return tools
    .filter((tool) => settings.allowHistory || !HISTORY_TOOLS.has(tool.name))
    .map((tool) => {
      const copy = JSON.parse(JSON.stringify(tool));
      if (copy.name === "page_navigate" || copy.name === "page_wait_for") {
        copy.inputSchema.properties = copy.inputSchema.properties || {};
        copy.inputSchema.properties.tab_id = {
          type: "number",
          description: "Tab to act on (from tab_create or tab_list). If omitted, the current agent tab.",
        };
      }
      if (copy.name === "page_navigate") {
        copy.description = "Open an http(s) URL in the agent tab (a new one if there is none) and wait for it to load.";
      }
      if (settings.scope === "own" && (copy.name === "tab_create" || copy.name === "run_steps" || copy.name === "tab_list")) {
        copy.description +=
          " [Only tabs opened with tab_create (or pages they opened) are accessible; the user's own tabs are hidden.]";
      }
      return copy;
    });
}
