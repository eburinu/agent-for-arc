"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const NAME = "arc";
const home = os.homedir();

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, cwd: os.tmpdir(), encoding: "utf8", timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Command failed: ${command}`);
  return result.stdout;
}

function findCodex() {
  const relative = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  const apps = ["/Applications", path.join(home, "Applications")];
  const candidates = process.env.CFA_CODEX_BIN ? [process.env.CFA_CODEX_BIN] : [
    ...apps.flatMap((dir) => ["ChatGPT.app", "Codex.app"].map((app) => path.join(dir, app, relative))),
    ...(process.env.PATH || "").split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, "codex")),
  ];
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  throw new Error("Install Codex or set CFA_CODEX_BIN to the absolute path of the Codex CLI.");
}

function writeLauncher(dest) {
  const launcher = path.join(dest, "start.sh");
  // Resolve the release once, so an update cannot mix files from two versions.
  fs.writeFileSync(launcher, '#!/bin/bash\nset -euo pipefail\n' +
    'release="$(cd "$(dirname "$0")/current" && pwd -P)"\n' +
    'exec "$release/node" "$release/server/server.js"\n', { mode: 0o700, flag: "wx" });
}

function install() {
  const codex = findCodex();
  const data = process.env.CFA_DATA_DIR || path.join(home, "Library", "Application Support", "claude-for-arc");
  const dest = path.join(data, "codex");
  const launcher = path.join(dest, "start.sh");
  const list = JSON.parse(run(codex, ["mcp", "list", "--json"]));
  const existing = list.find(({ name }) => name === NAME);
  const transport = existing?.transport;
  if (existing && !(transport?.command === "/bin/bash" && transport?.args?.length === 1 && transport.args[0] === launcher)) {
    throw new Error('Codex already has a different MCP server named "arc". Rename that entry before installing.');
  }

  const version = require("./server/package.json").version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(launcher)) writeLauncher(dest);

  const releases = path.join(dest, "releases");
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const release = path.join(releases, `${version}-${process.arch}`);
  if (!fs.existsSync(release)) {
    const staging = fs.mkdtempSync(path.join(releases, ".stage-"));
    try {
      for (const dir of ["server", "extension"]) {
        fs.cpSync(path.join(__dirname, dir), path.join(staging, dir), { recursive: true });
      }
      fs.copyFileSync(process.execPath, path.join(staging, "node"));
      fs.chmodSync(path.join(staging, "node"), 0o755);
      fs.copyFileSync(path.join(__dirname, "NODE-LICENSE"), path.join(staging, "NODE-LICENSE"));
      fs.copyFileSync(path.join(__dirname, "LICENSE"), path.join(staging, "LICENSE"));
      fs.renameSync(staging, release);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const prepared = JSON.parse(run(path.join(release, "node"),
    [path.join(release, "server", "server.js"), "--prepare-extension"],
    { ...process.env, CFA_DEPLOY_EXTENSION: "1", CFA_KEEP_INSTALLED_EXTENSION: "1" }));
  if (!prepared?.target) throw new Error("Could not prepare the Arc extension.");

  const current = path.join(dest, "current");
  // Switch to the new release without disturbing sessions using the old one.
  const next = fs.mkdtempSync(path.join(dest, ".switch-"));
  try {
    const link = path.join(next, "current");
    fs.symlinkSync(release, link);
    fs.renameSync(link, current);
  } finally {
    fs.rmSync(next, { recursive: true, force: true });
  }
  if (!existing) {
    const envArgs = process.env.CFA_DATA_DIR ? ["--env", `CFA_DATA_DIR=${data}`] : [];
    run(codex, ["mcp", "add", NAME, ...envArgs, "--", "/bin/bash", launcher]);
  }

  console.log(prepared.fresh
    ? `Arc → Developer mode → Load unpacked → ${prepared.target}`
    : `Arc extension folder / Папка расширения Arc: ${prepared.target}`);
  console.log("Restart Codex and open a new chat. / Перезапустите Codex и откройте новый чат.");
  if (existing?.enabled === false) console.log("Enable arc in Codex Settings → MCP servers.");
}

try {
  install();
} catch (error) {
  console.error(`Installation failed / Ошибка установки: ${error.message}`);
  process.exitCode = 1;
}
