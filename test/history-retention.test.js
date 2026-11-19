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