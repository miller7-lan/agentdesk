#!/usr/bin/env node
'use strict';
// VPS2: receives a client version from the release workflow. Meant as the forced command of a dedicated account,
//   restrict,command="/opt/agentdesk-node24/bin/node /opt/agentdesk-orchestrator/client-update-intake.js" ssh-ed25519 …
// (no shell, no forwarding, no PTY). It is not installed or enabled by this repository; deploying it is a separate,
// approved step (docs/AUTO-UPDATE.md).
//
// Per the owner's decision, a version that passes these checks is offered to clients at once, without a manual
// approval. The checks keep a stolen upload key from doing more than adding one new, higher version:
//   - only a new folder: an existing version (or a lower one) is never written or replaced;
//   - only plain vX.Y.Z, names from a fixed pattern, no connection files, bounded sizes, sha512 of every byte;
//   - provenance through GitHub's public API: the tag exists in the official repository and points to the commit,
//     and the run is the release workflow of that repository, triggered by that tag, on that commit;
//   - files go to a private temporary folder and become visible with one rename, after everything checked out.
//
// Input on stdin: one JSON line (the header), then the bytes of every listed file in the order listed.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { compareVersions, isRelease, validFileEntry, CONNECTION_FILES } = require('./update-manifest');
const { DEFAULT_ROOT } = require('./client-updates');

const REPOSITORY = 'miller7-lan/agentdesk';
const WORKFLOW_PATH = '.github/workflows/release.yml';
const MAX_HEADER = 64 * 1024;
const MAX_TOTAL = 3 * 1024 * 1024 * 1024;

class Input {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }
  async more() {
    const { value, done } = await this.iterator.next();
    if (done) return false;
    this.buffer = Buffer.concat([this.buffer, value]);
    return true;
  }
  async line(limit) {
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end >= 0) {
        const text = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        return text;
      }
      if (this.buffer.length > limit || !(await this.more())) throw new Error('intake_header_invalid');
    }
  }
  // Calls write(chunk) for exactly `size` bytes.
  async bytes(size, write) {
    let left = size;
    while (left > 0) {
      if (!this.buffer.length && !(await this.more())) throw new Error('intake_truncated');
      const part = this.buffer.subarray(0, Math.min(left, this.buffer.length));
      this.buffer = this.buffer.subarray(part.length);
      left -= part.length;
      await write(part);
    }
  }
  async end() {
    if (this.buffer.length || await this.more()) throw new Error('intake_trailing_data');
  }
}

function validateHeader(header) {
  if (!header || typeof header !== 'object') throw new Error('intake_header_invalid');
  const { version, tag, commit, runId, signed, artifacts, notes } = header;
  if (!isRelease(version) || tag !== 'v' + version) throw new Error('intake_version_invalid');
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !Number.isSafeInteger(runId) || runId <= 0) throw new Error('intake_provenance_invalid');
  if (typeof signed !== 'boolean') throw new Error('intake_header_invalid');
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) throw new Error('intake_header_invalid');
  if (!Array.isArray(artifacts) || !artifacts.length || artifacts.length > 4) throw new Error('intake_artifacts_invalid');
  const names = new Set();
  let total = 0;
  for (const artifact of artifacts) {
    if (!['win', 'mac'].includes(artifact?.platform) || !['x64', 'arm64', 'universal'].includes(artifact.arch) ||
        !Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > 6) throw new Error('intake_artifacts_invalid');
    for (const entry of artifact.files) {
      if (!validFileEntry(entry, version) || CONNECTION_FILES.test(entry.name) || names.has(entry.name)) throw new Error('intake_file_invalid');
      names.add(entry.name);
      total += entry.size;
    }
    const installer = artifact.platform === 'win' ? '-setup.exe' : '.zip';
    if (!artifact.files.some((entry) => entry.name.endsWith(installer))) throw new Error('intake_installer_missing');
  }
  if (total > MAX_TOTAL) throw new Error('intake_too_large');
  return { version, tag, commit, runId, signed, artifacts: artifacts.map(({ platform, arch, files }) =>
    ({ platform, arch, files: files.map(({ name, size, sha512 }) => ({ name, size, sha512 })) })), ...(notes && { notes }) };
}

