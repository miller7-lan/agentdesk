const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
const { createWindowsLocalShell } = require('../orchestrator/windows-local-shell');
const { connectWorker, createSecret } = require('../orchestrator/windows-chat-worker');

test('Windows local_shell runs PowerShell and CMD, journals background runs and respects project leases', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-windows-local-shell-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  const other = path.join(temp, 'other');
  await Promise.all([fs.mkdir(root), fs.mkdir(other)]);
  const identity = { device: 'fixture', provider: 'codex', threadId: 'one', root, fullAccess: true };
  const leases = new WindowsProjectLeases();
  const binding = { ...identity, ...await leases.acquire(identity) };
  const journal = () => path.join(temp, 'runs.json');
  const changes = [];
  const shell = createWindowsLocalShell({ leases, journal, notify: (_scope, sample) => changes.push(sample) });
  const call = (args, requestId) => shell.call(binding, args, { requestId });
  const launch = (command, args = {}, requestId = 'sync') => call({ action: 'run', command, ...args }, requestId);
  const codex = await launch('Write-Output ($env:FIXTURE + " " + (Split-Path -Leaf (Get-Location).Path))', { env: { FIXTURE: 'ok' } });
  assert.equal(codex.state, 'completed');
  assert.equal(codex.stdout.trim(), 'ok root');
  const cmd = await launch('echo %FIXTURE% && exit /b 7', { shell: 'cmd', env: { FIXTURE: 'cmd-value' } }, 'cmd');
  assert.equal(cmd.stdout.trim(), 'cmd-value');
  assert.equal(cmd.exitCode, 7);
  const powershell = await launch('Add-Content -LiteralPath attempt.txt -Value once', {}, 'dedup-key');
  assert.equal((await launch('Add-Content -LiteralPath attempt.txt -Value once', {}, 'dedup-key')).runId, powershell.runId);
  assert.match(await fs.readFile(path.join(root, 'attempt.txt'), 'utf8'), /^once\r?\n$/);
  await assert.rejects(launch('Remove-Item -LiteralPath attempt.txt', {}, 'dedup-key'), /command_run_conflict/);
  await assert.rejects(leases.acquire({ ...identity, provider: 'claude', threadId: 'two' }), /native_project_writer_busy/);
  const reader = { ...identity, provider: 'claude', threadId: 'two', fullAccess: false };
  const readerBinding = { ...reader, ...await leases.acquire(reader) };
  await assert.rejects(shell.call(readerBinding, { action: 'list' }), /native_chat_read_only/);
  await leases.acquire({ ...identity, provider: 'claude', threadId: 'three', root: other });
  await assert.rejects(shell.call({ ...binding, device: 'wrong' }, { action: 'list' }), /native_chat_lease_denied/);

  const run = await launch('Write-Output ready; Start-Sleep -Seconds 30', { background: true }, 'long');
  assert.equal(run.state, 'running');
  t.after(() => call({ action: 'stop', runId: run.runId }));
  for (let count = 0; count < 60 && !changes.some((sample) => sample.runId === run.runId && sample.stdout.includes('ready')); count++) {
    await delay(50);
  }
  const status = await call({ action: 'status', runId: run.runId });
  assert.equal(status.stdout.trim(), 'ready');
  const incremental = await call({ action: 'status', runId: run.runId, stdoutCursor: status.stdoutCursor });
  assert.equal(incremental.stdout, '');
  leases.suspend(binding);
  await assert.rejects(launch('exit 0', {}, 'blocked'), /native_chat_reconcile_required/);
  assert.equal(await leases.settle(binding, shell.canResume), false);
  await call({ action: 'stop', runId: run.runId });
  for (let count = 0; count < 80 && !(await call({ action: 'status', runId: run.runId })).finishedAt; count++) await delay(50);
  assert.equal((await call({ action: 'status', runId: run.runId })).state, 'cancelled');
  assert.equal(await leases.settle(binding, shell.canResume), true);
  binding.generation = leases.view(leases.get({ ...binding, generation: undefined })).generation;
  const restored = createWindowsLocalShell({ leases, journal });
  const replay = await restored.call(binding, { action: 'run', command: 'Add-Content -LiteralPath attempt.txt -Value once' },
    { requestId: 'dedup-key' });
  assert.equal(replay.runId, powershell.runId);
  assert.match(await fs.readFile(path.join(root, 'attempt.txt'), 'utf8'), /^once\r?\n$/);
  const unicode = await launch('[Console]::Write(("汉" * 6000) + "界")', {}, 'unicode');
  assert.equal(unicode.stdoutCursor, 18003);
  assert.equal(unicode.stdoutTruncated, true);
  assert.doesNotMatch(unicode.stdout, /�/u);
  const delta = await call({ action: 'status', runId: unicode.runId, stdoutCursor: 18000 });
  assert.equal(delta.stdout, '界');
  await assert.rejects(call({ action: 'status', runId: unicode.runId, stdoutCursor: 18001 }), /invalid_local_shell_cursor/);
});

