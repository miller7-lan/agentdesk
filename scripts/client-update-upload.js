#!/usr/bin/env node
'use strict';
// Release workflow: writes the intake stream (orchestrator/client-update-intake.js) for one version to stdout —
// a JSON header line, then the bytes of every file — so the workflow can pipe it into the dedicated SSH account.
//
//   node scripts/client-update-upload.js --version 0.3.0 --commit <sha> --run-id <id> --signed false \
//     --artifact win:x64:dist-win --artifact mac:arm64:dist-mac | ssh … agentdesk-update@vps2
//
// Only the update files are sent (Windows: NSIS setup + block map; macOS: zip + block map). It refuses to run when
// an artifact folder holds connection settings or keys, so a build with bundled connection settings cannot be
// uploaded by mistake. Nothing secret is printed.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isRelease, CONNECTION_FILES } = require('../orchestrator/update-manifest');

function args(argv) {
  const result = { artifacts: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === '--artifact') result.artifacts.push(value);
    else if (['--version', '--commit', '--run-id', '--signed', '--notes'].includes(name)) result[name.slice(2)] = value;
    else throw new Error('unknown argument ' + name);
  }
  return result;
}

function walk(folder) {
  const found = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function updateFiles(platform, arch, folder, version) {
  const leaked = walk(folder).filter((file) => CONNECTION_FILES.test(file));
  if (leaked.length) throw new Error(`connection settings or keys found in the ${platform} artifact; refusing to upload`);
  const names = platform === 'win'
    ? [`AgentDesk-${version}-setup.exe`, `AgentDesk-${version}-setup.exe.blockmap`]
    : arch === 'arm64'
      ? [`AgentDesk-${version}-arm64-mac.zip`, `AgentDesk-${version}-arm64-mac.zip.blockmap`]
      : [`AgentDesk-${version}-mac.zip`, `AgentDesk-${version}-mac.zip.blockmap`];
  return names.map((name) => {
    const file = path.join(folder, name);
    const bytes = fs.readFileSync(file);
    return { name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64'), file };
  });
}

function build(options) {
  const version = options.version;
  if (!isRelease(version)) throw new Error('version must be plain x.y.z');
  if (!/^[0-9a-f]{40}$/.test(options.commit || '')) throw new Error('commit must be a full sha');
  const runId = Number(options['run-id']);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('run id required');
  if (!['true', 'false'].includes(options.signed)) throw new Error('--signed true|false required');
  const artifacts = options.artifacts.map((spec) => {
    // platform:arch:folder — the folder may itself hold colons (a Windows drive, D:\\a\\…).
    const [platform, arch, ...rest] = String(spec).split(':');
    const folder = rest.join(':');
    if (!['win', 'mac'].includes(platform) || !['x64', 'arm64'].includes(arch) || !folder) throw new Error('bad --artifact ' + spec);
    return { platform, arch, files: updateFiles(platform, arch, folder, version) };
  });
  if (!artifacts.length) throw new Error('no artifacts');
  const header = { version, tag: 'v' + version, commit: options.commit, runId, signed: options.signed === 'true',
    artifacts: artifacts.map(({ platform, arch, files }) => ({ platform, arch, files: files.map(({ name, size, sha512 }) => ({ name, size, sha512 })) })),
    ...(options.notes && { notes: options.notes.slice(0, 2000) }) };
  return { header, files: artifacts.flatMap((artifact) => artifact.files) };
}

async function write(output, { header, files }) {
  output.write(JSON.stringify(header) + '\n');
  for (const entry of files) {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(entry.file);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(output, { end: false });
    });
  }
  output.end();
}

if (require.main === module) {
  try {
    const plan = build(args(process.argv.slice(2)));
    for (const entry of plan.files) console.error(`upload ${entry.name} ${entry.size} bytes`);
    write(process.stdout, plan).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build, write, args };
