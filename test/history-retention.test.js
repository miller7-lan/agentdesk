const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

const DAY = 86400_000;

test('cleanupNow removes task records and events older than the history window', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-history-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-19T12:00:00Z');
  const oldId = randomUUID();
  const newId = randomUUID();
  for (const [id, days] of [[oldId, 61], [newId, 1]]) {
    store.saveTask({
      id, workspace: 'mac', owner: 'local', state: 'completed', detail: 'completed',
      updatedAt: new Date(now - days * DAY).toISOString(),
    }, { kind: 'completed' });
  }
  const config = { stateDir, quota: false, adapters: { claude: { bin: 'claude', env: {} } } };
  const scheduler = new Scheduler({ config, store, files: {}, now: () => now });
  t.after(() => { scheduler.stopped = true; });

  const result = await scheduler.cleanupNow();

  assert.equal(result.historyRemoved, 1);
  assert.equal(result.vacuumed, true);
  assert.deepEqual(store.all('tasks').map((task) => task.id), [newId]);
  assert.equal(scheduler.tasks.has(oldId), false);
  assert.equal(scheduler.tasks.has(newId), true);
  assert.deepEqual(store.events(oldId), []);
});
test('history prune archives records and events first, keeps uncleared tasks, and dry run deletes nothing', async (t) => {
  const zlib = require('node:zlib');
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-history-archive-')));
  const store = new Store(':memory:');
  t.after(() => { store.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-19T12:00:00Z');
  const [oldId, keptId] = [randomUUID(), randomUUID()];
  const at = new Date(now - 61 * DAY).toISOString();
  // The old task's files were cleared in an earlier pass; the other one's could not be (its logs folder
  // resolves outside the state directory), so its record must stay.
  store.saveTask({ id: oldId, workspace: 'mac', owner: 'local', state: 'completed', detail: 'completed', updatedAt: at,
    cleanedAt: at }, { kind: 'completed' });
  store.saveTask({ id: keptId, workspace: 'mac', owner: 'local', state: 'completed', detail: 'completed', updatedAt: at }, { kind: 'completed' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-history-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, keptId));
  fs.symlinkSync(outside, path.join(stateDir, 'logs'));
  const config = { stateDir, quota: false, adapters: { claude: { bin: 'claude', env: {} } } };
  const scheduler = new Scheduler({ config, store, files: {}, now: () => now });
  t.after(() => { scheduler.stopped = true; });

  const dry = await scheduler.cleanupNow({ dryRun: true });
  assert.equal(dry.historyRemoved, 0);
  assert.equal(store.all('tasks').length, 2);

  const result = await scheduler.cleanupNow();
  assert.equal(result.historyRemoved, 1);
  assert.deepEqual(store.all('tasks').map((task) => task.id), [keptId], 'a task whose files failed to clear keeps its record');
  assert.ok(fs.existsSync(path.join(outside, keptId)));
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(result.historyArchive)));
  assert.equal(archive.tasks[0].task.id, oldId);
  assert.equal(archive.tasks[0].events[0].kind, 'completed');
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.historyArchive).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(path.join(stateDir, 'cleanup-audit.jsonl'), 'utf8').includes('"history_delete"'));
  assert.equal(scheduler.lastCleanup.ok, false);
});
