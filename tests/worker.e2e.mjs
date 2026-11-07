// Integration test: runs the real extension background worker in node against
// a real server process, with chrome.* mocked in memory.
// Usage: node tests/worker.e2e.mjs   (exit code 1 on any FAIL)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(repo, "server", "package.json"));
const WS = require("ws");
const ORIGIN = "chrome-extension://dllpmmijlpleaoifjffigbcilgmhjpla";
const PORT = 41000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-h-"));
const TOKEN = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(dataDir, "token"), TOKEN);

// ---- chrome mock
const listeners = (name) => { const l = []; const o = { addListener: (f) => l.push(f), _l: l }; return o; };
const local = { token: TOKEN, port: PORT }, session = {};
const storageChanged = listeners();
const area = (store, name) => ({
  async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]); return out; },
  async set(obj) { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: store[k], newValue: v }; store[k] = structuredClone(v); } storageChanged._l.forEach((f) => f(ch, name)); },
});
let nextTab = 100;
const tabs = new Map([[1, { id: 1, url: "https://user.example/inbox", title: "User tab", active: true, windowId: 1 }]]);
const tabCreated = listeners(), tabRemoved = listeners();
const pageCalls = [];
globalThis.chrome = {
  storage: { local: area(local, "local"), session: area(session, "session"), onChanged: storageChanged },
  tabs: {
    async get(id) { if (!tabs.has(id)) throw new Error("No tab with id: " + id); return { ...tabs.get(id) }; },
    async query(q) { let all = [...tabs.values()]; if (q.active) all = all.filter((t) => t.active); return all.map((t) => ({ ...t })); },
    async create(p) { const t = { id: nextTab++, url: p.url || "about:blank", title: "New", active: !!p.active, windowId: 1, status: "complete" }; if (t.active) for (const o of tabs.values()) o.active = false; tabs.set(t.id, t); tabCreated._l.forEach((f) => f({ ...t })); return { ...t }; },
    async update(id, p) { Object.assign(tabs.get(id), p); return { ...tabs.get(id) }; },
    async remove(ids) { for (const id of [].concat(ids)) { tabs.delete(id); tabRemoved._l.forEach((f) => f(id)); } },
    sendMessage(id, msg, cb) {
      pageCalls.push({ id, action: msg.action, data: msg.data });
      const res = msg.action === "ping" ? { success: true } : { success: true, data: { ok: true, action: msg.action } };
      if (cb) setTimeout(() => cb(res), 0); else return Promise.resolve(res);
    },
    onCreated: tabCreated, onRemoved: tabRemoved,
  },
  windows: { async update() {} },
  scripting: { async executeScript() { return [{ result: { text: "sel", hasSelection: true } }]; } },
  alarms: { create() {}, onAlarm: listeners() },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  runtime: { id: "dllpmmijlpleaoifjffigbcilgmhjpla", lastError: null, getManifest: () => ({ manifest_version: 3 }), onMessage: listeners(), onStartup: listeners(), onInstalled: listeners() },
  permissions: { async contains() { return false; } },
};
globalThis.WebSocket = class extends WS { constructor(url) { super(url, { origin: ORIGIN }); } };

// ---- server
const server = spawn(process.execPath, [path.join(repo, "server", "server.js")], {
  env: { ...process.env, CFA_DATA_DIR: dataDir, CFA_PORT: String(PORT) }, stdio: ["pipe", "pipe", "pipe"],
});
let serr = ""; server.stderr.on("data", (d) => { serr += d; });
let buf = ""; const waiters = new Map(); let id = 0;
server.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) { if (!l.trim()) continue; const m = JSON.parse(l); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
const rpc = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: r.result.isError, text: r.result.content[0].text }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : "  :: " + extra}`); if (!cond) process.exitCode = 1; };

await sleep(500);
await rpc("initialize", {});
await import(path.join(repo, "extension", "src", "background", "background.js"));
for (let i = 0; i < 40 && !serr.includes("registered"); i++) await sleep(100);
check("extension authenticates and registers", serr.includes("authenticated") && serr.includes("registered"), serr);

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
check("history tools hidden by default", !names.includes("get_history") && names.includes("tab_create"), names.join(","));

let r = await call("page_analyze", {});
check("own scope: user's active tab refused", r.err && /нет вкладки агента|открыта пользователем/.test(r.text), r.text);

r = await call("page_analyze", { tab_id: 1 });
check("own scope: explicit user tab refused", r.err && /открыта пользователем/.test(r.text), r.text);

r = await call("tab_list", {});
check("tab_list hides user tabs", !r.err && !r.text.includes("user.example"), r.text);

r = await call("tab_create", { url: "javascript:alert(1)" });
check("javascript: URL refused", r.err, r.text);
r = await call("tab_create", { url: "https://my.1password.com" });
check("blocklisted host refused", r.err && /запрещённых/.test(r.text), r.text);

r = await call("page_navigate", { url: "https://example.com" });
check("navigate with no agent tab opens a new tab", !r.err && tabs.size === 2, r.text);
const agentId = Math.max(...tabs.keys());

pageCalls.length = 0;
r = await call("page_analyze", {});
check("default target is the agent tab", !r.err && pageCalls.some((c) => c.id === agentId && c.action === "analyze"), JSON.stringify(pageCalls) + r.text);

r = await call("tab_close", { tab_id: 1 });
check("cannot close user's tab", r.err && tabs.has(1), r.text);

r = await call("get_selected_text", {});
check("selected text on user's active tab allowed", !r.err, r.text);

await chrome.storage.local.set({ readOnly: true });
r = await call("element_click", { element_id: "x" });
check("read-only blocks clicks", r.err && /только чтение/.test(r.text), r.text);
await chrome.storage.local.set({ readOnly: false });

await chrome.storage.local.set({ paused: true });
r = await call("tab_list", {});
check("pause blocks everything", r.err && /паузу/.test(r.text), r.text);
await chrome.storage.local.set({ paused: false });

await chrome.storage.local.set({ scope: "all" });
pageCalls.length = 0;
r = await call("page_analyze", { tab_id: 1 });
check("scope all: user tab allowed", !r.err && pageCalls.some((c) => c.id === 1), r.text);
r = await call("tab_list", {});
check("scope all: tab_list shows user tabs", r.text.includes("user.example"), r.text);
await chrome.storage.local.set({ scope: "own" });

r = await call("tab_close", { tab_id: agentId });
check("can close own tab", !r.err && !tabs.has(agentId), r.text);

const { log = [] } = await chrome.storage.session.get("log");
check("actions are logged", log.length >= 10, String(log.length));

// Wrong key: the extension must refuse to talk to a server with a different token.
await chrome.storage.local.set({ token: crypto.randomBytes(32).toString("hex") });
await sleep(1500);
r = await call("tab_list", {});
check("wrong key: no connection", r.err && /не подключено/.test(r.text), r.text);

server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit();
