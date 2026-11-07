#!/usr/bin/env node
// Adds or removes claude-for-arc in the Claude desktop chat config
// (~/Library/Application Support/Claude/claude_desktop_config.json).
// Touches only mcpServers["claude-for-arc"], keeps a backup, writes atomically.
//
//   node desktop-config.js add <node> <server.js>
//   node desktop-config.js remove

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME = "claude-for-arc";
const FILE = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const [action, node, server] = process.argv.slice(2);

let config = {};
let existed = false;
try {
  config = JSON.parse(fs.readFileSync(FILE, "utf8"));
  existed = true;
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`Не могу прочитать ${FILE}: ${error.message}. Ничего не меняю.`);
    process.exit(1);
  }
}

if (action === "add") {
  if (!node || !server) {
    console.error("usage: desktop-config.js add <node> <server.js>");
    process.exit(2);
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[NAME] = { command: node, args: [server] };
} else if (action === "remove") {
  if (!config.mcpServers || !config.mcpServers[NAME]) {
    console.log("В настройках чата claude-for-arc не найден.");
    process.exit(0);
  }
  delete config.mcpServers[NAME];
} else {
  console.error("usage: desktop-config.js add <node> <server.js> | remove");
  process.exit(2);
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });
if (existed) fs.copyFileSync(FILE, `${FILE}.bak-claude-for-arc`);
const tmp = `${FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, FILE);
console.log(action === "add" ? "Добавлено в чат Claude. Откройте Claude снова." : "Удалено из чата Claude.");
