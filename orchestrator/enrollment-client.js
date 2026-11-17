const https = require('node:https');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');

const execute = promisify(execFile);
const win = process.platform === 'win32';
const bundledKeygen = process.resourcesPath && path.join(process.resourcesPath, 'desktop-backend', 'openssh', 'ssh-keygen.exe');
const sshKeygen = win
  ? bundledKeygen && existsSync(bundledKeygen) ? bundledKeygen
    : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
  : '/usr/bin/ssh-keygen';

async function identity(directory, name) {
  const filename = path.join(directory, name);
  try { await fs.access(filename); }
  catch {
    await execute(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'agentdesk', '-f', filename], { timeout: 5000, windowsHide: true });
  }
  const { stdout } = await execute(sshKeygen, ['-y', '-f', filename], { timeout: 5000, windowsHide: true });
  return { filename, key: stdout.trim().split(/\s+/).slice(0, 2).join(' ') };
}

function signIn(bootstrap, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = https.request(new URL('/v1/enroll', bootstrap.url), {
      method: 'POST', ca: bootstrap.ca, timeout: 18000, minVersion: 'TLSv1.2',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy(new Error('invalid_login_response'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks));
          if (response.statusCode === 200) resolve(value);
          else reject(new Error(value.error || 'enrollment_failed'));
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('login_timeout')));
    request.on('error', reject);
    request.end(data);
  });
}

async function prepareWorkspace(directory, bundle, workspace) {
  try { await fs.lstat(workspace); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const seed = path.join(directory, 'workspace.bundle');
  await fs.writeFile(seed, Buffer.from(bundle, 'base64'), { mode: 0o600 });
  try {
    if (process.platform === 'darwin') await execute('/usr/bin/xcode-select', ['-p'], { timeout: 3000 });
    await execute('git', ['clone', '--no-hardlinks', '--', seed, workspace], { timeout: 12000, windowsHide: true });
    await execute('git', ['-C', workspace, 'remote', 'remove', 'origin'], { timeout: 5000, windowsHide: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && !String(error.stderr || '').includes('xcode-select')) throw error;
    await fs.mkdir(workspace);
  }
}

async function createSession(bootstrap, password, workspace) {
  const identities = path.join(os.homedir(), '.agentdesk', 'enrollment');
  await fs.mkdir(identities, { recursive: true, mode: 0o700 });
  const [bridge, chat] = await Promise.all([identity(identities, 'bridge_ed25519'), identity(identities, 'chat_ed25519')]);
  const installationFile = path.join(identities, 'installation');
  await fs.writeFile(installationFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 })
    .catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const installation = await fs.readFile(installationFile, 'utf8');
  const answer = await signIn(bootstrap, { password, installation, bridgeKey: bridge.key, chatKey: chat.key });
  const { id, expires, bridgeCert, chatCert, bridgeToken, bundle } = answer;
  if (!/^d[0-9a-f]{14}$/.test(id) || !Number.isSafeInteger(expires) || expires * 1000 <= Date.now() ||
      typeof bridgeCert !== 'string' || typeof chatCert !== 'string' || typeof bundle !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(bridgeToken)) throw new Error('invalid_login_response');
  // The short path also fits the macOS Unix socket limit.
  const folder = await fs.mkdtemp(path.join(win ? os.tmpdir() : '/tmp', 'ad-session-'));
  const temp = (name) => path.join(folder, name);
  const controlSocket = win ? '\\\\.\\pipe\\agentdesk-' + path.basename(folder) : temp('control.sock');
  const write = (name, data) => fs.writeFile(temp(name), data, { mode: 0o600 });
  try {
    await Promise.all([
      write('bridge-cert.pub', bridgeCert), write('chat-cert.pub', chatCert),
      write('relay.token', bridgeToken), write('relay-ca.pem', bootstrap.relayCA),
      write('known_hosts', bootstrap.knownHosts),
    ]);
    await prepareWorkspace(folder, bundle, workspace);
    return {
      expires,
      controlSocket,
      remote: { host: bootstrap.host, port: 22, codexUser: 'agentdesk', codexKey: chat.filename,
        codexCertificate: temp('chat-cert.pub'), knownHosts: temp('known_hosts'),
        remoteForward: '', manageSshd: false, workspace: '/var/lib/agentdesk-orchestrator/desktop-workspace' },
      bridge: {
        stateDir: path.join(identities, 'bridge-state'), controlSocket, controlWorkspace: id,
        workspaces: { [id]: { root: workspace, desktop: true, write: true, commands: { 'git-status': ['git', 'status', '--short'] } } },
        ssh: { host: bootstrap.host, port: 22, user: 'agentdesk', key: bridge.filename,
          certificate: temp('bridge-cert.pub'), knownHosts: temp('known_hosts') },
        relay: { host: bootstrap.relayHost, port: 22022, deviceId: id,
          tokenFile: temp('relay.token'), caFile: temp('relay-ca.pem') },
      },
      close: () => fs.rm(folder, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createSession, signIn };
