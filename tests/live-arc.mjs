// Live test of every tool against the real extension in Arc.
//
// Needs: the extension loaded in Arc with the key saved, and the fixture
// server running:  python3 -m http.server 8765 --bind 127.0.0.1 -d tests/fixtures
// Run:   node tests/live-arc.mjs [path/to/server.js]
// Starts its own server process, which takes the browser over from any
// Claude session on its first call, and gives it back when it exits.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const serverJs = process.argv[2] || path.join(os.homedir(), "claude-for-arc", "server", "server.js");
const PAGE = "http://127.0.0.1:8765/test-page.html";

const server = spawn(process.execPath, [serverJs], { stdio: ["pipe", "pipe", "pipe"] });
let serr = "";
server.stderr.on("data", (d) => { serr += d; });
let buf = "";
const waiters = new Map();
let nextId = 0;
server.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res) => {
  const id = ++nextId;
  waiters.set(id, res);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { err: r.result.isError, text: r.result.content[0].text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${cond ? "" : "\n     " + String(extra).slice(0, 400).replace(/\n/g, "\n     ")}`);
  if (!cond) failures++;
};
const idFor = (text, name) => (text.match(new RegExp(`${name}[^\\n]*\\n\\s*Element ID: (\\w+)`)) || [])[1];

await rpc("initialize", { clientInfo: { name: "live-arc" } });

// --- clean up agent tabs left by an earlier run
let r = await call("tab_list", {});
const leftovers = [...r.text.matchAll(/ID: (\d+) \| 🌐 http:\/\/127\.0\.0\.1:8765\//g)].map((m) => Number(m[1]));
if (leftovers.length) await call("tab_close", { tab_ids: leftovers });

// --- tabs
r = await call("tab_create", { url: PAGE, active: false });
const tabId = Number((r.text.match(/Tab ID: (\d+)/) || [])[1]);
check("tab_create opens the test page", !r.err && Number.isInteger(tabId), r.text);
if (!Number.isInteger(tabId)) {
  console.log("Cannot continue without a tab id. Server log:\n" + serr);
  process.exit(1);
}

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
check("tool list comes from the extension, history hidden", names.includes("page_navigate") && !names.includes("get_history"), names.join(","));

r = await call("tab_list", {});
check("tab_list shows only the agent tab", !r.err && r.text.includes(String(tabId)) && /Found 1 open tab/.test(r.text), r.text);

// --- reading
r = await call("page_extract_content", { content_type: "article", summarize: false, tab_id: tabId });
check("extraction returns visible text", r.text.includes("VISIBLE_MARKER"), r.text);
check("full extraction reaches the end of a short article over 500 characters", r.text.includes("LONG_TEXT_END"), r.text);
check("extraction has no CSS, script source, hidden text or password value",
  !/CSS_MARKER|SCRIPT_MARKER|HIDDEN_MARKER|SECRET_VALUE/.test(r.text), r.text);

r = await call("page_extract_content", { content_type: "article", tab_id: tabId });
check("summarised extraction works", !r.err, r.text);

r = await call("get_page_links", { tab_id: tabId });
check("get_page_links finds both links", !r.err && r.text.includes("example.com") && r.text.includes("section-a"), r.text);

// --- finding and acting
r = await call("page_analyze", { intent_hint: "кнопка Нажми меня", tab_id: tabId });
const counter = idFor(r.text, "Нажми меня");
check("page_analyze finds the counter button by Russian hint", !!counter, r.text);

r = await call("page_analyze", { intent_hint: "заполнить форму", phase: "detailed", tab_id: tabId });
const nameField = idFor(r.text, "Ваше имя");
const passField = idFor(r.text, "Пароль");
const cardField = idFor(r.text, "Номер карты");
const submit = idFor(r.text, "Отправить форму");
const disabled = idFor(r.text, "Выключенная кнопка");
check("detailed analysis lists form fields and buttons", nameField && passField && cardField && submit, r.text);

r = await call("element_fill", { element_id: nameField, value: "Тест Тестович", tab_id: tabId });
check("fills a normal field", !r.err && r.text.includes("Тест Тестович"), r.text);
r = await call("element_fill", { element_id: passField, value: "nope", tab_id: tabId });
check("refuses to fill a password field", r.err && /пароля/.test(r.text), r.text);
r = await call("element_fill", { element_id: cardField, value: "4242424242424242", tab_id: tabId });
check("refuses to fill a card field", r.err, r.text);
r = await call("element_get_state", { element_id: passField, tab_id: tabId });
check("password value is masked", r.text.includes("скрыто") && !r.text.includes("SECRET_VALUE"), r.text);

r = await call("element_click", { element_id: counter, tab_id: tabId });
r = await call("element_click", { element_id: counter, tab_id: tabId, click_type: "left" });
r = await call("page_wait_for", { condition_type: "text_present", text: "Нажато: 2", timeout: 3000, tab_id: tabId });
check("two clicks registered on the page", !r.err, r.text);

const pressButton = idFor((await call("page_analyze", { intent_hint: "отправить сообщение", tab_id: tabId })).text, "Отправить сообщение");
check("found the press-counting button", !!pressButton, pressButton);
r = await call("element_click", { element_id: pressButton, tab_id: tabId });
await sleep(300);
r = await call("page_wait_for", { condition_type: "text_present", text: "Отправлено раз: 1", timeout: 3000, tab_id: tabId });
check("one click = one press (no double send)", !r.err, r.text);
r = await call("element_get_state", { element_id: pressButton, tab_id: tabId });
check("still exactly one press after the click", !/Отправлено раз: [2-9]/.test(r.text), r.text);

if (disabled) {
  r = await call("element_click", { element_id: disabled, tab_id: tabId });
  check("click on a disabled button is reported, not faked", r.err && /выключен/.test(r.text), r.text);
}

r = await call("element_click", { element_id: submit, tab_id: tabId });
r = await call("page_wait_for", { condition_type: "text_present", text: "SUBMITTED:Тест Тестович", timeout: 3000, tab_id: tabId });
check("form submitted with the filled value", !r.err, r.text);

r = await call("page_wait_for", { condition_type: "text_present", text: "NO_SUCH_TEXT", timeout: 1000, tab_id: tabId });
check("wait_for times out on missing text", r.err, r.text);

r = await call("page_scroll", { direction: "bottom", tab_id: tabId });
check("page_scroll works", !r.err, r.text);

r = await call("page_style", { mode: "preset", theme: "high_contrast", tab_id: tabId });
check("page_style applies", !r.err, r.text);
r = await call("page_style", { mode: "reset", tab_id: tabId });
check("page_style resets", !r.err, r.text);

r = await call("get_selected_text", { tab_id: tabId });
check("get_selected_text answers", !r.err, r.text);
await call("element_click", { selector: "#select-long-text", tab_id: tabId });
r = await call("get_selected_text", { tab_id: tabId, max_length: 1000 });
check("get_selected_text preserves text past 200 characters", !r.err && r.text.includes("LONG_TEXT_END"), r.text);

// --- browser-native form controls
r = await call("element_click", { selector: "#attachment", tab_id: tabId });
check("system file picker reports the manual or byte-based alternatives", r.err && /element_fill\(file\)/.test(r.text), r.text);
r = await call("element_fill", { selector: "#attachment", value: "/tmp/fixture.txt", tab_id: tabId });
check("a local path cannot be passed as a file", r.err && /element_fill\(file\)/.test(r.text), r.text);
r = await call("element_fill", { selector: "#attachment", tab_id: tabId, file: { name: "fixture.txt", base64: "!!!" } });
check("invalid file bytes return a clear error", r.err && /base64/.test(r.text), r.text);
r = await call("element_fill", {
  selector: "#attachment", tab_id: tabId,
  file: { name: "fixture.txt", base64: Buffer.from("BYTES_FROM_MCP").toString("base64"), mime_type: "text/plain" },
});
check("file attachment reports the attached filename", !r.err && /Filled:.*fixture\.txt/.test(r.text), r.text);
r = await call("page_wait_for", { tab_id: tabId, condition_type: "text_present", text: "fixture.txt: BYTES_FROM_MCP" });
check("site receives the bytes through the file input change event", !r.err, r.text);

r = await call("element_fill", { selector: "#records", value: "Text record", tab_id: tabId });
check("select by option label", !r.err && /Filled:.*«txt»/.test(r.text), r.text);
r = await call("element_click", { selector: '#records option[value="a"]', tab_id: tabId });
check("click by native option selector", !r.err && /Clicked: Address/.test(r.text), r.text);
r = await call("element_get_state", { selector: "#records", tab_id: tabId });
check("native option click updates the current value", /Current Value.*"a"/.test(r.text), r.text);
await call("press_key", { selector: "#records", key: "ArrowDown", tab_id: tabId });
r = await call("element_get_state", { selector: "#records", tab_id: tabId });
check("ArrowDown skips a disabled native option", /Current Value.*"txt"/.test(r.text), r.text);

await call("page_scroll", { direction: "bottom", tab_id: tabId });
r = await call("page_analyze", { intent_hint: "Размер диска", max_results: 5, tab_id: tabId });
check("discovery finds a numeric text input by its associated label", !!idFor(r.text, "Размер диска"), r.text);
r = await call("element_get_state", { label: "Размер диска", tab_id: tabId });
check("numeric text input reports the live value instead of the HTML default", /Current Value.*"20"/.test(r.text), r.text);
r = await call("page_analyze", { intent_hint: "Размер SSD", max_results: 5, tab_id: tabId });
check("discovery finds an ARIA slider by its accessible label", !!idFor(r.text, "Размер SSD"), r.text);
r = await call("element_get_state", { label: "Размер SSD", tab_id: tabId });
check("ARIA slider reports both the numeric and formatted values",
  /Current Value.*"20"/.test(r.text) && /Value Text.*"20 ГиБ"/.test(r.text), r.text);
r = await call("element_get_state", { label: "Свободное место", tab_id: tabId });
check("ARIA spinbutton preserves zero", /Current Value.*"0"/.test(r.text), r.text);

for (const [index, wait_after] of [1000, 0].entries()) {
  r = await call("run_steps", { tab_id: tabId, steps: [
    { tool: "element_click", args: { selector: "#reload", wait_after } },
    { tool: "page_wait_for", args: { condition_type: "text_present", text: `RELOAD_CONFIRMED:${index + 1}`, timeout: 3000 } },
  ] });
  check(`click-initiated reload keeps the batch working (wait_after=${wait_after})`, !r.err && /All 2 steps done/.test(r.text), r.text);
}

// --- navigation waits for the new page
r = await call("page_navigate", { url: PAGE + "?fresh=1", tab_id: tabId });
check("page_navigate succeeds", !r.err, r.text);
r = await call("page_analyze", { intent_hint: "кнопка Нажми меня", tab_id: tabId });
check("after navigate the next call sees the NEW page (counter reset)", r.text.includes("Нажми меня") && !r.text.includes("Нажато"), r.text);

// --- guards
r = await call("page_navigate", { url: "javascript:alert(1)", tab_id: tabId });
check("javascript: refused", r.err, r.text);
r = await call("page_navigate", { url: "https://vault.bitwarden.com", tab_id: tabId });
check("blocklisted site refused", r.err, r.text);
r = await call("tab_close", { tab_ids: [tabId - 1] });
check("closing a tab the agent did not open is refused", r.err, r.text);

// --- batch + switch + close
r = await call("tab_create", { urls: [PAGE + "?b=1", PAGE + "?b=2"], active: false });
const batchIds = [...r.text.matchAll(/(\d{6,})/g)].map((m) => Number(m[1])).filter((n) => n !== tabId);
check("batch tab_create opens two tabs", !r.err && batchIds.length >= 2, r.text);
r = await call("tab_list", {});
check("tab_list now shows three agent tabs", /Found 3 open tab/.test(r.text), r.text);
r = await call("tab_close", { tab_ids: [tabId, ...batchIds.slice(0, 2)] });
check("closes all agent tabs", !r.err, r.text);
r = await call("tab_list", {});
check("no agent tabs left", /No tabs found|Found 0/.test(r.text), r.text);

console.log(`\n${failures ? failures + " FAILED" : "ALL PASSED"}`);
server.stdin.end();
await sleep(300);
process.exit(failures ? 1 : 0);
