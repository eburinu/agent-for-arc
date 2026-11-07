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

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CFA_DATA_DIR: DATA_DIR, CFA_PORT: String(PORT) },
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
function connectExtension({ token = TOKEN, origin = EXTENSION_ORIGIN, tools = [], onCall } = {}) {
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
        ws.send(JSON.stringify({ type: "register", tools }));
        resolve({ ws });
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
  await server.rpc("initialize", { clientInfo: { name: "test" } });

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

test("a newer session takes over the port; the older one goes to standby", async () => {
  const older = startServer();
  await older.waitFor("Listening on");
  const newer = startServer();
  await newer.waitFor("Took over");
  await older.waitFor("moving to standby");

  const call = await older.rpc("tools/call", { name: "tab_list", arguments: {} });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /другой сессией/);

  // When the newer session ends, the older one picks the port back up.
  newer.child.stdin.end();
  await older.waitFor("Listening on ws://", 20000, 2);
  older.child.kill();
});

test("an impostor on the port cannot make the server step aside", async () => {
  const impostor = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  impostor.on("connection", (ws) => ws.send(JSON.stringify({ type: "challenge", server: "claude-for-arc", nonce: nonce() })));
  await new Promise((r) => impostor.once("listening", r));

  const server = startServer();
  await server.waitFor("waiting in standby");
  impostor.close();
  await server.waitFor("Listening on ws://", 10000);
  server.child.kill();
});
