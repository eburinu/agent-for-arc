// Unit tests for the pure policy helpers. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  urlProblem,
  parseBlocklist,
  normalizeHost,
  decorateTools,
} from "../extension/src/background/policy.js";

const block = ["mybank.ru", "1password.com"];

test("only http(s) pages may be opened", () => {
  assert.equal(urlProblem("https://example.com/a", block), null);
  assert.equal(urlProblem("http://localhost:3000", block), null);
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "chrome://settings",
    "arc://settings",
    "chrome-extension://abc/options.html",
    "about:blank",
    "not a url",
  ]) {
    assert.notEqual(urlProblem(bad, block), null, bad);
  }
});

test("about:blank is allowed only where a blank tab makes sense", () => {
  assert.equal(urlProblem("about:blank", block, { allowBlank: true }), null);
  assert.equal(urlProblem(undefined, block, { allowBlank: true }), null);
});

test("blocklist covers subdomains but not look-alikes", () => {
  assert.notEqual(urlProblem("https://mybank.ru/", block), null);
  assert.notEqual(urlProblem("https://online.mybank.ru/login", block), null);
  assert.notEqual(urlProblem("https://my.1password.com", block), null);
  assert.equal(urlProblem("https://notmybank.ru/", block), null);
  assert.equal(urlProblem("https://mybank.ru.example.com/", block), null);
});

test("extension stores are always blocked", () => {
  assert.notEqual(urlProblem("https://chromewebstore.google.com/detail/x", []), null);
  assert.notEqual(urlProblem("https://chrome.google.com/webstore", []), null);
});

test("blocklist input is normalised", () => {
  assert.deepEqual(
    parseBlocklist("https://www.MyBank.ru/login\n*.example.com, foo  bad_host\nmybank.ru"),
    ["mybank.ru", "example.com"]
  );
  assert.equal(normalizeHost("HTTPS://Sub.Example.com:8443/path"), "sub.example.com");
});

test("history tools are hidden unless allowed", () => {
  const tools = ["get_history", "get_bookmarks", "add_bookmark", "tab_list"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  }));
  assert.deepEqual(decorateTools(tools, DEFAULT_SETTINGS).map((t) => t.name), ["tab_list"]);
  assert.equal(decorateTools(tools, { ...DEFAULT_SETTINGS, allowHistory: true }).length, 4);
});

test("page_navigate gains a tab_id parameter", () => {
  const [nav] = decorateTools(
    [{ name: "page_navigate", description: "x", inputSchema: { type: "object", properties: { url: {} } } }],
    DEFAULT_SETTINGS
  );
  assert.ok(nav.inputSchema.properties.tab_id);
  assert.match(nav.description, /agent tab/);
});

test("the scope note goes on tab tools only, not on every description", () => {
  const tools = decorateTools(
    ["tab_create", "element_click", "run_steps"].map((name) => ({ name, description: "x", inputSchema: { type: "object", properties: {} } })),
    DEFAULT_SETTINGS
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.match(byName.tab_create, /user's own tabs are hidden/);
  assert.match(byName.run_steps, /user's own tabs are hidden/);
  assert.equal(byName.element_click, "x");
});
