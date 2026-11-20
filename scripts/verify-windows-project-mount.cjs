const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Remote } = require('../remote');
const { createProjectSftp } = require('../orchestrator/sftp-project-write');

const remote = new Remote();
const deadline = setTimeout(() => process.exit(2), 110_000);
remote.once('codex-ready', async () => {
  let directory;
  let state;
  let channel;
  let transport;
  const processId = randomUUID();
  const command = async (command, cwd = '/tmp') => {
    const reply = await remote.request('command/exec', {
      command, cwd, timeoutMs: 35_000, sandboxPolicy: { type: 'dangerFullAccess' },
    }, { timeoutMs: 40_000 });
    if (reply.exitCode !== 0) throw new Error(`VPS fixture ${path.basename(command[0])} exited ${reply.exitCode}: ${reply.stderr || reply.stdout || 'no output'}`);
    return reply.stdout;
  };
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-mount-live-'));
    await fs.writeFile(path.join(directory, 'readme.txt'), 'Windows 原文\n');
    state = (await command(['mktemp', '-d', '/tmp/ad-project-mount-live-XXXXXX'])).trim();
    if (!/^\/tmp\/ad-project-mount-live-[A-Za-z0-9]+$/.test(state)) throw new Error('Unexpected fixture directory');
    const source = await fs.readFile(path.join(__dirname, '..', 'orchestrator', 'project-mount.js'));
    await command(['/opt/agentdesk-orchestrator/node', '-e',
      'require("fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"), {mode: 0o600})',
      state + '/project-mount.cjs', source.toString('base64')]);
    const received = new PassThrough();
    const sent = new PassThrough();
    channel = createProjectSftp({ root: directory })(received, sent);
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
        const directory = /^MOUNT (\/tmp\/ad-project-mount-live-[\w-]+\/windows-chat-mounts\/project-[\w-]+)$/m.exec(diagnostics)?.[1];
        if (directory) markMount(directory);
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
        console.error('MOUNT ' + mount.directory);
        process.once('SIGTERM', () => mount.close().then(() => process.exit(0), () => process.exit(1)));
      }, (error) => { console.error(error.message); process.exitCode=1; });
    `;
    transport = remote.request('command/exec', {
      command: ['/opt/agentdesk-orchestrator/node', '-e', mountCode, state], cwd: '/tmp', timeoutMs: 80_000,
      streamStdin: true, streamStdoutStderr: true, disableOutputCap: true, processId, sandboxPolicy: { type: 'dangerFullAccess' },
    }, { timeoutMs: 85_000 });
    transport.then(({ exitCode }) => rejectMount(new Error('Mount process closed: ' + exitCode + ' ' + diagnostics)), rejectMount);
    const folder = await mounted;
    const result = await command(['python3', '-u', '-c', `
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
`], folder);
    if (await fs.readFile(path.join(directory, 'readme.txt'), 'utf8') !== '来自 VPS2\n') throw new Error('Windows contents differ');
    if ((await fs.stat(path.join(directory, 'folder', 'renamed.bin'))).size !== 163840) throw new Error('Windows size differs');
    console.log(result.trim());
    console.log('Windows disk contents verified');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    channel?.close();
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
      // Only remove our empty mount and fixture directories. No recursive deletion under an unverified mount.
      await command(['bash', '-c', 'rm -f -- "$1/project-mount.cjs"; rmdir -- "$1/windows-chat-mounts" "$1"', 'fixture', state])
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    clearTimeout(deadline);
    await remote.stop();
  }
});
remote.startCodex();
