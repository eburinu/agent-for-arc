// Live speed check in a real Arc: send one message to each of 10 chats on
// tests/fixtures/chat.html, the old way (one call per action, page_analyze to
// find elements) and with run_steps (one call), and check that every chat got
// exactly one message each time.
//
// Needs the extension in Arc and the fixture server:
//   python3 -m http.server 8765 --bind 127.0.0.1 -d tests/fixtures
// Run:  node tests/live-speed.mjs [path/to/server.js]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = process.argv[2] || path.join(here, "..", "server", "server.js");
const BASE = "http://127.0.0.1:8765/chat.html";
const CHATS = 10;

const server = spawn(process.execPath, [serverJs], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "";
const waiters = new Map();
let nextId = 0;
server.stderr.on("data", () => {});
server.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    waiters.get(m.id)?.(m);
  }
});
const rpc = (method, params) => new Promise((res) => {
  const id = ++nextId;
  waiters.set(id, res);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
let calls = 0;
let chars = 0;
let errors = 0;
const call = async (name, args = {}) => {
  calls++;
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  chars += text.length;
  if (r.result?.isError ?? true) errors++;
  return { err: r.result?.isError ?? true, text };
};
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  :: " + String(extra).slice(0, 600)}`);
  if (!ok) failed++;
};
const idFor = (text, name) => (text.match(new RegExp(`${name}[^\\n]*\\n\\s*Element ID: (\\w+)`)) || [])[1];

await rpc("initialize", { clientInfo: { name: "live-speed" } });

// Fresh tab and empty message store.
let r = await call("tab_create", { url: `${BASE}?c=1` });
const tab = Number((r.text.match(/Tab ID: (\d+)/) || [])[1]);
check("opened the test messenger", tab > 0, r.text);
await call("page_navigate", { tab_id: tab, url: `${BASE}?c=1&reset=1` });

async function expectCounts(label, perChat) {
  const want = `по чатам: ${Array(CHATS).fill(perChat).join(",")}`;
  const res = await call("page_wait_for", { tab_id: tab, condition_type: "text_present", text: want, timeout: 4000 });
  if (res.err) {
    const state = await call("page_extract_content", { tab_id: tab, content_type: "article", summarize: false });
    check(label, false, (state.text.match(/Всего отправлено[^\n]*/) || [state.text])[0]);
  } else check(label, true);
}

// --- old way: navigate, analyze, fill, analyze, click — one call each
calls = 0; chars = 0; errors = 0;
let started = Date.now();
for (let c = 1; c <= CHATS; c++) {
  await call("page_navigate", { url: `${BASE}?c=${c}`, tab_id: tab });
  const a1 = await call("page_analyze", { intent_hint: "написать сообщение", tab_id: tab });
  const field = idFor(a1.text, "Написать сообщение") || idFor(a1.text, "textarea");
  await call("element_fill", { element_id: field, value: `старый способ ${c}`, tab_id: tab });
  const a2 = await call("page_analyze", { intent_hint: "отправить", tab_id: tab });
  const send = idFor(a2.text, "Отправить");
  await call("element_click", { element_id: send, tab_id: tab });
}
const oldMs = Date.now() - started;
check("old way: no call failed", errors === 0, `${errors} failed calls`);
const oldCalls = calls;
const oldChars = chars;
await call("page_navigate", { url: `${BASE}?c=1`, tab_id: tab });
await expectCounts("old way: each chat got exactly one message", 1);

// --- new way: one run_steps call, elements named by label, Enter to send
const steps = [];
for (let c = 1; c <= CHATS; c++) {
  steps.push(
    { tool: "page_navigate", args: { url: `${BASE}?c=${c}` } },
    { tool: "element_fill", args: { label: "Написать сообщение", value: `новый способ ${c}` } },
    { tool: "press_key", args: { key: "Enter" } },
  );
}
calls = 0; chars = 0;
started = Date.now();
r = await call("run_steps", { tab_id: tab, steps });
const newMs = Date.now() - started;
const newCalls = calls;
const newChars = chars;
check("run_steps: all steps done", !r.err && /All 30 steps done/.test(r.text), r.text);
await call("page_navigate", { url: `${BASE}?c=1`, tab_id: tab });
await expectCounts("new way (Enter): each chat got exactly one more message", 2);

// --- clicking the send button by its text inside run_steps
const clickSteps = [];
for (let c = 1; c <= CHATS; c++) {
  clickSteps.push(
    { tool: "page_navigate", args: { url: `${BASE}?c=${c}` } },
    { tool: "element_fill", args: { label: "Написать сообщение", value: `кнопка ${c}` } },
    { tool: "element_click", args: { text: "Отправить" } },
  );
}
started = Date.now();
r = await call("run_steps", { tab_id: tab, steps: clickSteps });
const clickMs = Date.now() - started;
check("run_steps with click by text: all steps done", !r.err && /All 30 steps done/.test(r.text), r.text);
await call("page_navigate", { url: `${BASE}?c=1`, tab_id: tab });
await expectCounts("click by text: each chat got exactly one more message (no doubles)", 3);

await call("tab_close", { tab_id: tab });
console.log(`\nold way:  ${oldCalls} calls, ${(oldMs / 1000).toFixed(1)} s in the browser, ${oldChars} chars of replies for Claude to read`);
console.log(`run_steps: ${newCalls} call,  ${(newMs / 1000).toFixed(1)} s in the browser, ${newChars} chars (Enter)`);
console.log(`run_steps: 1 call,  ${(clickMs / 1000).toFixed(1)} s in the browser (click by text)`);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
server.kill();
process.exit(failed ? 1 : 0);
