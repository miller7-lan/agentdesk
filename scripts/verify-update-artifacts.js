#!/usr/bin/env node
'use strict';
// Release workflow: checks the packages of one platform before they can be handed to VPS2.
//   node scripts/verify-update-artifacts.js win|windows|mac <dist folder> <version>
// - latest.yml / latest-mac.yml names this version, and every file it lists exists with that size and sha512;
// - the installer's block map exists (differential download needs it);
// - the packaged app has app-update.yml (updater cache folder, publisherName);
// - no connection settings or keys anywhere in the unpacked app (or, on macOS, in the zip).

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CONNECTION_FILES } = require('../orchestrator/update-manifest');

function parseLatest(text) {
  const result = { files: [] };
  let current;
  for (const line of text.split(/\r?\n/)) {
    let match;
    if ((match = /^version: (.+)$/.exec(line))) result.version = match[1].trim().replace(/^'|'$/g, '');
    else if ((match = /^ {2}- url: (.+)$/.exec(line))) { current = { url: match[1].trim() }; result.files.push(current); }
    else if (current && (match = /^ {4}sha512: (.+)$/.exec(line))) current.sha512 = match[1].trim();
    else if (current && (match = /^ {4}size: (\d+)$/.exec(line))) current.size = Number(match[1]);
  }
  return result;
}

function walk(folder) {
  const found = [];
  if (!fs.existsSync(folder)) return found;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function verify(platformArg, dist, version) {
  const platform = platformArg === 'windows' ? 'win' : platformArg;
  const problems = [];
  const latestName = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
  const latestFile = path.join(dist, latestName);
  if (!fs.existsSync(latestFile)) return [latestName + ' missing'];
  const latest = parseLatest(fs.readFileSync(latestFile, 'utf8'));
  if (latest.version !== version) problems.push(`${latestName} names ${latest.version}, expected ${version}`);
  if (!latest.files.length) problems.push(latestName + ' lists no files');
  for (const entry of latest.files) {
    const file = path.join(dist, entry.url);
    if (!fs.existsSync(file)) { problems.push(entry.url + ' listed but missing'); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.size) problems.push(entry.url + ' size differs from ' + latestName);
    if (createHash('sha512').update(bytes).digest('base64') !== entry.sha512) problems.push(entry.url + ' sha512 differs from ' + latestName);
  }
  const installer = latest.files.find((entry) => platform === 'win' ? entry.url.endsWith('-setup.exe') : entry.url.endsWith('.zip'));
  if (!installer) problems.push('no installer in ' + latestName);
  else if (!fs.existsSync(path.join(dist, installer.url + '.blockmap'))) problems.push(installer.url + '.blockmap missing');
  const apps = platform === 'win' ? [path.join(dist, 'win-unpacked')]
    : fs.readdirSync(dist).filter((name) => /^mac/.test(name)).map((name) => path.join(dist, name, 'AgentDesk.app'));
  if (!apps.some((app) => fs.existsSync(app))) problems.push('unpacked app not found');
  for (const app of apps.filter((item) => fs.existsSync(item))) {
    const resources = platform === 'win' ? path.join(app, 'resources') : path.join(app, 'Contents', 'Resources');
    if (!fs.existsSync(path.join(resources, 'app-update.yml'))) problems.push('app-update.yml missing in ' + path.relative(dist, resources));
    for (const file of walk(app)) if (CONNECTION_FILES.test(file)) problems.push('connection settings or key in the app: ' + path.relative(dist, file));
  }
  if (platform === 'mac') {
    for (const zip of fs.readdirSync(dist).filter((name) => name.endsWith('.zip'))) {
      const names = execFileSync('unzip', ['-Z1', path.join(dist, zip)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
      for (const name of names) if (name && CONNECTION_FILES.test(name)) problems.push('connection settings or key in ' + zip + ': ' + name);
    }
  }
  return problems;
}

if (require.main === module) {
  const [platform, dist, version] = process.argv.slice(2);
  const problems = verify(platform, dist, version);
  for (const problem of problems) console.error('::error::' + problem);
  if (problems.length) process.exitCode = 1;
  else console.log('update artifacts verified for', platform, version);
}

module.exports = { verify, parseLatest };
