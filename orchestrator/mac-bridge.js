const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { Desktop } = require('../desktop');
const { request } = require('./mcp');
const { startBridge } = require('./service');

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const desktop = config.desktopSocket ? {
  enabled: true,
  active: new Map(),
  specs: async () => [],
  call: (params) => request(config.desktopSocket, params, 45000, 28 * 1024 * 1024),
  stop: () => {},
} : new Desktop(config.desktopExecutable);
if (!config.desktopSocket) desktop.enabled = Boolean(config.desktopExecutable);
if (desktop.enabled && !config.desktopSocket) {
  execFile(config.desktopExecutable, ['permissions'], { timeout: 10000 }, (error, output) => {
    if (error) {
      console.error('macOS desktop permission check:', error.code || error.message);
      return;
    }
    try {
      const { accessibility, screen_recording } = JSON.parse(output).data;
      console.log('macOS desktop permissions:', accessibility.state, screen_recording.state);
    } catch {
      console.error('macOS desktop permission check: invalid_response');
    }
  });
}
const stop = startBridge({
  config,
  desktop,
  recycle: async (target) => {
    const trash = path.join(config.stateDir, 'trash');
    await fs.mkdir(trash, { recursive: true, mode: 0o700 });
    await fs.rename(target, path.join(trash, randomUUID() + '-' + path.basename(target)));
  },
  spawnSsh: ({ host, port = 22, user, key, knownHosts }) => spawn('/usr/bin/ssh', [
    '-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + JSON.stringify(knownHosts), '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no', '-i', key, '-p', String(port), '--', user + '@' + host,
  ], { stdio: ['pipe', 'pipe', 'pipe'] }),
});

function shutdown() {
  stop();
  desktop.stop();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
