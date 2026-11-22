'use strict';
// VPS2: the client versions the intake accepted (client-update-intake.js), offered to each device through the
// control channel — client_update (which version, for this device and platform) and client_update_read (one range
// of one listed file). Read-only: nothing here writes the version folders.
//
// Layout under the root (default /var/lib/agentdesk-orchestrator/client-updates):
//   versions/<x.y.z>/manifest.json + the files it lists       (written once by the intake, never overwritten)
//   withdrawn.json   ["0.3.1", ...]                             (versions no longer offered; the admin edits it)
//   policy.json      { "hold": { "devices": [], "platforms": [] },
//                      "versions": { "0.3.1": { "devices": ["windows"], "platforms": ["win"] } } }
//   latest.json      { "version": "x.y.z" }                     (for the single-chat notice; written by the intake)

const fs = require('node:fs');
const path = require('node:path');
const { compareVersions, isRelease, validFileEntry, FILE_NAME, CONNECTION_FILES, MAX_FILE_BYTES } = require('./update-manifest');

const DEFAULT_ROOT = '/var/lib/agentdesk-orchestrator/client-updates';
// One reply carries at most this many raw bytes; base64 inside a frame stays below MAX_FRAME (transport.js).
// This read path is separate from task_artifacts and its 20 MB limit (windows.js MAX_FILE): installers are larger.
const READ_CHUNK = 128 * 1024;
const PREVIOUS_BLOCKMAPS = 6;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('client_update_store_unreadable');
  }
}

function validArtifact(artifact, version) {
  return artifact && ['win', 'mac'].includes(artifact.platform) && ['x64', 'arm64', 'universal'].includes(artifact.arch) &&
    Array.isArray(artifact.files) && artifact.files.length > 0 && artifact.files.length <= 6 &&
    artifact.files.every((entry) => validFileEntry(entry, version));
}

function validStoredManifest(value, version) {
  return value && value.version === version && value.tag === 'v' + version && /^[0-9a-f]{40}$/.test(value.commit || '') &&
    typeof value.signed === 'boolean' && Array.isArray(value.artifacts) && value.artifacts.length > 0 &&
    value.artifacts.every((artifact) => validArtifact(artifact, version));
}

class ClientUpdates {
  constructor({ root = DEFAULT_ROOT } = {}) {
    this.root = root;
  }

  versions() {
    const folder = path.join(this.root, 'versions');
    let names;
    try { names = fs.readdirSync(folder); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('client_update_store_unreadable');
    }
    const withdrawn = new Set(readJson(path.join(this.root, 'withdrawn.json'), []));
    const found = [];
    for (const version of names.filter(isRelease)) {
      let manifest;
      try { manifest = readJson(path.join(folder, version, 'manifest.json'), null); } catch { continue; }
      if (!validStoredManifest(manifest, version)) continue;
      found.push({ ...manifest, withdrawn: withdrawn.has(version) });
    }
    return found.sort((a, b) => compareVersions(b.version, a.version));
  }

  policy() {
    const value = readJson(path.join(this.root, 'policy.json'), {});
    return value && typeof value === 'object' ? value : {};
  }

  static artifactFor(manifest, platform, arch) {
    const list = manifest.artifacts.filter((item) => item.platform === platform);
    return list.find((item) => item.arch === arch) || list.find((item) => item.arch === 'universal') ||
      (platform === 'win' ? null : list.find((item) => item.arch === 'x64' && arch === 'x64'));
  }

  // Q5: a version can be limited to some devices or platforms, and a device or platform can be held back.
  static allowed(policy, version, device, platform) {
    const hold = policy.hold || {};
    if ((hold.devices || []).includes(device) || (hold.platforms || []).includes(platform)) return false;
    const target = policy.versions?.[version];
    if (!target) return true;
    if (Array.isArray(target.devices) && !target.devices.includes(device)) return false;
    if (Array.isArray(target.platforms) && !target.platforms.includes(platform)) return false;
    return true;
  }

