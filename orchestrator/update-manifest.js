'use strict';
// The client-update manifest VPS2 hands out (client_update) and the helpers both sides share: strict release
// versions, file entries, and the latest.yml / latest-mac.yml electron-updater reads from the loopback feed.

const RELEASE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^AgentDesk-(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-(?:arm64|x64|universal))?(?:-mac)?(?:-setup\.exe|\.zip|\.dmg)(?:\.blockmap)?$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const COMMIT = /^[0-9a-f]{40}$/;
// Connection settings must never travel in an update; their names are refused wherever a file name is accepted.
const CONNECTION_FILES = /(^|[\\/])(agentdesk-(server|enrollment)\.json|known_hosts[^\\/]*|[^\\/]*_ed25519(\.pub)?|[^\\/]*\.token|remote\.json)$/i;
// A hard ceiling against a damaged manifest; the real size of every file comes from the manifest itself.
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const PLATFORMS = new Set(['win', 'mac']);
const ARCHS = new Set(['x64', 'arm64', 'universal']);

function parseVersion(value) {
  const match = typeof value === 'string' && SEMVER.exec(value);
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], prerelease: match[4] ? match[4].split('.') : [] };
}

// Semantic-version order (build metadata ignored). Returns -1, 0, 1, or null when either side is not a version.
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return +x < +y ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const isRelease = (value) => typeof value === 'string' && RELEASE.test(value);
const isPrerelease = (value) => Boolean(parseVersion(value)?.prerelease.length);

function validFileEntry(entry, version) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { name, size, sha512 } = entry;
  if (typeof name !== 'string' || !FILE_NAME.test(name) || CONNECTION_FILES.test(name)) return false;
  if (version !== undefined && !name.startsWith('AgentDesk-' + version + '-') && !name.startsWith('AgentDesk-' + version + '.')) return false;
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE_BYTES && typeof sha512 === 'string' && SHA512.test(sha512);
}

// Validates what VPS2 sent for this device. Anything unexpected makes the whole manifest invalid: the client then
// reports a failed check instead of acting on part of it.
function validateManifest(value, { platform, arch } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid_manifest' };
  const { version, files, previousBlockmaps = [], signed, commit, tag, platform: forPlatform, arch: forArch, notes, withdrawn } = value;
  if (!isRelease(version)) return { ok: false, error: 'invalid_manifest_version' };
  if (tag !== 'v' + version) return { ok: false, error: 'invalid_manifest_tag' };
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return { ok: false, error: 'invalid_manifest_commit' };
  if (typeof signed !== 'boolean') return { ok: false, error: 'invalid_manifest_signature_flag' };
  if (withdrawn !== undefined && withdrawn !== false) return { ok: false, error: 'manifest_withdrawn' };
  if (!PLATFORMS.has(forPlatform) || !ARCHS.has(forArch)) return { ok: false, error: 'invalid_manifest_platform' };
  if (platform && forPlatform !== platform) return { ok: false, error: 'manifest_platform_mismatch' };
  if (arch && forArch !== arch && forArch !== 'universal') return { ok: false, error: 'manifest_arch_mismatch' };
  if (!Array.isArray(files) || !files.length || files.length > 6 || !files.every((entry) => validFileEntry(entry, version))) {
    return { ok: false, error: 'invalid_manifest_files' };
  }
  if (!Array.isArray(previousBlockmaps) || previousBlockmaps.length > 8 ||
      !previousBlockmaps.every((entry) => validFileEntry(entry) && entry.name.endsWith('.blockmap'))) {
    return { ok: false, error: 'invalid_manifest_blockmaps' };
  }
  const names = [...files, ...previousBlockmaps].map((entry) => entry.name);
  if (new Set(names).size !== names.length) return { ok: false, error: 'invalid_manifest_files' };
  const installer = files.find((entry) => forPlatform === 'win' ? entry.name.endsWith('-setup.exe') : entry.name.endsWith('.zip'));
  if (!installer) return { ok: false, error: 'manifest_installer_missing' };
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) return { ok: false, error: 'invalid_manifest_notes' };
  return {
    ok: true,
    manifest: {
      version, tag, commit, signed, platform: forPlatform, arch: forArch,
      files: files.map(({ name, size, sha512 }) => ({ name, size, sha512 })),
      previousBlockmaps: previousBlockmaps.map(({ name, size, sha512 }) => ({ name, size, sha512 })),
      installer: { name: installer.name, size: installer.size, sha512: installer.sha512 },
      ...(notes && { notes }),
    },
  };
}

// Decides whether a validated manifest is an update for this client: strictly newer, never a downgrade, and never a
// prerelease for a stable build.
function updateDecision(currentVersion, manifest) {
  const order = compareVersions(manifest.version, currentVersion);
  if (order === null) return { update: false, reason: 'invalid_version' };
  if (order <= 0) return { update: false, reason: order === 0 ? 'current' : 'older' };
  if (isPrerelease(manifest.version) && !isPrerelease(currentVersion)) return { update: false, reason: 'prerelease' };
  return { update: true };
}

const yamlString = (value) => "'" + String(value).replace(/'/g, "''") + "'";

// The update information electron-updater expects (latest.yml on Windows, latest-mac.yml on macOS), built only from
// the validated manifest, so the feed can never announce a file VPS2 did not list.
function latestYaml(manifest, releaseDate = new Date().toISOString()) {
  const listed = manifest.files.filter((entry) => !entry.name.endsWith('.blockmap') &&
    (manifest.platform === 'win' ? entry.name.endsWith('.exe') : entry.name.endsWith('.zip') || entry.name.endsWith('.dmg')));
  const lines = ['version: ' + manifest.version, 'files:'];
  for (const entry of listed) {
    lines.push('  - url: ' + entry.name, '    sha512: ' + entry.sha512, '    size: ' + entry.size);
  }
  lines.push('path: ' + manifest.installer.name, 'sha512: ' + manifest.installer.sha512, 'releaseDate: ' + yamlString(releaseDate));
  return lines.join('\n') + '\n';
}

const feedFileName = (platform) => platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';

module.exports = {
  compareVersions, parseVersion, isRelease, isPrerelease, validateManifest, validFileEntry, updateDecision, latestYaml,
  feedFileName, CONNECTION_FILES, MAX_FILE_BYTES, FILE_NAME, SHA512,
};
