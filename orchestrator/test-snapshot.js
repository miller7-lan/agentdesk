const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { git } = require('./git');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const excluded = /^(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.agentdesk|\.codex|\.claude|\.gemini|\.grok|\.netrc|\.npmrc|\.git-credentials|\.pgpass|node_modules|__pycache__|\.cache|\.venv|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.+\.(?:key|pem|pfx|p12))$/i;
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;

function validPath(relative) {
  const parts = typeof relative === 'string' && relative.split('/');
  return Boolean(parts && relative.length <= 1000 && parts.every((part) => part && part.length <= 255 &&
    part !== '.' && part !== '..' && !/[\\<>:"|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part) &&
    !reserved.test(part) && !excluded.test(part)));
}

function validateManifest(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error('invalid_test_manifest');
  const components = new Map();
  let bytes = 0;
  let previous;
  for (const entry of entries) {
    if (!entry || !validPath(entry.path) || (previous !== undefined && previous >= entry.path) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !hashPattern.test(entry.sha256) ||
        typeof entry.executable !== 'boolean') throw new Error('invalid_test_manifest');
    previous = entry.path;
    bytes += entry.size;
    if (bytes > MAX_BYTES) throw new Error('test_snapshot_too_large');
    let prefix = '';
    const parts = entry.path.split('/');
    for (const [index, part] of parts.entries()) {
      prefix += (prefix ? '/' : '') + part;
      const folded = prefix.normalize('NFC').toLowerCase();
      const type = index === parts.length - 1 ? 'file' : 'directory';
      const existing = components.get(folded);
      if (existing && (existing.path !== prefix || existing.type !== type)) throw new Error('test_snapshot_path_conflict');
      components.set(folded, { path: prefix, type });
    }
  }
}

const versionOf = (base, entries) => digest(JSON.stringify([base, entries.map(({ path, size, sha256, executable }) =>
  [path, size, sha256, executable])]));

async function regularFile(root, relative) {
  if (!validPath(relative)) throw new Error('invalid_test_path');
  let filename = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    const info = await fs.lstat(filename);
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) {
      throw new Error('unsupported_test_file');
    }
  }
  return filename;
}

async function collectSnapshot(root, base, signal) {
  const listing = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal);
  const names = [...new Set(listing.split('\0').filter(Boolean))].sort();
  const entries = [];
  const contents = new Map();
  let size = 0;
  for (const relative of names) {
    signal?.throwIfAborted();
    if (relative.split('/').some((part) => excluded.test(part))) continue;
    const filename = await regularFile(root, relative);
    const info = await fs.stat(filename);
    size += info.size;
    if (size > MAX_BYTES || entries.length >= MAX_ENTRIES) throw new Error('test_snapshot_too_large');
    const content = await fs.readFile(filename);
    if (content.length !== info.size) throw new Error('test_snapshot_changed');
    entries.push({ path: relative, size: content.length, sha256: digest(content), executable: Boolean(info.mode & 0o111) });
    contents.set(relative, content);
  }
  validateManifest(entries);
  return { base, entries, version: versionOf(base, entries), contents };
}

function encodeSnapshot(snapshot, previous) {
  const known = new Map((previous?.entries || []).map((entry) => [entry.path, entry.sha256]));
  const files = snapshot.entries.filter((entry) => known.get(entry.path) !== entry.sha256)
    .map((entry) => [entry.path, snapshot.contents.get(entry.path).toString('base64')]);
  const { base, entries, version } = snapshot;
  return gzipSync(JSON.stringify({ base, entries, version, previous: previous?.version || null, files }));
}

