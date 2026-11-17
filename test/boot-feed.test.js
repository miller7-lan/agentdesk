const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBootData, collect } = require('../src/boot-feed');

test('maps actual check results and spaces nodes in completion order', () => {
  const data = buildBootData({
    desktop: { at: 0.1, value: true },
    remote: { at: 0.2, value: { codex: 'ready' } },
    routes: { at: 0.3, value: { ssh: true } },
    quota: { at: 0.5, value: [
      { provider: 'grok', used: 100 },
      { provider: 'antigravity', state: 'not_configured' },
    ] },
  });
  assert.equal(data.online, true);
  assert.equal(data.offline, false);
  assert.deepEqual(data.nodes.slice(0, 2).map(({ id, status }) => [id, status]), [
    ['local', 'AUTHORIZED'], ['codex', 'READY'],
  ]);
  assert.equal(data.nodes.find(({ id }) => id === 'grok').status, 'QUOTA 0%');
  assert.equal(data.nodes.find(({ id }) => id === 'antigravity').status, 'NOT CONFIGURED');
  for (let i = 1; i < data.nodes.length; i++) {
    assert.ok(data.nodes[i].at - data.nodes[i - 1].at >= 0.45 - Number.EPSILON * 4);
  }
});

test('leaves unresolved checks waiting and keeps raw status out of logs', () => {
  const remote = { at: 0.1, value: { codex: 'error', detail: 'ssh password secret' } };
  assert.equal(buildBootData({ remote }).offline, false);
  const data = buildBootData({ remote, routes: { at: 0.2, value: null }, quota: { at: 0.3, value: null } });
  assert.equal(data.offline, true);
  assert.equal(data.nodes.find(({ id }) => id === 'local').status, 'WAITING');
  assert.equal(data.nodes.find(({ id }) => id === 'codex').status, 'OFFLINE');
  assert.doesNotMatch(JSON.stringify(data), /password|secret/);
});

test('stops publishing after the deadline even if an IPC call responds later', async () => {
  let resolveRoutes;
  const routes = new Promise((resolve) => { resolveRoutes = resolve; });
  const updates = [];
  collect({
    remote: { status: async () => ({ codex: 'error' }) },
    desktop: { enabled: async () => true },
    orchestrator: { control: ({ operation }) => operation === 'routes' ? routes : Promise.reject(Error('secret')) },
  }, (data) => updates.push(data), { timeout: 10 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const count = updates.length;
  assert.ok(count > 0);
  assert.equal(updates.at(-1).offline, false);
  resolveRoutes({ ok: true, value: { ssh: true } });
  await routes;
  await Promise.resolve();
  assert.equal(updates.length, count);
});
