// VPS2: mounts each Bridge's home folder read-only with sshfs, from the SFTP stream the Bridge serves over a second
// SSH session (the gateway sends the word "agentdesk-mount" to this service's socket). It runs as its own systemd
// unit (agentdesk-home-mount.service): mounting needs the setuid fusermount3, which the orchestrator's unit
// forbids (NoNewPrivileges). The orchestrator sees the mounts through the shared mount table (scheduler.mountFor).
//
// Mount points: <stateDir>/mounts/<bridge> ("default" for the unnamed Bridge). Socket: <stateDir>/bridge[-<name>]-mount.sock.
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

function mountTable() {
  try { return fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').map((line) => line.split(' ')[1]).filter(Boolean); } catch { return []; }
}

function serveMounts(config, { log = console.error, spawnProcess = spawn, listen = createServer } = {}) {
  const settings = config.homeMounts === true ? {} : config.homeMounts || {};
  const sshfs = settings.sshfs || '/usr/bin/sshfs';
  const fusermount = settings.fusermount || '/usr/bin/fusermount3';
  const servers = [];
  for (const name of ['', ...(config.sshBridges || [])]) {
    const key = name || 'default';
    const mountpoint = path.join(config.stateDir, 'mounts', key);
    const unmount = () => { try { spawnSync(fusermount, ['-u', '-z', mountpoint], { stdio: 'ignore', timeout: 10000 }); } catch {} };
    const socketPath = path.join(config.stateDir, (name ? 'bridge-' + name : 'bridge') + '-mount.sock');
    try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch {}
    let current = null;
    const server = listen((socket) => {
      current?.kill();
      unmount();
      fs.mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
      // passive: SFTP over this process's stdin/stdout; ro: nothing written back; dir_cache keeps listings 5 s.
      const child = current = spawnProcess(sshfs,
        ['-f', '-o', 'passive,ro,idmap=user,dir_cache=yes,dcache_timeout=5', ':/', mountpoint], { stdio: ['pipe', 'pipe', 'pipe'] });
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      child.stderr?.setEncoding('utf8').on('data', (chunk) => log('home mount ' + key + ':', chunk.trim().slice(0, 300)));
      child.stdin.on('error', () => {});
      socket.on('error', () => child.kill());
      log('home mount ' + key + ': Bridge connected');
      const done = () => {
        if (current !== child) return;
        current = null;
        child.kill();
        socket.destroy();
        unmount();
        log('home mount ' + key + ': Bridge disconnected');
      };
      child.once('exit', done);
      socket.once('close', done);
    }).listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
    servers.push({ server, unmount });
  }
  return () => { for (const { server, unmount } of servers) { server.close(); unmount(); } };
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const stop = serveMounts(config);
  process.once('SIGTERM', () => { stop(); process.exit(0); });
}

module.exports = { serveMounts, mountTable };