function decodeSnapshot(bytes) {
  let value;
  try { value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 2 * MAX_BYTES }).toString('utf8')); }
  catch { throw new Error('invalid_test_snapshot'); }
  if (!value || !/^[a-f0-9]{40,64}$/.test(value.base) ||
      (value.previous !== null && !hashPattern.test(value.previous)) || !Array.isArray(value.files) ||
      value.files.length > MAX_ENTRIES) throw new Error('invalid_test_snapshot');
  validateManifest(value.entries);
  if (versionOf(value.base, value.entries) !== value.version) throw new Error('test_snapshot_checksum');
  const entries = new Map(value.entries.map((entry) => [entry.path, entry]));
  const files = new Map();
  for (const pair of value.files) {
    if (!Array.isArray(pair) || pair.length !== 2 || !entries.has(pair[0]) || files.has(pair[0]) ||
        typeof pair[1] !== 'string') throw new Error('invalid_test_snapshot');
    const expected = entries.get(pair[0]);
    const content = Buffer.from(pair[1], 'base64');
    if (content.length !== expected.size || digest(content) !== expected.sha256) throw new Error('test_snapshot_checksum');
    files.set(pair[0], content);
  }
  return { ...value, files };
}

async function snapshotDirectory(stateDir, taskId, version) {
  if (!/^[0-9a-f-]{36}$/.test(taskId) || !hashPattern.test(version)) throw new Error('invalid_test_snapshot');
  const root = path.join(await fs.realpath(stateDir), 'isolated-tests', taskId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (await fs.realpath(root) !== root) throw new Error('invalid_test_workspace');
  return path.join(root, version);
}

async function readEntry(directory, entry) {
  if (await fs.realpath(directory) !== directory) throw new Error('invalid_test_workspace');
  const filename = await regularFile(directory, entry.path);
  const info = await fs.stat(filename);
  if (info.size !== entry.size) throw new Error('test_snapshot_checksum');
  const content = await fs.readFile(filename);
  if (digest(content) !== entry.sha256) throw new Error('test_snapshot_checksum');
  return content;
}

async function materialize(entries, temporary, load) {
  for (const entry of entries) {
    const content = await load(entry);
    const filename = path.join(temporary, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
  }
}

async function installSnapshot(stateDir, taskId, bytes) {
  const snapshot = decodeSnapshot(bytes);
  const target = await snapshotDirectory(stateDir, taskId, snapshot.version);
  const exists = await fs.lstat(target).then(() => true, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (exists) {
    if (await fs.realpath(target) !== target) throw new Error('invalid_test_workspace');
    for (const entry of snapshot.entries) await readEntry(path.join(target, 'files'), entry);
    return snapshot.version;
  }
  const previous = snapshot.previous && await snapshotDirectory(stateDir, taskId, snapshot.previous);
  if (previous && await fs.realpath(previous).catch(() => null) !== previous) throw new Error('test_snapshot_parent_missing');
  const temporary = await fs.mkdtemp(path.join(path.dirname(target), 'sync-'));
  try {
    const directory = path.join(temporary, 'files');
    await fs.mkdir(directory);
    await materialize(snapshot.entries, directory, async (entry) => {
      if (snapshot.files.has(entry.path)) return snapshot.files.get(entry.path);
      if (!previous) throw new Error('test_snapshot_payload_missing');
      return readEntry(path.join(previous, 'files'), entry).catch(() => { throw new Error('test_snapshot_parent_invalid'); });
    });
    const { base, entries, version } = snapshot;
    await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ base, entries, version }), { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return snapshot.version;
}

async function buildCopy(stateDir, taskId, version) {
  const source = await snapshotDirectory(stateDir, taskId, version);
  if (await fs.realpath(source) !== source) throw new Error('invalid_test_workspace');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  validateManifest(manifest.entries);
  if (manifest.version !== version || versionOf(manifest.base, manifest.entries) !== version) throw new Error('test_snapshot_checksum');
  const root = await fs.mkdtemp(path.join(path.dirname(source), 'build-'));
  try {
    await materialize(manifest.entries, root, (entry) => readEntry(path.join(source, 'files'), entry));
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { collectSnapshot, encodeSnapshot, decodeSnapshot, installSnapshot, buildCopy, regularFile, digest };
