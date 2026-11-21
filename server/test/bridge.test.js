"use strict";

// End-to-end tests for the server's trust boundary: they start real server
// processes and talk to them the way Claude (stdio) and the extension (ws) do.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER = path.join(__dirname, "..", "server.js");
const EXTENSION_ORIGIN = "chrome-extension://dllpmmijlpleaoifjffigbcilgmhjpla";
const PORT = 40000 + Math.floor(Math.random() * 20000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-test-"));
const TOKEN = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(DATA_DIR, "token"), TOKEN + "\n", { mode: 0o600 });

const children = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const hmac = (token, ...parts) =>
  crypto.createHmac("sha256", token).update(parts.join("|")).digest("hex");
const nonce = () => crypto.randomBytes(32).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CFA_DATA_DIR: DATA_DIR, CFA_PORT: String(PORT), CFA_EXTENSION_WAIT_MS: "300", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  let buffer = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buffer += d;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  return {
    child,
    stderr: () => stderr,
    rpc(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        waiters.set(id, resolve);
        setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 15000);
      });
    },
    async waitFor(text, ms = 8000, count = 1) {
      const start = Date.now();
      while (stderr.split(text).length - 1 < count) {
        if (Date.now() - start > ms) throw new Error(`timed out waiting for "${text}". stderr:\n${stderr}`);
        await sleep(50);
      }
    },
  };
}

// Connects like the extension does; resolves with the socket after the
// mutual handshake, or with the close code if the server refused.
function connectExtension({ token = TOKEN, origin = EXTENSION_ORIGIN, tools = [], onCall, version, onMessage } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin ? { origin } : {});
    let clientNonce;
    ws.on("unexpected-response", (_req, res) => resolve({ refusedStatus: res.statusCode }));
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.type === "challenge") {
        clientNonce = nonce();
        ws.serverNonce = msg.nonce;
        ws.send(JSON.stringify({
          type: "auth", role: "extension", nonce: clientNonce,
          mac: hmac(token, "client", msg.nonce, clientNonce),
        }));
      } else if (msg.type === "auth_ok") {
        ws.serverProved = msg.mac === hmac(token, "server", clientNonce, ws.serverNonce);
        ws.send(JSON.stringify({ type: "register", tools, version }));
        resolve({ ws });
      } else if (onMessage && !msg.id) {
        onMessage(msg);
      } else if (msg.id && onCall) {
        onCall(msg, ws);
      }
    });
    ws.on("close", (code) => resolve({ closedCode: code }));
    ws.on("error", () => {});
  });
}

const TOOL = { name: "tab_list", description: "List tabs", inputSchema: { type: "object", properties: {} } };

test("authenticated extension registers tools and serves calls", async () => {
  const server = startServer();
  await server.waitFor("Listening on");
  const { result: initialized } = await server.rpc("initialize", { clientInfo: { name: "test" } });
  assert.deepEqual(initialized.serverInfo, { name: "agent-for-arc", version: require("../package.json").version });

  const { ws } = await connectExtension({
    tools: [TOOL],
    onCall: (msg, sock) => sock.send(JSON.stringify({ id: msg.id, result: { success: true, tabs: [], count: 0 } })),
  });
  assert.ok(ws, "extension should authenticate");
  assert.equal(ws.serverProved, true, "server must prove it knows the token");
  await server.waitFor("registered 1 tools");

  const list = await server.rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["tab_list"]);

  const call = await server.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(call.result.isError, false);
  ws.close();
  server.child.kill();
});