// GitHub's public REST API (no token needed for a public repository).
async function githubProvenance({ tag, commit, runId }, { fetch = globalThis.fetch, repository = REPOSITORY } = {}) {
  const api = (route) => fetch('https://api.github.com/repos/' + repository + route, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentdesk-client-update-intake' },
  }).then((response) => {
    if (!response.ok) throw new Error('intake_provenance_failed');
    return response.json();
  });
  const ref = await api('/git/ref/tags/' + encodeURIComponent(tag));
  let object = ref.object;
  if (object?.type === 'tag') object = (await api('/git/tags/' + object.sha)).object;
  if (object?.type !== 'commit' || object.sha !== commit) throw new Error('intake_tag_mismatch');
  const run = await api('/actions/runs/' + runId);
  if (run.head_sha !== commit || run.path !== WORKFLOW_PATH || run.event !== 'push' || run.head_branch !== tag ||
      run.repository?.full_name !== repository || run.conclusion === 'failure' || run.conclusion === 'cancelled') {
    throw new Error('intake_run_mismatch');
  }
}

async function receive({ input, root = DEFAULT_ROOT, verify = githubProvenance, now = () => new Date() }) {
  const reader = new Input(input);
  let header;
  try { header = JSON.parse(await reader.line(MAX_HEADER)); } catch { throw new Error('intake_header_invalid'); }
  const manifest = validateHeader(header);
  const versions = path.join(root, 'versions');
  const incoming = path.join(root, 'incoming');
  fs.mkdirSync(versions, { recursive: true, mode: 0o755 });
  fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'intake.lock');
  // One intake at a time. A lock left by a crash stays until the admin removes it (no guessing about stale locks).
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch (error) {
    throw new Error(error.code === 'EEXIST' ? 'intake_busy' : 'intake_failed');
  }
  const work = path.join(incoming, randomBytes(12).toString('hex'));
  try {
    // Only forward: never the same version again, never one below the highest already received (withdrawn included).
    const existing = fs.readdirSync(versions).filter(isRelease);
    if (existing.includes(manifest.version)) throw new Error('intake_version_exists');
    if (existing.some((version) => compareVersions(version, manifest.version) >= 0)) throw new Error('intake_version_not_newer');
    fs.mkdirSync(work, { mode: 0o700 });
    for (const artifact of manifest.artifacts) {
      for (const entry of artifact.files) {
        const hash = createHash('sha512');
        const handle = fs.openSync(path.join(work, entry.name), 'wx', 0o644);
        try {
          await reader.bytes(entry.size, async (chunk) => { hash.update(chunk); fs.writeSync(handle, chunk); });
        } finally { fs.closeSync(handle); }
        if (hash.digest('base64') !== entry.sha512) throw new Error('intake_checksum_mismatch');
      }
    }
    await reader.end();
    await verify(manifest);
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ ...manifest, receivedAt: now().toISOString() }, null, 2) + '\n',
      { flag: 'wx', mode: 0o644 });
    fs.chmodSync(work, 0o755);
    const target = path.join(versions, manifest.version);
    if (fs.existsSync(target)) throw new Error('intake_version_exists');
    fs.renameSync(work, target);
    const latest = path.join(root, 'latest.json');
    const temporary = latest + '.' + randomBytes(6).toString('hex');
    fs.writeFileSync(temporary, JSON.stringify({ version: manifest.version }) + '\n', { mode: 0o644 });
    fs.renameSync(temporary, latest);
    return { ok: true, version: manifest.version };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
}

if (require.main === module) {
  const root = process.env.AGENTDESK_CLIENT_UPDATES || DEFAULT_ROOT;
  receive({ input: process.stdin, root }).then(
    (result) => { process.stdout.write(JSON.stringify(result) + '\n'); },
    (error) => {
      // Only the error code: no paths, no file contents.
      const code = /^intake_[a-z_]+$/.test(error?.message) ? error.message : 'intake_failed';
      process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
      process.exitCode = 1;
    },
  );
}

module.exports = { receive, validateHeader, githubProvenance, REPOSITORY, WORKFLOW_PATH };
