"use strict";

// When claude-for-arc is installed as a Claude desktop extension (.mcpb), the
// bundle carries the browser extension too. On start the server lays it out in
// a stable folder the user loads into Arc once, with the connection key inside
// (key.json), so nothing has to be copied by hand. Later versions overwrite the
// folder and the extension reloads itself (see "reload" in server.js).
//
// Only runs when CFA_DEPLOY_EXTENSION=1 (set by mcpb/manifest.json).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MARKER = ".claude-for-arc";

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

// ~/claude-for-arc/extension unless that folder belongs to something else.
function chooseTarget(dataDir) {
  if (process.env.CFA_EXTENSION_DIR) return process.env.CFA_EXTENSION_DIR;
  const home = path.join(os.homedir(), "claude-for-arc");
  let ours = true;
  try {
    const entries = fs.readdirSync(home);
    ours = entries.length === 0 || entries.includes(MARKER);
  } catch (error) {
    if (error.code !== "ENOENT") ours = false;
  }
  if (ours) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, MARKER), "");
    return path.join(home, "extension");
  }
  return path.join(dataDir, "extension");
}

function writeKey(target, token) {
  const file = path.join(target, "key.json");
  const body = JSON.stringify({ token }) + "\n";
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (current === body) return false;
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return true;
}

/**
 * @returns {{target: string, version: string, fresh: boolean, updated: boolean} | null}
 */
function deployExtension({ token, dataDir, log }) {
  if (process.env.CFA_DEPLOY_EXTENSION !== "1") return null;
  const source = path.join(__dirname, "..", "extension");
  const version = readVersion(source);
  if (!version) {
    log(`No extension in ${source}; skipping deploy`);
    return null;
  }
  const target = chooseTarget(dataDir);
  const installed = readVersion(target);
  const fresh = installed === null;
  const updated = installed !== version;
  if (updated) {
    // Copy next to the target, then swap, so Arc never sees a half-written folder.
    const staging = `${target}.new-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true, filter: (p) => path.basename(p) !== "key.json" });
    writeKey(staging, token);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    log(`Extension ${version} placed in ${target}`);
  } else if (writeKey(target, token)) {
    log(`Connection key updated in ${target}`);
  }
  if (fresh && process.env.CFA_NO_OPEN !== "1") {
    // First install: show the user where to load it. Arc opens its extensions
    // page; Finder shows the folder to drag into "Load unpacked".
    execFile("open", ["-a", "Arc", "arc://extensions"], () => {});
    execFile("open", ["-R", target], () => {});
  }
  return { target, version, fresh, updated };
}

module.exports = { deployExtension };