test("refuses a wrong token, foreign origins and unauthenticated roles", async () => {
  const server = startServer();
  await server.waitFor("Listening on");

  const wrong = await connectExtension({ token: crypto.randomBytes(32).toString("hex") });
  assert.equal(wrong.closedCode, 4004);

  const page = await connectExtension({ origin: "https://evil.example" });
  assert.equal(page.refusedStatus, 403);

  const otherExtension = await connectExtension({ origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(otherExtension.refusedStatus, 403);

  // A local process without an Origin may not claim to be the extension.
  const noOrigin = await connectExtension({ origin: null });
  assert.equal(noOrigin.closedCode, 4003);

  const call = await server.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(call.result.isError, true, "no extension slot was handed out");
  server.child.kill();
});

test("a session that only starts up waits; the one that calls a tool takes the browser", async () => {
  const older = startServer();
  await older.waitFor("Listening on");
  const newer = startServer();
  await newer.waitFor("standby until a tool is called");

  // The idle newer session must not have taken anything.
  await sleep(500);
  assert.ok(!older.stderr().includes("moving to standby"));

  // Its first tool call takes the port over (no extension here, so the call
  // itself still reports that the extension is not connected).
  const call = await newer.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(call.result.isError, true);
  await newer.waitFor("Took over");
  await older.waitFor("moving to standby");

  // A call in the older session takes it back.
  await older.rpc("tools/call", { name: "tab_list", arguments: {} });
  await older.waitFor("Took over");
  await newer.waitFor("moving to standby");
  older.child.kill();
  newer.child.kill();
});

test("another session cannot interrupt run_steps", async () => {
  const owner = startServer();
  await owner.waitFor("Listening on");
  const calls = [];
  const { ws } = await connectExtension({
    onCall(msg, sock) { calls.push({ msg, sock }); },
  });
  const running = owner.rpc("tools/call", { name: "run_steps", arguments: {} });
  while (calls.length === 0) {
    const ready = await Promise.race([running.then(() => false), sleep(25).then(() => true)]);
    assert.ok(ready, "the extension should receive the call");
  }

  const waiting = startServer();
  await waiting.waitFor("standby until a tool is called");
  const busy = await waiting.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(busy.result.isError, true);
  assert.match(busy.result.content[0].text, /Arc is busy in another chat/);
  assert.ok(!owner.stderr().includes("moving to standby"));

  const { msg, sock } = calls[0];
  sock.send(JSON.stringify({ id: msg.id, result: { success: true, steps_run: 1, report: [] } }));
  assert.equal((await running).result.isError, false);

  await waiting.rpc("tools/call", { name: "tab_list", arguments: {} });
  await waiting.waitFor("Took over");
  ws.close();
  owner.child.kill();
  waiting.child.kill();
});

test("when the owner exits, a waiting session picks the port up", async () => {
  const first = startServer();
  await first.waitFor("Listening on");
  const second = startServer();
  await second.waitFor("standby until a tool is called");
  first.child.stdin.end();
  await second.waitFor("Listening on ws://", 10000);
  second.child.kill();
});

test("an impostor on the port cannot make the server step aside", async () => {
  const impostor = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  impostor.on("connection", (ws) => ws.send(JSON.stringify({ type: "challenge", server: "claude-for-arc", nonce: nonce() })));
  await new Promise((r) => impostor.once("listening", r));

  const server = startServer();
  await server.waitFor("standby until a tool is called");
  // A tool call tries to take over; the impostor cannot complete the handshake.
  const call = await server.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(call.result.isError, true);
  await server.waitFor("did not step aside");
  impostor.close();
  await server.waitFor("Listening on ws://", 10000);
  server.child.kill();
});

test("key from the connector settings (CFA_TOKEN) wins and is written to the key file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-test-env-"));
  const fileKey = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(dir, "token"), fileKey + "\n", { mode: 0o600 });
  try {
    // An unfilled setting arrives as the literal placeholder: the file key stays.
    const placeholder = startServer({ CFA_DATA_DIR: dir, CFA_TOKEN: "${user_config.token}", CFA_PORT: String(PORT + 1) });
    await placeholder.waitFor("using the key file instead");
    placeholder.child.kill("SIGKILL");
    assert.equal(fs.readFileSync(path.join(dir, "token"), "utf8").trim(), fileKey);

    const envKey = crypto.randomBytes(32).toString("hex");
    const server = startServer({ CFA_DATA_DIR: dir, CFA_TOKEN: envKey.toUpperCase(), CFA_PORT: String(PORT + 1) });
    await server.rpc("initialize", {});
    assert.equal(fs.readFileSync(path.join(dir, "token"), "utf8").trim(), envKey);
    assert.equal(fs.statSync(path.join(dir, "token")).mode & 0o777, 0o600);
    server.child.kill("SIGKILL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connector mode: places the extension with its key and asks an old one to reload once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-test-deploy-"));
  const target = path.join(dir, "extension");
  const env = { CFA_DEPLOY_EXTENSION: "1", CFA_EXTENSION_DIR: target, CFA_NO_OPEN: "1" };
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "extension", "manifest.json"), "utf8")).version;
  try {
    const server = startServer(env);
    await server.waitFor("Listening on");
    await server.waitFor(`Extension ${bundled} placed in ${target}`);
    assert.ok(fs.existsSync(path.join(target, "src", "background", "background.js")));
    const keyFile = path.join(target, "key.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(keyFile, "utf8")), { token: TOKEN });
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(dir).length, 1, "no staging folder left behind");

    const messages = [];
    const oldCalls = [];
    const old = await connectExtension({
      version: "0.0.1", tools: [TOOL], onMessage: (m) => messages.push(m),
      onCall: (message) => oldCalls.push(message),
    });
    await server.waitFor("asking it to reload");
    assert.deepEqual(messages.filter((m) => m.type === "reload").length, 1);
    const calling = server.rpc("tools/call", { name: "tab_list", arguments: {} });
    await sleep(100);
    assert.equal(oldCalls.length, 0, "the first request waits for the new worker");
    old.ws.close();
    const upgraded = await connectExtension({
      version: bundled, tools: [TOOL],
      onCall: (msg, sock) => sock.send(JSON.stringify({ id: msg.id, result: { success: true, tabs: [], count: 0 } })),
    });
    assert.equal((await calling).result.isError, false);
    upgraded.ws.close();

    // A second old registration in the same run does not trigger another reload.
    const again = [];
    const second = await connectExtension({ version: "0.0.1", onMessage: (m) => again.push(m) });
    await sleep(300);
    assert.equal(again.filter((m) => m.type === "reload").length, 0);
    second.ws.close();
    server.child.kill("SIGKILL");
    await sleep(200);

    // Same version on disk: nothing is copied again, and the call says where the folder is.
    const quiet = startServer({ ...env, CFA_EXTENSION_WAIT_MS: "200" });
    await quiet.waitFor("Listening on");
    assert.ok(!quiet.stderr().includes("placed in"));
    await quiet.rpc("initialize", {});
    const call = await quiet.rpc("tools/call", { name: "tab_list", arguments: {} });
    assert.match(JSON.stringify(call), new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    quiet.child.kill("SIGKILL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
