const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');

test('deleteTasks removes task records and their events but keeps other buckets', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-store-'));
  const store = new Store(path.join(dir, 'test.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const oldId = randomUUID();
  const newId = randomUUID();
  store.saveTask({ id: oldId, state: 'completed', updatedAt: '2026-01-01T00:00:00.000Z' }, { kind: 'completed' });
  store.saveTask({ id: newId, state: 'completed', updatedAt: '2026-11-19T00:00:00.000Z' }, { kind: 'completed' });
  store.put('settings', 'route', { value: 'ssh' });

  assert.equal(store.deleteTasks([oldId, oldId]), 1);
  assert.deepEqual(store.all('tasks').map((task) => task.id), [newId]);
  assert.deepEqual(store.events(oldId), []);
  assert.equal(store.events(newId).length, 1);
  assert.deepEqual(store.get('settings', 'route'), { value: 'ssh' });

  store.vacuum();
  assert.deepEqual(store.all('tasks').map((task) => task.id), [newId]);
});