test('Windows shell worker keeps the same run after the desktop client disconnects', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-windows-chat-worker-'));
  const state = path.join(temp, 'state');
  const secret = createSecret(state);
  const worker = spawn(process.execPath, [require.resolve('../orchestrator/windows-chat-worker'), state], {
    windowsHide: true, stdio: 'ignore',
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill();
      await exited;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  let connection;
  for (let count = 0; count < 30 && !connection; count++) {
    connection = await connectWorker(state, secret).catch(() => null);
    if (!connection) await delay(100);
  }
  assert.ok(connection);
  t.after(() => connection?.close());
  await assert.rejects(connectWorker(state, Buffer.alloc(32)), /windows_chat_worker_disconnected/);
  const identity = { device: 'device', provider: 'claude', threadId: 'thread', root: temp, fullAccess: true };
  const binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
  const args = { action: 'run', command: 'Start-Sleep -Seconds 1; Set-Content -LiteralPath survived.txt -Value done', background: true };
  const first = await connection.request('shell', { binding, args, requestId: 'item' });
  connection.close();
  connection = await connectWorker(state, secret);
  let status;
  for (let count = 0; count < 50; count++) {
    status = await connection.request('shell', { binding, args: { action: 'status', runId: first.runId } });
    if (status.finishedAt) break;
    await delay(100);
  }
  assert.equal(status.state, 'completed');
  assert.equal(status.exitCode, 0);
  assert.equal((await connection.request('shell', { binding, args, requestId: 'item' })).runId, first.runId);
  assert.equal((await fs.readFile(path.join(temp, 'survived.txt'), 'utf8')).trim(), 'done');
  assert.equal(await connection.request('release', { binding }), true);
  connection.close();
});

test('the Windows shell compiles and runs a real Windows executable', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async (t) => {
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try { await fs.access(compiler); } catch { return t.skip('Windows .NET Framework compiler unavailable'); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-shell-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { device: 'fixture', provider: 'codex', threadId: 'build', root, fullAccess: true };
  const leases = new WindowsProjectLeases();
  const binding = { ...identity, ...await leases.acquire(identity) };
  const shell = createWindowsLocalShell({ leases });
  await fs.writeFile(path.join(root, 'Program.cs'), 'using System; class Program { static void Main() { Console.WriteLine("fixture built on Windows"); } }');
  const result = await shell.call(binding, {
    action: 'run', env: { FIXTURE_COMPILER: compiler },
    command: '& $env:FIXTURE_COMPILER /nologo /out:Demo.exe Program.cs; if ($LASTEXITCODE) { exit $LASTEXITCODE }; & .\\Demo.exe; exit $LASTEXITCODE',
  }, { requestId: 'compile' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fixture built on Windows');
  assert.equal((await fs.readFile(path.join(root, 'Demo.exe'))).subarray(0, 2).toString(), 'MZ');
});
