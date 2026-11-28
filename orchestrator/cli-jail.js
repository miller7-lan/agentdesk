// The sandbox of native CLI single chats (0.5.0). A person's device must not be able to change, or even look at,
// anything on VPS2 through its CLI, so unlike the group-chat sandbox (sandbox.js: the whole system read-only, the
// network shared) this one starts from nothing and lets in only what running the CLIs needs:
//
// - programs: /usr (with /usr/local reduced to the two CLIs installed there) and the Node runtime in /opt;
// - /etc: only the files programs read to work (certificates, the dynamic linker, time zone…); passwd, group,
//   hosts, hostname and resolv.conf are written for the sandbox and name nobody else;
// - home: this device's own home for this CLI (cli-chats/<device>/home/<provider>). Of the shared login home only
//   the login token file itself is bound in (one file, rewritten in place by the CLI, so a refresh reaches every
//   chat); settings are copied once when the home is made, history never;
// - /work/<project>: this device's project folder, writable unless read-only;
// - fresh /tmp, /var, /run, /dev and /proc; own PID, IPC, UTS, user and network namespaces.
// Nothing else: no /root, /home, /srv, /var/lib, /var/log, other devices' folders, AgentDesk's state or code.
//
// Network: the sandbox has its own network namespace, connected to the internet by slirp4netns (user-mode NAT,
// started by cli-net.py) running with group agentdesk-cli. /etc/agentdesk-cli-net.nft rejects that group's
// connections to VPS2 itself and to private networks (only DNS through the local resolver passes), so the CLI
// reaches model APIs, search and package registries but no service on VPS2, by loopback or by its public address.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NODE_RUNTIME = '/opt/agentdesk-node24';
const LOCAL_PROGRAMS = ['/usr/local/bin/grok', '/usr/local/bin/agy'];
// Read by ordinary programs to work; nothing in here is VPS2's configuration of its own services.
const ETC = ['ssl', 'ca-certificates', 'ca-certificates.conf', 'alternatives', 'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d',
  'nsswitch.conf', 'localtime', 'timezone', 'mime.types', 'protocols', 'services', 'gai.conf', 'host.conf', 'os-release',
  'lsb-release', 'debian_version', 'bash.bashrc', 'inputrc', 'terminfo', 'python3', 'python3.12', 'vim', 'gitattributes',
  'magic', 'magic.mime', 'environment'];
const NET_HELPER = path.join(__dirname, 'cli-net.py');
const HOSTNAME = 'vps2';

// What of the shared login home a device's home gets. share: bound in, read-write (the login itself); seed: copied
// once into a new home (settings and program files, never history); seedJson: a copy with some fields left out.
const HOMES = {
  claude: { shared: 'claude', share: ['.claude/.credentials.json'], seed: ['.claude/settings.json'],
    seedJson: { '.claude.json': ['projects', 'tipsHistory', 'pluginUsage', 'clientDataCacheSlots', 'cachedArtifactRoster'] } },
  codex: { shared: 'codex', share: ['.codex/auth.json'], seed: ['.codex/config.toml'] },
  // Grok's login is copied each time it starts (it does not need to write it back).
  grok: { shared: 'grok', copy: ['.grok/auth.json'], seed: [] },
  antigravity: { shared: 'antigravity',
    share: ['.gemini/antigravity-cli/antigravity-oauth-token', '.gemini/oauth_creds.json', '.config/antigravity/credential-user-scope'],
    seed: ['.gemini/antigravity-cli/bin', '.gemini/antigravity-cli/builtin', '.gemini/antigravity-cli/installation_id',
      '.gemini/antigravity-cli/settings.json', '.gemini/antigravity-cli/jetski_state.pbtxt', '.gemini/antigravity-cli/last_check.timestamp',
      '.gemini/google_accounts.json', '.gemini/installation_id', '.gemini/settings.json', '.gemini/config/config.json'] },
};
const SEEDED = '.agentdesk-seeded';

