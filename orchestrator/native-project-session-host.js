const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { NativeChannel, VERSION, NATIVE_PROVIDERS } = require('./native-channel');
const { mountProject } = require('./project-mount');
const { sandboxCommand } = require('./sandbox');

const HOST_STATE = '/var/lib/agentdesk-orchestrator';
const profileNames = { claude: 'claude', grok: 'grok-chat', antigravity: 'antigravity' };
const billingOverrides = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
  'GROK_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

async function serveNativeProject({ provider, mode, sessionKey, historyRoot = HOST_STATE, input = process.stdin, output = process.stdout }) {
  if (!NATIVE_PROVIDERS.includes(provider) || !['write', 'read'].includes(mode) ||
      process.getuid?.() !== 0 ||
      await fs.readlink('/proc/self/ns/mnt') === await fs.readlink('/proc/1/ns/mnt')) throw new Error('native_session_requires_private_namespace');
  const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
  if (mountInfo.split('\n').some((line) => line.split(' - ')[0].split(' ').some((tag) => tag.startsWith('shared:')))) {
    throw new Error('native_session_requires_private_namespace');
  }
  if (sessionKey !== undefined && !/^[a-f0-9]{64}$/.test(sessionKey)) throw new Error('invalid_native_session_key');
  if (historyRoot !== HOST_STATE && (historyRoot !== __dirname || !/^\/var\/tmp\/agentdesk-seat-code-[a-z0-9]+$/i.test(historyRoot))) {
    throw new Error('invalid_native_history_root');
  }
  const stateDir = await fs.mkdtemp('/var/tmp/agentdesk-native-seat-');
  const pipe = new NativeChannel(input, output);
  const sftpIn = new PassThrough();
  const sftpOut = new PassThrough();
  const stop = new AbortController();
  let child;
  let mounted;
  const abort = () => stop.abort(new Error('native_channel_closed'));
  const send = (type, data) => {
    try { pipe.send(type, data); } catch { abort(); }
  };
  pipe.on('failure', abort);
  pipe.on('end', abort);
  pipe.on('s', (data) => {
    if (sftpIn.writableLength + data.length > 8 * 1024 * 1024) abort();
    else if (!stop.signal.aborted) sftpIn.write(data);
  });
  pipe.on('p', (data) => {
    if (!child || child.stdin.writableLength + data.length > 8 * 1024 * 1024) abort();
    else if (!stop.signal.aborted) child.stdin.write(data);
  });
  sftpOut.on('data', (data) => send('s', data));
  try {
    let account;
    let profile;
    if (provider !== 'codex') {
      profile = path.join(HOST_STATE, 'homes', profileNames[provider]);
      const { uid, gid } = await fs.stat(profile);
      if (!uid || !gid) throw new Error('native_provider_profile_requires_service_account');
      account = { uid, gid };
      await fs.chown(stateDir, uid, gid);
    }
    mounted = await mountProject({ stateDir, input: sftpIn, output: sftpOut, account, readOnly: mode === 'read', signal: stop.signal });
    let providerState = path.join(stateDir, 'provider-state');
    if (provider !== 'codex' && sessionKey) {
      const persistent = path.join(historyRoot, 'windows-native-chat');
      await fs.mkdir(persistent, { recursive: true, mode: 0o700 });
      await fs.chown(persistent, 0, account.gid);
      await fs.chmod(persistent, 0o710);
      providerState = path.join(persistent, sessionKey);
      await fs.mkdir(providerState, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await fs.lstat(providerState)).isDirectory()) throw new Error('invalid_native_provider_state');
      await fs.chown(providerState, account.uid, account.gid);
    }
    // The host also pumps SFTP. A synchronous stat/realpath/chdir into its own mount would
    // wait for this event loop to deliver the reply. Only the child may resolve the mount.
    const cwd = stateDir;
    const command = provider === 'codex' ? 'codex' : '/usr/bin/setpriv';
    const args = provider === 'codex' ? ['app-server'] :
      ['--reuid', String(account.uid), '--regid', String(account.gid), '--clear-groups', '--',
        process.execPath, path.join(__dirname, 'chat-server.js'), provider];
    const env = provider === 'codex' ? { ...process.env } : {
      ...process.env, HOME: profile, [`AGENTDESK_CHAT_HOME_${provider.toUpperCase()}`]: profile,
      AGENTDESK_CHAT_STATE: providerState, AGENTDESK_CHAT_SANDBOX: '/usr/bin/bwrap',
      AGENTDESK_NATIVE_PROJECT: mounted.directory, AGENTDESK_NATIVE_RUNTIME: stateDir,
    };
    for (const key of billingOverrides) delete env[key];
    let launch = { command, args };
    if (provider === 'codex') {
      const home = await fs.realpath(env.CODEX_HOME || path.join(env.HOME || '/root', '.codex'));
      if (path.basename(home) !== '.codex' || !(await fs.stat(home)).isDirectory()) {
        throw new Error('native_codex_profile_unavailable');
      }
      env.CODEX_HOME = home;
      launch = sandboxCommand(command, args, {
        cwd, writable: true, hide: [HOST_STATE], extraWritable: [home],
      });
      launch.args.splice(launch.args.indexOf('--chdir'), 0,
        mode === 'write' ? '--bind' : '--ro-bind', mounted.directory, mounted.directory);
    }
    child = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', abort);
    child.stdout.on('data', (data) => send('p', data));
    await once(child, 'spawn');
    send('c', JSON.stringify({ protocolVersion: VERSION, state: 'ready', mountPath: mounted.directory }));
    const exited = once(child, 'exit');
    stop.signal.addEventListener('abort', () => child.kill(), { once: true });
    mounted.signal.addEventListener('abort', abort, { once: true });
    if (stop.signal.aborted || mounted.signal.aborted) child.kill();
    const [code] = await exited;
    if (!stop.signal.aborted && code) throw new Error('native_provider_exited');
  } catch (error) {
    send('c', JSON.stringify({ protocolVersion: VERSION, state: 'failed', code: error.message.split(':')[0] }));
    throw error;
  } finally {
    child?.kill();
    await mounted?.close();
    // The only writable mount has already been detached. Retain the official CLI profiles outside stateDir.
    await fs.rm(stateDir, { recursive: true, force: true });
    input.destroy();
  }
}

if (require.main === module) {
  serveNativeProject({ provider: process.argv[2], mode: process.argv[3], sessionKey: process.argv[4], historyRoot: process.argv[5] })
    .catch(() => { process.exitCode = 1; });
}

module.exports = { serveNativeProject };
