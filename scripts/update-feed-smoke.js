'use strict';
// Release workflow (windows-upgrade-check), run with Electron: the real electron-updater NsisUpdater downloads the
// next version through the loopback feed (update-transport.js), whose reads come from a local folder standing in for
// VPS2's client_update_read. It reports what crossed the "channel" for the installer — the measured differential
// effect on a CI runner — and never installs anything.
//
//   npx electron scripts/update-feed-smoke.js <current version> <folder with vN+1 files and vN blockmap> <installed resources>
//
// Output: one JSON line. A runner is not a person's computer; the result is labelled as such in the docs.

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLoopbackFeed } = require('../update-transport');
const { validateManifest } = require('../orchestrator/update-manifest');

async function main() {
  const [currentVersion, folder, resources] = process.argv.slice(-3);
  const entry = (name) => {
    const bytes = fs.readFileSync(path.join(folder, name));
    return { name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') };
  };
  const names = fs.readdirSync(folder);
  const installer = names.find((name) => /^AgentDesk-\d+\.\d+\.\d+-setup\.exe$/.test(name) && !name.includes(currentVersion + '-'));
  const version = /^AgentDesk-(\d+\.\d+\.\d+)-/.exec(installer)[1];
  const checked = validateManifest({
    version, tag: 'v' + version, commit: '0'.repeat(40), signed: false, platform: 'win', arch: 'x64',
    files: [entry(installer), entry(installer + '.blockmap')],
    previousBlockmaps: names.filter((name) => name === `AgentDesk-${currentVersion}-setup.exe.blockmap`).map(entry),
  }, { platform: 'win', arch: 'x64' });
  if (!checked.ok) throw new Error(checked.error);
  const feed = createLoopbackFeed({ manifest: checked.manifest, read: async (name, offset, length) => {
    const handle = fs.openSync(path.join(folder, name), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const count = fs.readSync(handle, buffer, 0, length, offset);
      return buffer.subarray(0, count);
    } finally { fs.closeSync(handle); }
  } });
  const { url, headers } = await feed.listen();
  const { NsisUpdater } = require('electron-updater');
  const logs = [];
  const adapter = {
    version: currentVersion, name: 'agentdesk-ui', isPackaged: true,
    appUpdateConfigPath: path.join(resources, 'app-update.yml'),
    userDataPath: path.join(os.tmpdir(), 'agentdesk-update-smoke'),
    baseCachePath: process.env.LOCALAPPDATA,
    whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {},
  };
  const updater = new NsisUpdater({ provider: 'generic', url, useMultipleRangeRequest: false }, adapter);
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.requestHeaders = headers;
  updater.logger = { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)), debug() {} };
  const result = await updater.checkForUpdates();
  if (result?.updateInfo?.version !== version) throw new Error('feed version mismatch');
  await updater.downloadUpdate();
  const fromServer = feed.stats.perFile[installer] || 0;
  console.log(JSON.stringify({
    environment: 'github-actions-windows-runner',
    from: currentVersion, to: version, installerSize: checked.manifest.installer.size,
    installerBytesThroughFeed: fromServer, rangeRequests: feed.stats.rangeRequests,
    differential: feed.stats.rangeRequests > 0 && fromServer < checked.manifest.installer.size,
    updaterLines: logs.filter((line) => /Full:|fallback|differential|blockmap|cached/i.test(line)).map((line) => line.replace(/https?:\/\/\S+/g, '<feed>')).slice(0, 12),
  }));
  await feed.close();
}

app.whenReady().then(main).then(() => app.exit(0), (error) => { console.error('smoke failed:', error.message); app.exit(1); });
