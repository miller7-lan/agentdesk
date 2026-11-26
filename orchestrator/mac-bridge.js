const { execFile } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { Desktop } = require('../desktop');
const { request } = require('./mcp');
const { startBridge } = require('./service');
const { normalizeJump } = require('./ssh-options');
const { probeTcpBanner, routeFor } = require('./ssh-route');
const { createBridgeSsh } = require('./bridge-ssh');

function main(argv = process.argv) {
  const config = JSON.parse(readFileSync(argv[2], 'utf8'));
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

  let route;
  if (config.ssh) {
    config.ssh.jump = normalizeJump(config.ssh.jump, { checkFiles: true });
    route = routeFor(config.ssh.jump, { host: config.ssh.host, port: config.ssh.port || 22 });
    if (config.ssh.host) route.setProbe(() => probeTcpBanner(config.ssh.host, config.ssh.port || 22));
  }
  const stop = startBridge({
    config,
    desktop,
    recycle: async (target) => {
      const trash = path.join(config.stateDir, 'trash');
      await fs.mkdir(trash, { recursive: true, mode: 0o700 });
      await fs.rename(target, path.join(trash, randomUUID() + '-' + path.basename(target)));
    },
    spawnSsh: createBridgeSsh({ route }),
  });

  function shutdown() {
    stop();
    desktop.stop();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { stop, shutdown, route };
}

if (require.main === module) main();

module.exports = { createSpawnSsh: createBridgeSsh, main };
