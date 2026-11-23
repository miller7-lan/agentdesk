const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWindowsNativeDesktop } = require('../orchestrator/windows-native-desktop');
const { NATIVE_PROVIDERS } = require('../orchestrator/native-channel');

test('D14: without the native host a new full-access chat falls back to the MCP tools and says why', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = { id: 'project', kind: 'local', localRoot: directory };
  const tree = { projectId: project.id, repo: directory, path: directory };
  let wakes = 0;
  const remote = { cfg: {}, wake: async () => { wakes++; return true; }, request: async () => ({ exitCode: 1 }) };
  const notices = [];
  const desktop = createWindowsNativeDesktop({ stateDir: directory, remote, findProject: () => project,
    findWorktree: (key) => key === 'tree' ? tree : null, bridgeSettings: () => null,
    onEvent: (provider, event) => notices.push([provider, event.method, event.params.reason]) });
  const params = { projectId: project.id, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  for (const provider of NATIVE_PROVIDERS) {
    assert.equal(await desktop.select(provider, 'thread/start', params), null);
    assert.equal(await desktop.select(provider, 'thread/start', { ...params, worktreeSession: 'tree' }), null);
    assert.equal(await desktop.select(provider, 'thread/start', { ...params, approvalPolicy: 'on-request' }), null);
  }
  assert.equal(wakes, NATIVE_PROVIDERS.length * 2);
  assert.equal(notices.length, NATIVE_PROVIDERS.length * 2);
  assert.ok(notices.every(([, method, reason]) => method === 'agentdesk/fallback' && /缺少原生单聊服务/.test(reason)));
  await assert.rejects(desktop.select('claude', 'thread/start', { ...params, worktreeSession: 'unknown' }), /工作树/);
  project.orchestratorWorkspace = 'named';
  await assert.rejects(desktop.select('claude', 'thread/start', params), /Bridge 写入授权/);
});

test('records left over from a deleted project are found and removed without attaching to a missing folder', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-orphan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const live = { projectId: 'live', provider: 'codex', root: directory, threadId: 'keep', sessionKey: 'a' };
  const gone = [1, 2].map((n) => ({ projectId: 'gone', provider: n === 1 ? 'codex' : 'claude', root: '/missing', threadId: 'old-' + n, sessionKey: 'b' + n }));
  fs.writeFileSync(path.join(directory, 'threads.json'), JSON.stringify([live, ...gone]));
  const remote = { cfg: {}, wake: async () => true, request: async () => ({ exitCode: 1 }) };
  const desktop = createWindowsNativeDesktop({ stateDir: directory, remote,
    findProject: (id) => id === 'live' ? { id: 'live', kind: 'local', localRoot: directory } : undefined,
    findWorktree: () => null, bridgeSettings: () => null, onEvent: () => {} });
  assert.deepEqual(desktop.orphanProjects(new Set(['live'])), ['gone']);
  // One conversation of the missing project can be deleted on its own (it used to fail with 找不到本机项目目录).
  assert.equal(await desktop.deleteThread('old-1'), true);
  assert.deepEqual(await desktop.deleteProject('gone'), ['old-2']);
  assert.deepEqual(desktop.orphanProjects(new Set(['live'])), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'threads.json'), 'utf8')).map((r) => r.threadId), ['keep']);
});
