'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/access-toggle');

function memory(init = {}) { const data = { ...init }; return { data, get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } }; }

test('first use starts in 自动编辑; new chats follow the last writable mode, never plan', () => {
  const store = memory();
  assert.equal(M.newSessionMode(store), 'edit');
  M.record(store, 'auto');
  assert.equal(M.newSessionMode(store), 'auto');
  M.record(store, 'plan');
  assert.equal(store.data.lastPermissionMode, 'plan');
  assert.equal(M.newSessionMode(store), 'auto', 'a chat left in plan does not start the next one in plan');
  M.record(store, 'ask');
  assert.equal(M.newSessionMode(store), 'ask');
});

test('the 完全访问 switch: on = auto, off = the last ask/edit, never plan', () => {
  const store = memory();
  assert.equal(M.toggled(true, store), 'auto');
  assert.equal(M.toggled(false, store), 'edit');
  M.record(store, 'ask');
  M.record(store, 'plan');
  M.record(store, 'auto');
  assert.equal(M.toggled(false, store), 'ask');
  assert.equal(store.data.lastSafeWritableMode, 'ask');
  assert.equal(store.data.lastWritableMode, 'auto');
});

test('native chats only know plan and auto; the switch is not available there', () => {
  const store = memory({ lastWritableMode: 'edit' });
  assert.deepEqual(M.allowed(true), ['plan', 'auto']);
  assert.equal(M.newSessionMode(store, { native: true }), 'auto');
  assert.equal(M.coerce('ask', true), 'auto');
  assert.equal(M.coerce('plan', true), 'plan');
  assert.equal(M.toggled(false, store, { native: true }), null);
  assert.equal(M.handoverMode(store, { native: true }), 'auto');
});

test('an older client only kept lastPermissionMode', () => {
  const store = memory({ lastPermissionMode: 'ask' });
  M.migrate(store);
  assert.equal(store.data.lastWritableMode, 'ask');
  assert.equal(store.data.lastSafeWritableMode, 'ask');
  const planned = memory({ lastPermissionMode: 'plan' });
  M.migrate(planned);
  assert.equal(M.newSessionMode(planned), 'edit');
  const full = memory({ lastPermissionMode: 'auto' });
  M.migrate(full);
  assert.equal(M.newSessionMode(full), 'auto');
  assert.equal(M.toggled(false, full), 'edit');
});

test('handover after a plan goes to the last writable mode', () => {
  const store = memory();
  assert.equal(M.handoverMode(store), 'edit');
  M.record(store, 'auto'); M.record(store, 'plan');
  assert.equal(M.handoverMode(store), 'auto');
});

test('a chat on the old route where native chats exist cannot switch to 完全访问 in place', () => {
  const store = memory();
  M.record(store, 'ask'); M.record(store, 'auto');
  assert.deepEqual(M.allowed(false, true), ['ask', 'edit', 'plan']);
  assert.equal(M.toggled(true, store, { locked: true }), null);
  assert.equal(M.toggled(false, store, { locked: true }), 'ask');
  assert.equal(M.coerce('auto', false, { locked: true, store }), 'ask');
  assert.equal(M.handoverMode(store, { locked: true }), 'ask', 'the handover falls back to the last ask/edit');
  assert.equal(M.handoverMode(store), 'auto');
});
