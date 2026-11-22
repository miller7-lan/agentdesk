'use strict';
// Connection settings baked into an installer (agentdesk-server.json, agentdesk-enrollment.json, written by the
// release workflow's bundle_connection option) live in the install folder, which every update replaces. Update
// packages never carry them (the owner's decision: one generic package for every computer), so the first version
// with updates copies them, unchanged, into this computer's user-data folder, and from then on the local copy is
// read first:
//
//   1. <userData>/bundled-connection/<name>   (local copy — wins)
//   2. <resources>/<name>                       (only used when there is no local copy yet, and copied there)
//
// A later installer that does carry different settings (someone installs a build for another server by hand) does
// not silently replace the local copy: the app asks, keeps the local settings by default, and backs them up before
// switching. The files are never logged, uploaded or shown — only their hashes are compared.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const NAMES = ['agentdesk-server.json', 'agentdesk-enrollment.json'];
const FOLDER = 'bundled-connection';

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function copyPrivate(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const temporary = to + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.copyFileSync(from, temporary);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, to);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Copies settings found in the install folder that have no local copy yet. Never overwrites a local copy.
// Returns the names copied and the names whose installer copy differs from the local one (for the question).
function migrate({ resourcesDir, userDataDir }) {
  const local = path.join(userDataDir, FOLDER);
  const migrated = [];
  const conflicts = [];
  for (const name of NAMES) {
    const bundled = path.join(resourcesDir, name);
    const mine = path.join(local, name);
    if (!exists(bundled)) continue;
    if (!exists(mine)) {
      copyPrivate(bundled, mine);
      migrated.push(name);
    } else if (hash(bundled) !== hash(mine)) conflicts.push(name);
  }
  if (migrated.length) {
    const record = path.join(local, 'migration.json');
    const previous = exists(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : {};
    for (const name of migrated) previous[name] = { sha256: hash(path.join(local, name)), at: new Date().toISOString() };
    fs.writeFileSync(record, JSON.stringify(previous, null, 2) + '\n', { mode: 0o600 });
  }
  return { migrated, conflicts };
}

// Where a connection file is read from: the local copy when there is one, else the install folder, else nothing.
function resolve(name, { resourcesDir, userDataDir }) {
  if (!NAMES.includes(name)) throw new Error('unknown_connection_file');
  if (userDataDir) {
    const mine = path.join(userDataDir, FOLDER, name);
    if (exists(mine)) return mine;
  }
  const bundled = resourcesDir && path.join(resourcesDir, name);
  return bundled && exists(bundled) ? bundled : bundled || null;
}

// The person chose the installer's settings over the local ones: the local copy is backed up first.
function adopt(name, { resourcesDir, userDataDir, now = () => new Date() }) {
  if (!NAMES.includes(name)) throw new Error('unknown_connection_file');
  const local = path.join(userDataDir, FOLDER);
  const mine = path.join(local, name);
  const backup = path.join(local, 'backup-' + now().toISOString().replace(/[:.]/g, '-'));
  if (exists(mine)) copyPrivate(mine, path.join(backup, name));
  copyPrivate(path.join(resourcesDir, name), mine);
  return { backup };
}

// Hashes of the files an update must leave alone (compared before and after an installation; contents never read
// into logs).
function snapshot(files) {
  const result = {};
  for (const [label, file] of Object.entries(files)) {
    if (!file) continue;
    try { result[label] = exists(file) ? hash(file) : 'missing'; } catch { result[label] = 'unreadable'; }
  }
  return result;
}

// In the packaged Electron app: the install folder and this computer's user-data folder. Elsewhere (tests, Node):
// the install folder only, as before.
function electronDirs() {
  if (!process.resourcesPath) return { resourcesDir: null, userDataDir: null };
  try {
    const { app } = require('electron');
    if (app?.isPackaged) return { resourcesDir: process.resourcesPath, userDataDir: app.getPath('userData') };
  } catch {}
  return { resourcesDir: process.resourcesPath, userDataDir: null };
}

module.exports = { NAMES, FOLDER, migrate, resolve, adopt, snapshot, electronDirs };
