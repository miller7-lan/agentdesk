const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWindowsNativeDesktop } = require('../orchestrator/windows-native-desktop');
const { NATIVE_PROVIDERS } = require('../orchestrator/native-channel');

test('all full-access direct providers require the native host for a locally selected folder', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = { id: 'project', kind: 'local', localRoot: directory };
  const tree = { projectId: project.id, repo: directory, path: directory };
  let wakes = 0;
  const remote = { cfg: {}, wake: async () => { wakes++; return true; }, request: async () => ({ exitCode: 1 }) };
  const desktop = createWindowsNativeDesktop({ stateDir: directory, remote, findProject: () => project,
    findWorktree: (key) => key === 'tree' ? tree : null, bridgeSettings: () => null });
  const params = { projectId: project.id, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  for (const provider of NATIVE_PROVIDERS) {
    await assert.rejects(desktop.select(provider, 'thread/start', params), /缺少 Windows 原生单聊服务/);
    await assert.rejects(desktop.select(provider, 'thread/start', { ...params, worktreeSession: 'tree' }), /缺少 Windows 原生单聊服务/);
    assert.equal(await desktop.select(provider, 'thread/start', { ...params, approvalPolicy: 'on-request' }), null);
  }
  assert.equal(wakes, NATIVE_PROVIDERS.length * 2);
  await assert.rejects(desktop.select('claude', 'thread/start', { ...params, worktreeSession: 'unknown' }), /工作树/);
  project.orchestratorWorkspace = 'named';
  await assert.rejects(desktop.select('claude', 'thread/start', params), /Bridge 写入授权/);
});
