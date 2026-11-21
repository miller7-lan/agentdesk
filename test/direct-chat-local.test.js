const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { TerminalSessions, terminalLaunch, terminalSpec } = require('../orchestrator/terminal-sessions');
const { createCheckpoint, restoreCheckpoint, list } = require('../orchestrator/git-checkpoints');
const { SeatSlots } = require('../orchestrator/seat-slots');
const { StatusHub, item, quotaItems } = require('../orchestrator/status-hub');

function temporary(t, prefix) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// A pty double with the node-pty interface: echoes input like a shell would.
function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, options) {
      const events = new EventEmitter();
      const child = {
        file, args, options, written: [],
        onData: (fn) => events.on('data', fn), onExit: (fn) => events.on('exit', fn),
        write(data) { child.written.push(data); events.emit('data', data === '\x03' ? '^C\r\n' : 'echo:' + data); },
        resize(cols, rows) { child.size = [cols, rows]; },
        kill() { events.emit('exit', { exitCode: 0 }); },
      };
      spawned.push(child);
      return child;
    },
  };
}

test('A10: a terminal stays open across calls, output is read by cursor, and user takeover pauses the model', () => {
  const pty = fakePty();
  const events = [];
  const terminals = new TerminalSessions({ pty, onEvent: (event) => events.push(event.type) });
  const opened = terminals.call('scope-a', { action: 'open', cols: 100, rows: 30 }, { cwd: '/project' });
  assert.equal(pty.spawned[0].options.cwd, '/project');
  const id = opened.terminalId;
  terminals.call('scope-a', { action: 'write', terminalId: id, data: 'python3\r' });
  const first = terminals.call('scope-a', { action: 'read', terminalId: id, cursor: 0 });
  assert.equal(first.data, 'echo:python3\r');
  terminals.call('scope-a', { action: 'write', terminalId: id, data: '1+1\r' });
  const second = terminals.call('scope-a', { action: 'read', terminalId: id, cursor: first.cursor });
  assert.equal(second.data, 'echo:1+1\r', 'only output after the cursor');
  terminals.takeover('scope-a', id, true);
  assert.throws(() => terminals.call('scope-a', { action: 'write', terminalId: id, data: 'ls\r' }), /terminal_taken_over/);
  terminals.write('scope-a', id, 'ls\r', { byUser: true });
  terminals.takeover('scope-a', id, false);
  terminals.call('scope-a', { action: 'signal', terminalId: id, signal: 'SIGINT' });
  assert.equal(pty.spawned[0].written.at(-1), '\x03');
  // Another session cannot see or use it.
  assert.throws(() => terminals.call('scope-b', { action: 'read', terminalId: id }), /terminal_not_found/);
  assert.deepEqual(terminals.call('scope-b', { action: 'list' }).terminals, []);
  assert.ok(events.includes('opened') && events.includes('takenOver'));
});

test('terminals: four per session, a bounded buffer that reports truncation, and pty_unavailable without node-pty', () => {
  const terminals = new TerminalSessions({ pty: fakePty(), bufferLimit: 10 });
  const ids = [0, 1, 2, 3].map(() => terminals.open('s', { cwd: '/p' }).terminalId);
  assert.throws(() => terminals.open('s', { cwd: '/p' }), /too_many_terminals/);
  terminals.write('s', ids[0], 'abcdefghijklmnop');
  const read = terminals.read('s', ids[0], 0);
  assert.equal(read.truncated, true);
  assert.equal(read.data.length, 10);
  assert.equal(new TerminalSessions({ pty: null }).available, false);
  assert.throws(() => new TerminalSessions({ pty: null }).open('s', {}), /pty_unavailable/);
});

test('terminal shells follow the platform, and the Mac shell runs inside the AgentDesk-key sandbox', () => {
  assert.deepEqual(terminalLaunch(undefined, { platform: 'win32' }), { file: 'powershell.exe', args: ['-NoLogo'] });
  assert.equal(terminalLaunch('cmd', { platform: 'win32' }).args.length, 0);
  assert.deepEqual(terminalLaunch(undefined, { platform: 'darwin', profile: 'P' }), { file: '/usr/bin/sandbox-exec', args: ['-p', 'P', '/bin/zsh', '-l'] });
  assert.throws(() => terminalLaunch('fish', { platform: 'darwin' }), /invalid_terminal_shell/);
  assert.deepEqual(terminalSpec('win32').parameters.properties.shell.enum, ['powershell', 'pwsh', 'cmd']);
});

const gitAvailable = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

