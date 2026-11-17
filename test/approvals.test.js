const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identity, matches, load, remember, clear, decision } = require('../src/approvals');

const method = 'item/commandExecution/requestApproval';
const message = { method, params: { threadId: 'a', cwd: '/repo', tool: 'shell' } };

test('approval requires an exact match of thread, tool and working directory', () => {
  const rule = identity(message);
  assert.equal(matches(rule, identity(message)), true);
  for (const field of ['threadId', 'tool', 'cwd']) {
    assert.equal(matches(rule, identity({ method, params: { ...message.params, [field]: message.params[field] + '/x' } })), false);
  }
  assert.equal(identity({ ...message, params: { threadId: 'a' } }), null);
  assert.equal(identity({ ...message, method: 'item/tool/requestUserInput' }), null);
});

test('remembered rules apply only to the selected group and are deduplicated', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
  const rule = identity(message);
  assert.equal(remember(storage, 'group', rule), true);
  remember(storage, 'group', rule);
  assert.deepEqual(load(storage, 'group'), [rule]);
  assert.deepEqual(load(storage, 'other'), []);
  assert.equal(remember(storage, 'group', null), false);
  clear(storage, 'group');
  assert.deepEqual(load(storage, 'group'), []);
});

test('a remembered approval sends ordinary approval for the particular request', () => {
  assert.deepEqual(decision(method, true), { decision: 'accept' });
  assert.deepEqual(decision('execCommandApproval', false), { decision: 'denied' });
});
