const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { makeProtocol, eventEnvelope, errorResponse } = require('../orchestrator/windows-native-protocol');
const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
const { createWindowsLocalShell } = require('../orchestrator/windows-local-shell');
const { createProjectMounts } = require('../orchestrator/project-mount');

test('native protocol validates the negotiated version and trusted identity without exposing private paths', async () => {
  const dispatch = makeProtocol({});
  const request = { protocolVersion: 1, requestId: 'example', operation: 'project.acquire' };
  assert.equal((await dispatch(request)).error.code, 'AUTH_DENIED');
  assert.equal((await dispatch({ ...request, protocolVersion: 2 })).error.code, 'INVALID_REQUEST');
  assert.equal((await dispatch({ ...request, projectRoot: 'C:\\private' })).error.code, 'INVALID_REQUEST');
  const hidden = errorResponse(new Error('cannot open C:\\private\\credentials.txt'), 'example');
  assert.equal(hidden.error.requestId, 'example');
  assert.doesNotMatch(JSON.stringify(hidden), /private|credentials/);
  assert.equal(errorResponse(new Error('command_run_conflict'), 'example').error.code, 'COMMAND_CONFLICT');
  const context = { deviceId: 'device', threadId: 'thread', projectId: 'project' };
  const first = eventEnvelope('project.leaseChanged', context, 1, { state: 'active' });
  const second = eventEnvelope('project.reconcileRequired', context, 2, {});
  assert.ok(second.sequence > first.sequence);
  assert.match(second.timestamp, /Z$/);
});

test('native mount lifecycle reports suspension and uses a new mount identity after recovery', async () => {
  const events = [];
  let controller;
  const mounts = createProjectMounts({
    stateDir: '/fixture', openTransport: async () => ({}),
    mount: async ({ readOnly }) => {
      assert.equal(readOnly, true);
      controller = new AbortController();
      return { directory: '/private/project', signal: controller.signal, close: async () => controller.abort() };
    },
    onChange: (mount) => events.push(mount.state),
  });
  const binding = { id: 'lease', generation: 1 };
  const context = { accessMode: 'read' };
  const request = { requestId: 'mount-1' };
  const first = await mounts('project.mount', binding, request, context);
  assert.equal((await mounts('project.mount', binding, request, context)).mountId, first.mountId);
  controller.abort();
  const stale = await mounts('project.mountStatus', binding, request, context);
  assert.equal(stale.state, 'suspended');
  assert.equal(stale.mountPath, null);
  await mounts('project.unmount', binding, { mountId: first.mountId }, context);
  const next = await mounts('project.mount', { ...binding, generation: 2 }, { requestId: 'mount-2' }, context);
  assert.notEqual(next.mountId, first.mountId);
  assert.deepEqual(events.slice(0, 5), ['mounting', 'ready', 'suspended', 'unmounting', 'unmounted']);
});

test('native protocol arbitrates writers and requires trusted review of unknown command outcomes', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-native-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = await fs.realpath(root);
  const leases = new WindowsProjectLeases();
  const shell = createWindowsLocalShell({ leases });
  const dispatch = makeProtocol({ leases, shell });
  const codex = { provider: 'codex', deviceId: 'windows-device', threadId: 'codex-thread', projectId: 'project', projectRoot, accessMode: 'write' };
  const claude = { ...codex, provider: 'claude', threadId: 'claude-thread' };
  let count = 0;
  const call = (context, operation, fields = {}) => dispatch({
    protocolVersion: 1, operation, requestId: 'request-' + (++count), ...fields,
  }, context);
  const results = await Promise.all([call(codex, 'project.acquire'), call(claude, 'project.acquire')]);
  // D1: two writers share the project by default; their writes to one file are ordered by the file locks.
  assert.equal(results.filter((item) => item.ok).length, 2);
  const owner = codex;
  const lease = results[0].value;
  for (const provider of ['grok', 'antigravity']) {
    const sameProject = { ...owner, provider, threadId: provider + '-thread' };
    assert.equal((await call(sameProject, 'project.acquire', { exclusive: true })).error.code, 'LEASE_BUSY');
    assert.equal((await call({ ...sameProject, accessMode: 'read' }, 'project.acquire')).ok, true);
  }
  assert.equal((await call(owner, 'project.acquire')).value.leaseId, lease.leaseId);
  const reader = { ...owner, threadId: 'reader', accessMode: 'read' };
  assert.equal((await call(reader, 'project.acquire')).ok, true);
  const fields = { leaseId: lease.leaseId, generation: lease.generation };
  assert.equal((await call(owner, 'project.status', { ...fields, deviceId: 'impostor' })).error.code, 'AUTH_DENIED');
  await call(owner, 'project.suspend', fields);
  assert.equal((await call(owner, 'local_shell.run', fields)).error.code, 'LEASE_SUSPENDED');
  const reconciled = await call(owner, 'project.reconcile', fields);
  assert.equal(reconciled.value.generation, lease.generation + 1);
  assert.equal((await call(owner, 'project.status', fields)).error.code, 'LEASE_EXPIRED');
  const current = { ...fields, generation: reconciled.value.generation };
  const missing = await call(owner, 'local_shell.status', { ...current, args: { runId: 'absent' } });
  assert.equal(missing.error.code, 'COMMAND_STATUS_UNKNOWN');
  const internal = leases.get({ id: lease.leaseId, device: owner.deviceId,
    provider: owner.provider, threadId: owner.threadId, projectId: owner.projectId });
  internal.unknownFiles = true;
  const denied = await call(owner, 'project.release', { ...current, unknownReviewed: true });
  assert.equal(denied.error.code, 'RECONCILE_REQUIRED');
  assert.equal((await call({ ...owner, unknownReviewed: true }, 'project.release', current)).value.state, 'released');
});