test('D8: a checkpoint records the work tree under refs/agentdesk/checkpoints without touching it, and restores it', { skip: !gitAvailable }, async (t) => {
  const root = temporary(t, 'agentdesk-checkpoint-');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).toString().trim();
  git('init', '-q');
  assert.equal((await createCheckpoint(root, { session: 's1', turn: 't1' })).skipped, 'no_commit_yet');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one');
  git('add', 'a.txt');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two (uncommitted)');
  fs.writeFileSync(path.join(root, 'new.txt'), 'untracked');
  const statusBefore = git('status', '--porcelain');
  const checkpoint = await createCheckpoint(root, { session: 's1', turn: 't2' });
  assert.equal(checkpoint.ref, 'refs/agentdesk/checkpoints/s1/t2');
  assert.equal(checkpoint.untracked, 1);
  assert.equal(git('status', '--porcelain'), statusBefore, 'work tree and index untouched');
  assert.equal(git('stash', 'list'), '', 'nothing pushed onto the stash');
  assert.equal(git('branch', '--list').split('\n').length, 1, 'no branch created');
  fs.writeFileSync(path.join(root, 'a.txt'), 'three (the AI broke it)');
  await assert.rejects(restoreCheckpoint(root, checkpoint.ref, { othersHoldLocks: true }), /checkpoint_restore_blocked_by_locks/);
  await restoreCheckpoint(root, checkpoint.ref);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two (uncommitted)');
  assert.equal((await list(root)).length, 1);
  assert.equal((await createCheckpoint(root, { session: 's1', turn: 't3', enabled: false })).skipped, 'disabled');
  await assert.rejects(restoreCheckpoint(root, 'refs/heads/main'), /invalid_checkpoint_ref/);
});

test('A16: slots — 4 sessions per device, 6 on the machine, a session holds one slot however many processes, dead holders are freed', async (t) => {
  const directory = temporary(t, 'agentdesk-slots-');
  const live = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const slots = new SeatSlots({ directory, pollMs: 5, isAlive: (pid) => live.has(pid) });
  const releases = [];
  for (let index = 0; index < 4; index++) releases.push(await slots.acquire({ device: 'mac', session: 's' + index, pid: index + 1 }));
  // Same session, another process: no new slot.
  releases.push(await slots.acquire({ device: 'mac', session: 's0', pid: 5 }));
  assert.deepEqual((await slots.status()).devices, { mac: 4 });
  const positions = [];
  let granted = false;
  const waiting = slots.acquire({ device: 'mac', session: 's4', pid: 6, onQueued: (position) => positions.push(position) })
    .then((release) => { granted = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(granted, false);
  assert.deepEqual(positions, [1]);
  // Another device still has room until the machine has 6.
  const win1 = await slots.acquire({ device: 'win', session: 'w1', pid: 7 });
  const win2 = await slots.acquire({ device: 'win', session: 'w2', pid: 8 });
  assert.equal((await slots.status()).total, 6);
  let third = false;
  const win3 = slots.acquire({ device: 'win', session: 'w3', pid: 9 }).then((release) => { third = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(third, false, 'machine limit 6');
  // A holder process dies: its slot is freed and the first in line gets it.
  live.delete(2);
  const release4 = await waiting;
  assert.equal(granted, true);
  assert.equal(third, false, 'the earlier ticket went first');
  release4();
  (await win3)();
  win1(); win2();
  for (const release of releases) release();
});

test('status items carry source, measured time and freshness; nothing measured is unknown, never 0%', async () => {
  let now = Date.parse('2026-11-21T12:00:00Z');
  const fresh = item({ provider: 'codex', kind: 'quota', value: { buckets: [] }, source: 'codex_app_server', observedAt: now - 1000, now });
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(item({ provider: 'codex', kind: 'quota', value: 1, observedAt: now - 130_000, now }).freshness, 'stale');
  assert.equal(item({ provider: 'grok', kind: 'quota', now }).freshness, 'unknown');
  assert.equal(item({ provider: 'grok', kind: 'quota', error: 'quota_read_failed', now }).freshness, 'error');
  const items = quotaItems([
    { provider: 'claude', state: 'available', source: 'claude_usage', observedAt: new Date(now).toISOString(),
      buckets: [{ id: 'claude-account', fiveHour: { usedPercent: 12, resetsAt: 1 }, weekly: null }] },
    { provider: 'grok', state: 'unavailable', reason: 'signed_out', buckets: [] },
    { provider: 'antigravity', state: 'unavailable', reason: 'no_quota_source', buckets: [] },
  ], { now });
  assert.equal(items[0].unofficial, true, 'Claude OAuth usage is marked unofficial (D12)');
  assert.equal(items[0].value.buckets[0].weekly, null);
  assert.equal(items[1].freshness, 'error');
  assert.equal(items[2].value, null);
  assert.equal(items[2].freshness, 'unknown');

  const hub = new StatusHub({ now: () => now, minIntervalMs: 10_000, readers: {
    codex: async () => [{ provider: 'codex', kind: 'quota', value: { buckets: [{ id: 'a', fiveHour: { usedPercent: 40 } }] }, source: 'codex_app_server', observedAt: now }],
    broken: async () => { throw new Error('boom'); },
  } });
  const pushed = [];
  hub.subscribe((changed) => pushed.push(changed));
  await hub.refresh();
  assert.equal(pushed.length, 1);
  assert.ok(hub.snapshot().some((entry) => entry.provider === 'broken' && entry.freshness === 'error'));
  // A second read within 10 s is the shared reading, not a new request.
  await hub.refresh();
  assert.equal(pushed.length, 1);
  now += 3 * 60_000;
  assert.equal(hub.snapshot().find((entry) => entry.provider === 'codex').freshness, 'stale', 'unrefreshed values turn stale by themselves');
});

test('admin "ad device" help is printed for an unknown action without touching anything', () => {
  const result = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, '..', 'orchestrator', 'admin.js'), '-', 'device', 'bogus'], { env: { ...process.env, AGENTDESK_DEVICES: '/nonexistent/devices.json' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /device list \| approve/);
  void spawn;
});