const exists = (target) => { try { fs.statSync(target); return true; } catch { return false; } };

// Makes (once) and fills a device's home for one CLI; returns the [source, target-in-home] login binds.
function prepareHome(provider, home, sharedRoot) {
  const spec = HOMES[provider];
  if (!spec) throw new Error('cli_provider_invalid');
  const shared = path.join(sharedRoot, spec.shared);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Two chats opening a new home at once: one fills it (holding the lock folder), the other waits for it.
  const lock = path.join(home, '.agentdesk-seeding');
  let owner = false;
  for (const until = Date.now() + 15_000; !exists(path.join(home, SEEDED)) && Date.now() < until;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); owner = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A lock left by a seeding that died is taken over after a minute.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  if (owner && !exists(path.join(home, SEEDED))) {
    for (const item of spec.seed) {
      const source = path.join(shared, item);
      if (!exists(source)) continue;
      fs.mkdirSync(path.dirname(path.join(home, item)), { recursive: true, mode: 0o700 });
      fs.cpSync(source, path.join(home, item), { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true,
        verbatimSymlinks: true });
    }
    for (const [item, drop] of Object.entries(spec.seedJson || {})) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(shared, item), 'utf8'));
        for (const key of drop) delete value[key];
        fs.writeFileSync(path.join(home, item), JSON.stringify(value, null, 2), { mode: 0o600 });
      } catch {}
    }
    fs.writeFileSync(path.join(home, SEEDED), new Date().toISOString() + '\n', { mode: 0o600 });
  }
  if (owner) fs.rmSync(lock, { recursive: true, force: true });
  for (const item of spec.copy || []) {
    const source = path.join(shared, item);
    const target = path.join(home, item);
    if (!exists(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  }
  const binds = [];
  for (const item of spec.share || []) {
    const source = path.join(shared, item);
    if (!exists(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(home, item);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // The bind needs a file to mount over; the CLI then reads and refreshes the shared login through it.
    if (!exists(target)) fs.writeFileSync(target, '', { mode: 0o600 });
    binds.push([fs.realpathSync(source), item]);
  }
  return binds;
}

// The few /etc files that would otherwise name VPS2's users, hosts or resolver, written for the sandbox.
function writeIdentity(runtime, { uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000, home = '/home/agentdesk' } = {}) {
  const folder = path.join(runtime, 'etc');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const files = {
    passwd: `root:x:0:0:root:/root:/usr/sbin/nologin\nagentdesk:x:${uid}:${gid}:AgentDesk:${home}:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
    group: `root:x:0:\nagentdesk:x:${gid}:\nnogroup:x:65534:\n`,
    hosts: `127.0.0.1 localhost\n127.0.1.1 ${HOSTNAME}\n::1 localhost\n`,
    hostname: HOSTNAME + '\n',
    // slirp4netns's DNS forwarder.
    'resolv.conf': 'nameserver 10.0.2.3\noptions edns0\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text, { mode: 0o644 });
  return Object.keys(files).map((name) => [path.join(folder, name), '/etc/' + name]);
}

// bwrap arguments. home: the device's home (shown as /home/agentdesk); workspace/cwd: the project folder and where
// it appears; logins: [source, relative path in home]; extra: [[source, target]] read-write binds (e.g. sockets).
// computer: { folder, platform } — the person's whole computer mounted there (agentdesk-cli.js `mount computer`), at
// /pc, and its own paths linked to it (Mac /Users, /Volumes; Windows drives /c, /d, …); workspace is then null.
function jailArgs({ runtime, home, workspace, computer = null, cwd, writable = true, logins = [], extra = [], readOnly = [], readRoot = () => fs.readdirSync('/', { withFileTypes: true }) }) {
  const HOME = '/home/agentdesk';
  const argv = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--unshare-cgroup-try',
    '--hostname', HOSTNAME, '--die-with-parent', '--ro-bind', '/usr', '/usr'];
  // bin -> usr/bin and the like, as on the host.
  for (const entry of readRoot()) {
    if (entry.isSymbolicLink() && ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'].includes(entry.name)) {
      try { argv.push('--symlink', fs.readlinkSync('/' + entry.name), '/' + entry.name); } catch {}
    }
  }
  argv.push('--tmpfs', '/usr/local', '--dir', '/usr/local/bin');
  for (const program of LOCAL_PROGRAMS) if (exists(program)) argv.push('--ro-bind', fs.realpathSync(program), program);
  if (exists(NODE_RUNTIME)) argv.push('--ro-bind', NODE_RUNTIME, NODE_RUNTIME);
  argv.push('--tmpfs', '/etc');
  for (const name of ETC) if (exists('/etc/' + name)) argv.push('--ro-bind', '/etc/' + name, '/etc/' + name);
  for (const [source, target] of writeIdentity(runtime, { home: HOME })) argv.push('--ro-bind', source, target);
  argv.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var', '--dir', '/var/tmp', '--tmpfs', '/run',
    '--tmpfs', '/home', '--bind', fs.realpathSync(home), HOME);
  for (const [source, item] of logins) argv.push('--bind', source, path.posix.join(HOME, item));
  for (const [source, target] of extra) if (exists(source)) argv.push('--bind', fs.realpathSync(source), target);
  for (const [source, target] of readOnly) if (exists(source)) argv.push('--ro-bind', fs.realpathSync(source), target);
  if (computer) {
    argv.push(writable ? '--bind' : '--ro-bind', computer.folder, '/pc');
    // Links, not binds: they lead into the mount whenever it is there, also after the computer reconnects.
    const links = computer.platform === 'darwin' ? [['/pc/Users', '/Users'], ['/pc/Volumes', '/Volumes']]
      : [...'abcdefghijklmnopqrstuvwxyz'].map((letter) => [`/pc/${letter.toUpperCase()}:`, '/' + letter]);
    for (const [target, link] of links) argv.push('--symlink', target, link);
  } else {
    argv.push(writable ? '--bind' : '--ro-bind', fs.realpathSync(workspace), cwd);
  }
  argv.push('--remount-ro', '/', '--chdir', cwd);
  return argv;
}

// Starts bwrap with the CLI and connects its network namespace (slirp4netns) before the CLI runs: bwrap holds the
// command back (--block-fd) until the network is up or 10 seconds have passed. stdio is the caller's (the terminal).
function launch(command, args, { jail, env, onNote = () => {}, bwrap = '/usr/bin/bwrap', helper = NET_HELPER }) {
  const child = spawn(bwrap, ['--info-fd', '3', '--block-fd', '4', ...jail, '--', command, ...args],
    { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'], env, cwd: '/' });
  let info = '';
  let released = false;
  let net = null;
  const release = () => { if (released) return; released = true; try { child.stdio[4].end('1'); } catch {} };
  const timer = setTimeout(() => { onNote('network_timeout'); release(); }, 10_000);
  child.stdio[3].on('data', (chunk) => {
    info += chunk;
    const match = info.match(/"child-pid":\s*(\d+)/);
    if (!match || net) return;
    // fd 3: slirp4netns says it is ready; fd 4: it ends when this end closes (this process exits, even if killed).
    net = spawn('/usr/bin/python3', ['-I', helper, match[1]], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let errors = '';
    net.stderr.on('data', (text) => { errors = (errors + text).slice(-500); });
    net.stdio[3].once('data', () => { clearTimeout(timer); release(); });
    net.on('exit', (code) => { if (!released) { clearTimeout(timer); onNote('network_failed ' + code + ' ' + errors.trim()); release(); } });
  });
  child.stdio[3].on('error', () => {});
  child.stdio[4].on('error', () => {});
  child.on('exit', () => { clearTimeout(timer); try { net?.kill(); } catch {} });
  return child;
}

module.exports = { jailArgs, launch, prepareHome, writeIdentity, HOMES, ETC, HOSTNAME };
