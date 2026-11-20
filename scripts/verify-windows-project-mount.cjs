const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Remote } = require('../remote');
const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
const { createWindowsLocalShell } = require('../orchestrator/windows-local-shell');
const { makeProtocol } = require('../orchestrator/windows-native-protocol');

const sandboxOnly = process.argv.includes('--codex-sandbox');
const official = process.argv.includes('--claude') ? 'claude' : process.argv.includes('--codex') || sandboxOnly ? 'codex' : null;
const remote = new Remote(official ? { timing: { heartbeat: 240_000 } } : {});
const deadline = setTimeout(() => process.exit(2), official ? 235_000 : 110_000);
remote.once('codex-ready', async () => {
  let directory;
  let state;
  let channel;
  let transport;
  const processId = randomUUID();
  const command = async (command, cwd = '/tmp', timeoutMs = 35_000) => {
    const reply = await remote.request('command/exec', {
      command, cwd, timeoutMs, sandboxPolicy: { type: 'dangerFullAccess' },
    }, { timeoutMs: timeoutMs + 5000 });
    if (reply.exitCode !== 0) throw new Error(`VPS fixture ${path.basename(command[0])} exited ${reply.exitCode}: ${reply.stderr || reply.stdout || 'no output'}`);
    return reply.stdout;
  };
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-mount-live-'));
    await fs.writeFile(path.join(directory, 'readme.txt'), 'Windows 原文\n');
    state = (await command(['mktemp', '-d', '/var/tmp/ad-project-mount-live-XXXXXX'])).trim();
    if (!/^\/var\/tmp\/ad-project-mount-live-[A-Za-z0-9]+$/.test(state)) throw new Error('Unexpected fixture directory');
    const source = await fs.readFile(path.join(__dirname, '..', 'orchestrator', 'project-mount.js'));
    await command(['/opt/agentdesk-orchestrator/node', '-e',
      'require("fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"), {mode: 0o600})',
      state + '/project-mount.cjs', source.toString('base64')]);
    const received = new PassThrough();
    const sent = new PassThrough();
    const leases = new WindowsProjectLeases();
    const identity = { device: 'fixture-device', provider: official || 'codex', threadId: processId, projectId: 'native-fixture',
      root: directory, fullAccess: true };
    const binding = { ...identity, ...await leases.acquire(identity) };
    channel = leases.serveSftp(binding, received, sent);
    let markMount;
    let rejectMount;
    const mounted = new Promise((resolve, reject) => { markMount = resolve; rejectMount = reject; });
    let diagnostics = '';
    let outgoing = Promise.resolve();
    remote.on('notification', ({ method, params }) => {
      if (method !== 'command/exec/outputDelta' || params?.processId !== processId) return;
      if (params.capReached) { rejectMount(new Error('Fixture SFTP transport output was truncated')); return; }
      const bytes = Buffer.from(params.deltaBase64, 'base64');
      if (params.stream === 'stdout') received.write(bytes);
      else {
        diagnostics += bytes.toString();
        const marker = /^MOUNT ([0-9]+) (\/var\/tmp\/ad-project-mount-live-[\w-]+\/windows-chat-mounts\/project-[\w-]+)$/m.exec(diagnostics);
        if (marker) markMount({ namespacePid: marker[1], folder: marker[2] });
      }
    });
    sent.on('data', (chunk) => {
      outgoing = outgoing.then(() => remote.request('command/exec/write', {
        processId, deltaBase64: chunk.toString('base64'),
      }));
      outgoing.catch(rejectMount);
    });
    const mountCode = `
      const { PassThrough } = require('stream');
      const { mountProject } = require(process.argv[1] + '/project-mount.cjs');
      const output = new PassThrough();
      output.pipe(process.stdout, {end:false});
      mountProject({ stateDir: process.argv[1], input: process.stdin, output }).then((mount) => {
        console.error('MOUNT ' + process.pid + ' ' + mount.directory);
        process.once('SIGTERM', () => mount.close().then(() => process.exit(0), () => process.exit(1)));
      }, (error) => { console.error(error.message); process.exitCode=1; });
    `;
    transport = remote.request('command/exec', {
      command: ['unshare', '--mount', '--propagation', 'private', '/opt/agentdesk-orchestrator/node', '-e', mountCode, state],
      cwd: '/tmp', timeoutMs: official ? 200_000 : 80_000,
      streamStdin: true, streamStdoutStderr: true, disableOutputCap: true, processId, sandboxPolicy: { type: 'dangerFullAccess' },
    }, { timeoutMs: official ? 205_000 : 85_000 });
    transport.then(({ exitCode }) => rejectMount(new Error('Mount process closed: ' + exitCode + ' ' + diagnostics)), rejectMount);
    const { namespacePid, folder } = await mounted;
    await command(['sh', '-c', 'test ! -e "$1/readme.txt"', 'fixture', folder]);
    if (sandboxOnly && process.argv.includes('--direct-sandbox')) {
      const started = Date.now();
      const result = await command(['nsenter', '--mount', '--target', namespacePid, '--',
        'codex', 'sandbox', '-P', ':workspace', '-C', folder, '--', 'python3', '-u', '-c',
        'from pathlib import Path; import time; print("child start", time.time()); f=Path("native-sandbox.txt"); f.write_text("codex sandbox"); print(f.read_text(), time.time())'],
      '/tmp', 70_000);
      if (await fs.readFile(path.join(directory, 'native-sandbox.txt'), 'utf8') !== 'codex sandbox') {
        throw new Error('Direct Codex sandbox write not visible on Windows');
      }
      console.log('Native Codex sandbox / SSHFS (' + (Date.now() - started) + ' ms): ' + result.trim());
    }
    if (official && !process.argv.includes('--direct-sandbox')) {
      const claudeEntry = state + '/code/chat-server.js';
      const claudeState = state + '/claude-state';
      if (official === 'claude') {
        const staged = await fs.readFile(path.join(__dirname, '..', 'orchestrator', 'chat-server.js'));
        await command(['/opt/agentdesk-orchestrator/node', '-e', `
          const fs = require('fs'), path = require('path');
          const destination = path.join(process.argv[1], 'code');
          const installed = '/opt/agentdesk-orchestrator';
          fs.mkdirSync(destination);
          for (const name of fs.readdirSync(installed)) {
            if (name !== 'chat-server.js' && name.endsWith('.js')) fs.symlinkSync(path.join(installed, name), path.join(destination, name));
          }
          fs.writeFileSync(path.join(destination, 'chat-server.js'), Buffer.from(process.argv[2], 'base64'), {mode: 0o600});
        `, state, staged.toString('base64')]);
      }
      const { verifyProvider } = require('./native-provider-fixture.cjs');
      const call = makeProtocol({ leases, shell: createWindowsLocalShell({ leases }) });
      const protocol = (request) => call(request, {
        deviceId: identity.device, provider: identity.provider, threadId: identity.threadId, projectId: identity.projectId,
        projectRoot: binding.directory, accessMode: 'write',
      });
      await verifyProvider({ remote, namespacePid, folder, directory, binding, protocol,
        provider: official, sandboxOnly, claudeEntry, claudeState,
        traceFile: process.argv.includes('--trace-sandbox') ? state + '/sandbox.trace' : undefined });
    }
    const result = await command(['nsenter', '--mount', '--target', namespacePid, '--', '/bin/bash', '-c',
      'cd -- "$1"; shift; exec "$@"', 'fixture', folder, 'python3', '-u', '-c', `
from pathlib import Path
source = Path("readme.txt")
assert source.read_text(encoding="utf-8") == "Windows 原文\\n"
Path("test.tmp").write_text("来自 VPS2\\n", encoding="utf-8")
Path("test.tmp").replace(source)
Path("binary.bin").write_bytes(bytes(range(256)) * 640)
assert len(Path("binary.bin").read_bytes()) == 163840
Path("folder").mkdir()
Path("binary.bin").rename("folder/renamed.bin")
print("VPS2 SSHFS read, atomic replacement, binary write, mkdir and rename")
`]);
    if (await fs.readFile(path.join(directory, 'readme.txt'), 'utf8') !== '来自 VPS2\n') throw new Error('Windows contents differ');
    if ((await fs.stat(path.join(directory, 'folder', 'renamed.bin'))).size !== 163840) throw new Error('Windows size differs');
    console.log(result.trim());
    console.log('Windows disk contents verified');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    channel?.close();
    await channel?.done.catch(() => {});
    if (transport) {
      try {
        await remote.request('command/exec/write', { processId, closeStdin: true });
        const finished = await transport;
        if (finished.exitCode !== 0) throw new Error('Mount teardown failed: ' + finished.exitCode);
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    }
    if (state) {
      if (process.argv.includes('--trace-sandbox')) {
        console.log(await command(['bash', '-c',
          'grep -E "mount[(]|unshare[(]|execve[(]|SIGKILL|exited with" "$1/sandbox.trace" | tail -65; rm -f -- "$1/sandbox.trace"', 'fixture', state]).catch(() => 'Trace unavailable'));
      }
      // Only remove our empty mount and fixture directories. No recursive deletion under an unverified mount.
      await command(['bash', '-c', 'rm -f -- "$1/project-mount.cjs"; rm -rf -- "$1/code" "$1/claude-state"; rmdir -- "$1/windows-chat-mounts" "$1"', 'fixture', state])
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    clearTimeout(deadline);
    await remote.stop();
  }
});
remote.startCodex();
