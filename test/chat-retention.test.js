const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneThreads, retentionDays, DAY } = require('../orchestrator/chat-retention');

const now = Date.parse('2026-11-19T12:00:00Z');

test('chat threads older than the window are pruned; recent and undated threads stay', () => {
  const state = { version: 1, threads: {
    old: { id: 'old', updatedAt: now - 61 * DAY },
    createdOnly: { id: 'createdOnly', createdAt: now - 61 * DAY },
    recent: { id: 'recent', updatedAt: now - 59 * DAY },
    undated: { id: 'undated' },
  } };
  assert.deepEqual(pruneThreads(state, { now }), ['old', 'createdOnly']);
  assert.deepEqual(Object.keys(state.threads).sort(), ['recent', 'undated']);
});

test('chat retention defaults to 60 days and accepts an environment override', () => {
  assert.equal(retentionDays({}), 60);
  assert.equal(retentionDays({ AGENTDESK_CHAT_RETENTION_DAYS: '30' }), 30);
  assert.equal(retentionDays({ AGENTDESK_CHAT_RETENTION_DAYS: 'nope' }), 60);
});