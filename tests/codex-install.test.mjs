import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-codex-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'bundle');
  const data = path.join(dir, 'data');
  const target = path.join(dir, 'extension');
  const state = path.join(dir, 'codex-state.json');
  const log = path.join(dir, 'codex-log.json');
  const bin = path.join(dir, 'codex');
  fs.mkdirSync(path.join(bundle, 'server'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'extension'), { recursive: true });
  fs.copyFileSync(new URL('codex/install.cjs', root), path.join(bundle, 'install.cjs'));
  fs.copyFileSync(new URL('server/deploy.js', root), path.join(bundle, 'server/deploy.js'));
  fs.writeFileSync(path.join(bundle, 'server/package.json'), JSON.stringify({ version: '0.6.0' }));
  fs.writeFileSync(path.join(bundle, 'extension/manifest.json'), JSON.stringify({ version: '0.6.0', name: 'Agent for Arc' }));
  for (const file of ['LICENSE', 'NODE-LICENSE']) fs.writeFileSync(path.join(bundle, file), 'test license');
  // Use the actual deployer, with an isolated minimal server: no browser, API,
  // websocket or dependency installation is needed to test the installer.
  fs.writeFileSync(path.join(bundle, 'server/server.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const { deployExtension } = require('./deploy.js');
    const dataDir = process.env.CFA_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    const tokenFile = path.join(dataDir, 'token');
    if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, require('node:crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const deployed = deployExtension({ token, dataDir, log() {} });
    console.log(JSON.stringify(process.argv[2] === '--prepare-extension' ? deployed : {
      deploy: process.env.CFA_DEPLOY_EXTENSION, noOpen: process.env.CFA_NO_OPEN,
      keep: process.env.CFA_KEEP_INSTALLED_EXTENSION, deployed
    }));
  `);
  fs.writeFileSync(bin, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[1] === 'list') console.log(fs.existsSync(process.env.TEST_STATE) ? fs.readFileSync(process.env.TEST_STATE, 'utf8') : '[]');
    else if (args[1] === 'add') {
      fs.writeFileSync(process.env.TEST_LOG, JSON.stringify(args));
      const dash = args.indexOf('--');
      fs.writeFileSync(process.env.TEST_STATE, JSON.stringify([{ name: args[2], transport: { command: args[dash + 1], args: args.slice(dash + 2) } }]));
    } else process.exit(9);
  `, { mode: 0o700 });
  const env = { ...process.env, CFA_CODEX_BIN: bin, CFA_DATA_DIR: data, CFA_EXTENSION_DIR: target, CFA_NO_OPEN: '1', CFA_KEEP_INSTALLED_EXTENSION: '1', TEST_STATE: state, TEST_LOG: log };
  // Homebrew Node uses a relative libnode dylib; the release ships standalone
  // Node. Let a copied test runtime find its original library without changing
  // the production installer or requiring a download in this test.
  if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = [path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../lib'), process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
  delete env.CFA_TOKEN;
  const launcher = path.join(data, 'codex/start.sh');
  const run = () => spawnSync(process.execPath, [path.join(bundle, 'install.cjs')], { env, encoding: 'utf8' });
  return { dir, bundle, data, target, state, log, env, launcher, run };
}

test('fresh Codex install prepares key, registers arc, and starts a deploying launcher', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const token = fs.readFileSync(path.join(f.data, 'token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'key.json'))).token, token);
  assert.equal(fs.statSync(path.join(f.target, 'key.json')).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(token));
  const args = JSON.parse(fs.readFileSync(f.log));
  assert.equal(args[2], 'arc');
  assert.deepEqual(args.slice(-2), ['/bin/bash', f.launcher]);
  if (process.platform === 'darwin') {
    // System bash strips DYLD_* variables under SIP. Supply Homebrew's dylib
    // beside this test copy only, so the unmodified launcher can be exercised.
    const libDir = path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../lib');
    for (const file of fs.readdirSync(libDir).filter(name => /^libnode.*\.dylib$/.test(name))) {
      fs.symlinkSync(path.join(libDir, file), path.join(f.data, 'codex/current', file));
    }
  }
  const launched = spawnSync('/bin/bash', [f.launcher], { env: f.env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  const probe = JSON.parse(launched.stdout);
  assert.equal(probe.deploy, '1');
  assert.equal(probe.noOpen, '1');
  assert.equal(probe.keep, '0');
});

test('upgrade replaces old Claude extension and original launcher, retains key and arc entry', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, 'manifest.json'), JSON.stringify({ version: '0.4.0', name: 'Claude for Arc' }));
  fs.writeFileSync(path.join(f.target, 'obsolete.txt'), 'old');
  fs.mkdirSync(path.dirname(f.launcher), { recursive: true });
  const oldLauncher = '#!/bin/bash\nset -euo pipefail\nrelease="$(cd "$(dirname "$0")/current" && pwd -P)"\nexec "$release/node" "$release/server/server.js"\n';
  fs.writeFileSync(f.launcher, oldLauncher, { mode: 0o700 });
  fs.writeFileSync(path.join(f.data, 'token'), 'a'.repeat(64));
  const existing = [{ name: 'arc', enabled: false, transport: { command: '/bin/bash', args: [f.launcher] } }];
  fs.writeFileSync(f.state, JSON.stringify(existing));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /arc:\/\/extensions/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'manifest.json'))).name, 'Agent for Arc');
  assert.equal(fs.existsSync(path.join(f.target, 'obsolete.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'key.json'))).token, 'a'.repeat(64));
  assert.match(fs.readFileSync(f.launcher, 'utf8'), /CFA_DEPLOY_EXTENSION=1/);
  assert.equal(fs.existsSync(f.log), false); // Existing registration stays intact.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)), existing);
  assert.equal(f.run().status, 0); // Reinstall of the managed version is safe.
});

test('custom launcher is preserved and reported before extension changes', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.launcher), { recursive: true });
  const custom = '#!/bin/bash\necho custom\n';
  fs.writeFileSync(f.launcher, custom);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /launcher was customized/);
  assert.equal(fs.readFileSync(f.launcher, 'utf8'), custom);
  assert.equal(fs.existsSync(f.target), false);
});