  latestFor({ device, platform, arch }) {
    if (!['win', 'mac'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('invalid_client_platform');
    const policy = this.policy();
    const versions = this.versions();
    for (const [index, manifest] of versions.entries()) {
      if (manifest.withdrawn || !ClientUpdates.allowed(policy, manifest.version, device, platform)) continue;
      const artifact = ClientUpdates.artifactFor(manifest, platform, arch);
      if (!artifact) continue;
      // Block maps of the versions before it, so a client on one of them can download only what changed.
      const previousBlockmaps = [];
      for (const older of versions.slice(index + 1)) {
        const olderArtifact = ClientUpdates.artifactFor(older, platform, arch);
        for (const entry of olderArtifact?.files || []) {
          if (entry.name.endsWith('.blockmap') && previousBlockmaps.length < PREVIOUS_BLOCKMAPS) previousBlockmaps.push(entry);
        }
      }
      return {
        version: manifest.version, tag: manifest.tag, commit: manifest.commit, signed: manifest.signed,
        platform, arch: artifact.arch, files: artifact.files, previousBlockmaps,
        ...(typeof manifest.notes === 'string' && { notes: manifest.notes.slice(0, 2000) }),
      };
    }
    return null;
  }

  // One range of a file listed for this device: the offered version's files or an earlier version's block map.
  read({ device, platform, arch, version, file, offset, length }) {
    if (!isRelease(version) || typeof file !== 'string' || !FILE_NAME.test(file) || CONNECTION_FILES.test(file)) throw new Error('invalid_update_file');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new Error('invalid_update_range');
    const offered = this.latestFor({ device, platform, arch });
    if (!offered || offered.version !== version) throw new Error('update_version_not_offered');
    const entry = [...offered.files, ...offered.previousBlockmaps].find((item) => item.name === file);
    if (!entry) throw new Error('invalid_update_file');
    const owner = offered.files.includes(entry) ? version : /^AgentDesk-(\d+\.\d+\.\d+)/.exec(file)[1];
    const versionsRoot = fs.realpathSync(path.join(this.root, 'versions'));
    const filename = path.join(versionsRoot, owner, file);
    const real = fs.realpathSync(filename);
    if (path.dirname(real) !== path.join(versionsRoot, owner)) throw new Error('invalid_update_file');
    const handle = fs.openSync(real, 'r');
    try {
      const { size } = fs.fstatSync(handle);
      if (size !== entry.size || size > MAX_FILE_BYTES) throw new Error('update_file_changed');
      if (offset >= size) throw new Error('invalid_update_range');
      const buffer = Buffer.alloc(Math.min(length, READ_CHUNK, size - offset));
      const count = fs.readSync(handle, buffer, 0, buffer.length, offset);
      return { file, offset, size, data: buffer.subarray(0, count).toString('base64') };
    } finally { fs.closeSync(handle); }
  }

  // The newest version on offer at all, for the single-chat notice (no device detail needed there).
  newest() {
    return readJson(path.join(this.root, 'latest.json'), null)?.version || null;
  }
}

// The control-channel entry used by the scheduler.
function clientUpdateControl(store, operation, update, device) {
  const request = update && typeof update === 'object' ? update : {};
  const platform = request.platform;
  const arch = request.arch;
  if (operation === 'client_update') {
    const manifest = store.latestFor({ device, platform, arch });
    if (!manifest) return { available: false };
    const current = typeof request.appVersion === 'string' ? request.appVersion : null;
    if (current && compareVersions(manifest.version, current) !== 1) return { available: false };
    return { available: true, manifest };
  }
  if (operation === 'client_update_read') {
    return store.read({ device, platform, arch, version: request.version, file: request.file, offset: request.offset, length: request.length });
  }
  throw new Error('unsupported_operation');
}

module.exports = { ClientUpdates, clientUpdateControl, DEFAULT_ROOT, READ_CHUNK };
