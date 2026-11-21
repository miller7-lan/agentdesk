const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
const { createLocalShell, macSandboxProfile, shellSpecFor } = require('../orchestrator/windows-local-shell');
const { serveWorker, connectWorker, createSecret } = require('../orchestrator/windows-chat-worker');

// The Mac native single chat: the same worker, leases and local_shell as on Windows, with a POSIX shell. These run
// on Linux CI too (bash, no sandbox); on a Mac the commands also go through sandbox-exec.
const posix = process.platform !== 'win32';

test('on a Mac local_shell runs a login shell in the project, keeps its results and respects the project lease', { skip: !posix, timeout: 30_000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-mac-shell-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const leases = new WindowsProjectLeases();
  const identity = { device: 'mac', provider: 'codex', threadId: 'one', root, fullAccess: true };
  const binding = { ...identity, ...await leases.acquire(identity) };
  const shell = createLocalShell({ leases, journal: () => path.join(temp, 'runs.json'), stateDir: temp });
  const run = (command, args = {}, requestId = command) => shell.call(binding, { action: 'run', shell: 'bash', command, ...args }, { requestId });
  const where = await run('echo "$FIXTURE $(basename "$PWD")"; exit 3', { env: { FIXTURE: 'ok' } });
  assert.equal(where.state, 'failed');                // a non-zero exit, reported with its real code
  assert.equal(where.stdout.trim(), 'ok project');
  assert.equal(where.exitCode, 3);
  assert.equal((await run('echo once >> attempt.txt', {}, 'same')).runId, (await run('echo once >> attempt.txt', {}, 'same')).runId);
  assert.equal(await fs.readFile(path.join(root, 'attempt.txt'), 'utf8'), 'once\n');   // the same request runs once
  const long = await run('sleep 5; echo late', { background: true }, 'long');
  assert.equal(long.state, 'running');
  const stopped = await shell.call(binding, { action: 'stop', runId: long.runId }, { requestId: 'stop' });
  assert.ok(['cancelling', 'cancelled'].includes(stopped.state));
  // A read-only lease cannot run commands.
  const reader = { ...identity, threadId: 'two', fullAccess: false };
  const readOnly = { ...reader, ...await leases.acquire(reader) };
  await assert.rejects(shell.call(readOnly, { action: 'run', shell: 'bash', command: 'true' }, { requestId: 'r' }), /native_chat_read_only/);
});

test('on a Mac the commands have the person\'s own access; only AgentDesk\'s own secrets stay closed', () => {
  const profile = macSandboxProfile({ home: '/Users/me', extra: ['/opt/bridge-state'] });
  for (const folder of ['/Users/me/.agentdesk', '/Users/me/Library/Application Support/AgentDesk', '/opt/bridge-state']) {
    assert.ok(profile.includes('(subpath "' + folder + '")'), folder);
  }
  for (const folder of ['/Users/me/.ssh', '/Users/me/.aws', '/Users/me/.npmrc', '/Users/me/Library/Keychains']) {
    assert.ok(!profile.includes(folder), folder + ' is open, so git push, npm and cloud CLIs work');
  }
  assert.doesNotMatch(profile, /SecurityServer/);                     // the keychain is reachable
  const strict = macSandboxProfile({ home: '/Users/me', strict: true });   // still available when wanted
  assert.ok(strict.includes('(subpath "/Users/me/.ssh")'));
  assert.match(strict, /SecurityServer/);
  assert.equal(shellSpecFor('darwin').inputSchema.properties.shell.enum.join(), 'zsh,bash');
  assert.equal(shellSpecFor('win32').inputSchema.properties.shell.enum.join(), 'powershell,cmd');
});

test('the native chat worker serves a Mac over a Unix socket guarded by its key', { skip: !posix, timeout: 30_000 }, async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-mac-worker-'));
  const root = path.join(state, 'project');
  await fs.mkdir(root);
  const secret = createSecret(state);
  const server = serveWorker(state);
  t.after(async () => { server.close(); await fs.rm(state, { recursive: true, force: true }); });
  await new Promise((resolve) => server.once('listening', resolve));
  await assert.rejects(connectWorker(state, Buffer.alloc(32, 7)), /disconnected|auth/);   // a wrong key is refused
  const worker = await connectWorker(state, secret);
  t.after(() => worker.close());
  const identity = { device: 'mac', provider: 'claude', threadId: 'pending-1', root, fullAccess: true };
  const binding = { ...identity, ...await worker.request('acquire', { binding: identity }) };
  const result = await worker.request('shell', { binding, args: { action: 'run', shell: 'bash', command: 'pwd' }, requestId: 'pwd' });
  assert.equal(await fs.realpath(result.stdout.trim()), await fs.realpath(root));
  const listed = await worker.request('shell', { binding, args: { action: 'list' } });
  assert.equal(listed.runs.length, 1);
});
