const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createInterface } = require('node:readline');
const { connect } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Store = require('../orchestrator/store');
const { Lines, Relay, messageId } = require('../orchestrator/transport');
const { Endpoint } = require('../orchestrator/rpc');
const { WindowsOperations, RemoteFiles } = require('../orchestrator/windows');
const { Scheduler, parsePlan } = require('../orchestrator/scheduler');
const { request: mcpRequest } = require('../orchestrator/mcp');
const { start, startBridge } = require('../orchestrator/service');

async function folder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await wait(20);
  }
  assert.fail('timed out waiting for condition');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function repository(t) {
  const dir = await folder(t);
  const workspace = path.join(dir, 'workspace');
  const mirror = path.join(dir, 'mirror.git');
  await fs.mkdir(workspace);
  git(workspace, 'init');
  await fs.writeFile(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--bare', workspace, mirror);
  return { dir, workspace, mirror, head };
}

function admin(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const wire = new Lines(socket);
    wire.on('fault', reject);
    wire.once('frame', (result) => {
      socket.destroy();
      if (result.ok) resolve(result.value);
      else reject(new Error(result.error));
    });
    socket.once('connect', () => wire.send(frame));
  });
}

test('validates the task graph and generates Relay UUIDv7 IDs', () => {
  assert.match(messageId(), /^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab][0-9a-f-]+$/);
  assert.throws(() => parsePlan(JSON.stringify([{ id: 'a', role: 'codex', prompt: 'x', dependsOn: ['a'] }])), /invalid_plan/);
  const steps = parsePlan(JSON.stringify([
    { id: 'a', role: 'grok', prompt: 'x', dependsOn: [] },
    { id: 'b', role: 'codex', prompt: 'y', dependsOn: ['a'] },
  ]));
  assert.equal(steps[0].write, false);
  assert.equal(steps[1].write, true);
});

test('desktop control uses a Windows named pipe and reports an offline bridge accurately', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-pipe-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\agentdesk-test-' + randomUUID() : path.join(dir, 'control.sock');
  const stop = startBridge({
    config: { stateDir: path.join(dir, 'bridge'), controlSocket: socket, workspaces: {} },
    desktop: { enabled: false },
  });
  t.after(async () => { stop(); await wait(50); await fs.rm(dir, { recursive: true, force: true }); });
  await wait(30);
  assert.deepEqual(await mcpRequest(socket, { operation: 'routes' }), { route: null, ssh: false, relay: false });
  await assert.rejects(mcpRequest(socket, { operation: 'start_plan', prompt: 'hello' }), /bridge_offline/);
});

test('SSH gateway, scheduler and Windows bridge apply a reviewed diff and run an authorized command', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, workspace, mirror } = await repository(t);
  const stateDir = path.join(dir, 'vps');
  const bridgeState = path.join(dir, 'win');
  const bins = {};
  for (const name of ['codex', 'claude', 'grok', 'gemini']) {
    const binary = path.join(dir, name);
    bins[name] = { bin: binary };
    await fs.writeFile(binary, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const name = require('node:path').basename(process.argv[1]);",
      "if (name === 'codex' && process.argv.includes('app-server')) {",
      "require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
      "const {id, method} = JSON.parse(line);",
      "if (method === 'initialize') console.log(JSON.stringify({id,result:{}}));",
      "if (method === 'account/rateLimits/read') console.log(JSON.stringify({id,result:{rateLimitsByLimitId:{shared:{primary:{windowDurationMins:300,usedPercent:13},secondary:{windowDurationMins:10080,usedPercent:26}}}}}));",
      "});",
      "return;",
      "}",
      "let input = ''; process.stdin.on('data', (chunk) => { input += chunk });",
      "process.stdin.on('end', () => {",
      "setTimeout(() => {",
      "if (name === 'grok') { console.log('research complete'); return; }",
      "if (name === 'gemini') {",
      "if (!process.argv.includes('fixture-model') || !process.argv.includes('default') || !process.argv.some(arg => arg.endsWith('agentdesk-review.toml')) || !input.includes('confirmed scope')) process.exit(42);",
      "console.log(JSON.stringify({ type: 'init', session_id: 'gemini-fixture' }));",
      "for (const content of ['Gemini ', 'finished']) console.log(JSON.stringify({ type: 'message', role: 'assistant', content, delta: true }));",
      "return;",
      "}",
      "let text = 'implementation complete';",
      "if (input.startsWith('You are 组长')) {",
      "const context = JSON.parse(input.trim().split('\\n').at(-1));",
      "if (context.models.gemini.models['fixture-model'].inputUsdPerMillion !== 0.2) process.exit(42);",
      "text = JSON.stringify(context.rounds.length < 2 ? { questions: ['Clarify round ' + context.rounds.length] } : { summary: 'Update and verify', steps: [{id:'edit', role:context.preferredExecutor,prompt:'Implement with the confirmed scope', dependsOn:[]}] });",
      "}",
      "else if (input.startsWith('Plan this')) text = JSON.stringify([",
      "  { id: 'edit', capability: 'implement', prompt: 'Implement fixture', dependsOn: [] },",
      "  { id: 'review', capability: 'review', role: 'grok', prompt: 'Review fixture', dependsOn: [] },",
      "  { id: 'research', capability: 'research', prompt: 'Research fixture', dependsOn: [] },",
      "]);",
      "else if (name === 'claude') text = 'review complete';",
      "else fs.writeFileSync('README.md', 'updated\\n');",
      "if (name === 'claude') { console.log(JSON.stringify({ type: 'result', result: text, session_id: 'review-id', usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400 }, total_cost_usd: 0.01 })); return; }",
      "console.log(JSON.stringify({ thread_id: 'fixture', item: { type: 'agent_message', text } }));",
      "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 } }));",
      '}, 300);',
      '});',
    ].join('\n'), { mode: 0o700 });
  }
  bins.gemini.defaultModel = 'fixture-model';
  bins.gemini.models = {
    'fixture-model': { strengths: 'Analysis', billing: 'api', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.7 },
  };
  const observedAt = new Date().toISOString();
  bins.claude.quotaFile = path.join(dir, 'claude-quotas.json');
  await fs.writeFile(bins.claude.quotaFile, JSON.stringify({
    observedAt,
    buckets: [{ id: 'shared', fiveHour: { usedPercent: 4 }, weekly: { usedPercent: 33, resetsAt: 1 } }],
  }));
  const service = start({
    stateDir, adapters: bins, sshBridges: ['mac'], quotaBridges: ['mac'], acceptance: { mode: 'off' },
    workspaces: { project: { repository: mirror, sshBridge: 'mac' } },
  });
  t.after(service.close);
  const socket = path.join(stateDir, 'admin.sock');
  await fs.stat(socket).catch(async () => wait(50));
  const quotas = await admin(socket, { kind: 'task.status', task_id: randomUUID(), body: { operation: 'quota_status' } });
  assert.deepEqual(quotas[0].buckets, [{ id: 'shared', fiveHour: { usedPercent: 13, resetsAt: null }, weekly: { usedPercent: 26, resetsAt: null } }]);
  assert.equal(quotas[0].used, 26);
  assert.equal(quotas[0].level, 'ok');
  const { used, level, policy, ...claudeQuota } = quotas[1];
  assert.deepEqual(claudeQuota, { provider: 'claude', state: 'available', source: 'snapshot', observedAt,
    buckets: [{ id: 'shared', fiveHour: { usedPercent: 4, resetsAt: null }, weekly: null }] });
  assert.deepEqual([used, level, policy.soft, policy.keepFor], [4, 'ok', 60, ['plan', 'triage', 'accept']]);
  assert.equal(quotas[2].reason, 'signed_out');   // Grok reads its billing with the CLI's sign-in; none here
  const stopBridge = startBridge({
    config: {
      stateDir: bridgeState, ssh: {}, readAnyFolder: true,
      controlWorkspace: 'project', controlSocket: path.join(dir, 'control.sock'),
      workspaces: { project: { root: workspace, write: true, commands: { smoke: [process.execPath, '-e', "console.log('test ok')"] } } },
    },
    desktop: { enabled: false },
    spawnSsh: () => spawn(process.execPath, [require.resolve('../orchestrator/ssh-gateway'), path.join(stateDir, 'bridge-mac.sock')]),
  });
  t.after(stopBridge);
  await until(() => service.endpoint['ssh:mac']?.ready);
  const liveQuotas = await mcpRequest(path.join(dir, 'control.sock'), { operation: 'quota_status' });
  assert.equal(liveQuotas[0].state, 'available');
  // Claude is snapshot-backed; the bridge sees the same windows the desktop draws its rings from.
  assert.equal(liveQuotas[1].state, 'available');
  assert.equal(liveQuotas[1].source, 'snapshot');
  assert.deepEqual(liveQuotas[1].buckets, [{ id: 'shared', fiveHour: { usedPercent: 4, resetsAt: null }, weekly: null }]);
  assert.equal(liveQuotas[1].used, 4);
  assert.equal(liveQuotas[1].usedSource, undefined);
  assert.ok(service.scheduler.store.all('received').every((record) =>
    !Array.isArray(record.reply?.body.value)));
  const bridgeStore = new Store(path.join(bridgeState, 'bridge.sqlite'));
  try {
    const quotaRequest = bridgeStore.all('sent').find((record) => record.liveQuota);
    assert.equal(quotaRequest?.state, 'finished');
    assert.equal(quotaRequest.result, undefined);
  } finally {
    bridgeStore.close();
  }
  const task_id = randomUUID();
  await admin(socket, { kind: 'task.request', task_id, body: { workspace: 'project', prompt: 'update fixture', command: 'smoke' } });
  const support = service.scheduler.config.mcp;
  // Grok serves both read-only steps, so it runs them one at a time; Codex implements alongside.
  await until(() => {
    const steps = service.scheduler.tasks.get(task_id).steps;
    return steps.length === 3 && steps.filter((step) => step.state === 'running').length >= 2 && support.capabilities.size > 0;
  });
  const capability = [...support.capabilities.keys()][0];
  assert.equal((await mcpRequest(support.socket, { capability, operation: 'stat', path: 'README.md' })).type, 'file');
  await assert.rejects(mcpRequest(support.socket, { capability, operation: 'write', path: 'README.md' }), /mcp_permission_denied/);
  // Only the lead may use the bridge's computer location; other steps do not even see it.
  const locations = await mcpRequest(support.socket, { capability, operation: 'locations' });
  assert.ok(!locations.locations.some(({ id }) => id === 'computer'));
  await assert.rejects(mcpRequest(support.socket, { capability, operation: 'list', root: 'computer', path: os.homedir() }),
    /mcp_permission_denied/);
  await until(() => service.scheduler.tasks.get(task_id).state === 'needs_review' || service.scheduler.tasks.get(task_id).state === 'failed');
  const status = await admin(socket, { kind: 'task.status', task_id, body: { operation: 'status' } });
  assert.equal(status.detail, 'patches_ready');
  assert.equal(status.steps.find((step) => step.role === 'grok').output.trim(), 'research complete');
  // Claude only planned (one call); Codex implemented and Grok reviewed and researched. Token use is kept per CLI.
  assert.deepEqual(status.usage.claude, { input: 120, cachedInput: 400, output: 30, costUsd: 0.01 });
  assert.deepEqual(status.usage.codex, { input: 50, cachedInput: 10, output: 5 });
  assert.equal(status.usage.grok, undefined);   // the Grok fixture prints plain text and reports no usage
  assert.equal(status.steps.find((step) => step.role === 'codex').write, true);
  const listed = await admin(socket, { kind: 'task.status', task_id: randomUUID(), body: { operation: 'list' } });
  assert.equal(listed[0].id, task_id);
  // Quota is read at the start and end of the task; the fixtures report fixed numbers, so the charge is zero.
  await until(() => service.scheduler.tasks.get(task_id).quota);
  assert.deepEqual(service.scheduler.tasks.get(task_id).quota.codex, { fiveHour: 0, weekly: 0 });
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'base\n');
  const result = await admin(socket, { kind: 'task.status', task_id, body: { operation: 'apply' } });
  assert.equal(result.state, 'completed');
  assert.match(result.testResult.stdout, /test ok/);
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'updated\n');

  git(workspace, 'restore', '--source=HEAD', '--staged', '--worktree', 'README.md');
  const groupId = randomUUID();
  const control = (operation, extra) => mcpRequest(path.join(dir, 'control.sock'), { operation, taskId: groupId, ...extra });
  await control('start_plan', { prompt: 'update fixture from the group', provider: 'gemini' });
  for (const revision of [1, 2]) {
    await until(() => service.scheduler.tasks.get(groupId).state === 'awaiting_details');
    const planning = await control('status');
    assert.equal(planning.plan.rounds.at(-1).revision, revision);
    assert.equal(planning.steps.length, 0);
    assert.equal(support.capabilities.size, 0);
    await assert.rejects(control('plan_approve', { revision }), /plan_changed/);
    await control('plan_reply', { revision, reply: 'Answer ' + revision });
    await control('plan_reply', { revision, reply: 'Answer ' + revision });
  }
  await until(() => service.scheduler.tasks.get(groupId).state === 'awaiting_approval');
  const proposal = await control('status');
  assert.equal(proposal.plan.rounds.at(-1).steps[0].prompt, 'Implement with the confirmed scope');
  assert.equal(proposal.plan.rounds.at(-1).steps[0].model, 'fixture-model');
  assert.doesNotMatch(JSON.stringify(proposal), /inputUsdPerMillion/);
  assert.deepEqual(proposal.steps, []);
  const recovered = new Scheduler({ config: service.scheduler.config, store: service.scheduler.store, files: service.scheduler.files });
  assert.deepEqual(recovered.status(groupId).plan, proposal.plan);
  assert.equal(recovered.status(groupId).state, 'awaiting_approval');
  await assert.rejects(control('plan_approve', { revision: 2 }), /plan_changed/);
  await control('plan_reply', { revision: 3, reply: 'Please adjust the proposal' });
  await until(() => service.scheduler.tasks.get(groupId).state === 'awaiting_approval');
  await assert.rejects(control('plan_approve', { revision: 3 }), /plan_changed/);
  await control('plan_approve', { revision: 4 });
  await control('plan_approve', { revision: 4 });
  await until(() => ['completed', 'failed'].includes(service.scheduler.tasks.get(groupId).state));
  const groupResult = await control('status');
  assert.equal(groupResult.state, 'completed', groupResult.detail);
  assert.equal(groupResult.steps[0].write, false);
  assert.equal(groupResult.plan.approved, 4);
  assert.equal(groupResult.steps[0].role, 'gemini');
  assert.equal(groupResult.steps[0].model, 'fixture-model');
  assert.equal(groupResult.steps[0].output, 'Gemini finished');
  assert.equal(groupResult.steps[0].brief, 'Implement with the confirmed scope');   // shown in the member's own conversation
  assert.equal(groupResult.steps[0].attempts, 1);
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'base\n');
});

test('Node endpoints interoperate with the Python TLS Relay and use chunked file transfer', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const dir = await folder(t);
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
  const tokens = { bridge: randomBytes(32).toString('base64url'), orch: randomBytes(32).toString('base64url') };
  const registry = Object.fromEntries(Object.entries(tokens).map(([device, token]) => [device, {
    role: device === 'bridge' ? 'bridge' : 'orchestrator', peer: device === 'bridge' ? 'orch' : 'bridge',
    token_sha256: createHash('sha256').update(token).digest('hex'),
  }]));
  const devices = path.join(dir, 'devices.json');
  await fs.writeFile(devices, JSON.stringify(registry));
  const server = spawn('python3', [path.join(__dirname, '../relay/server.py'), '--bind', '127.0.0.1', '--port', '0', '--cert', cert,
    '--key', key, '--devices', devices, '--database', path.join(dir, 'relay.db')]);
  t.after(() => server.kill());
  const lines = createInterface({ input: server.stderr });
  const [line] = await once(lines, 'line');
  const port = Number(line.match(/port=(\d+)/)?.[1]);
  assert.ok(port, line);
  const ca = await fs.readFile(cert);
  const workspace = path.join(dir, 'workspace');
  await fs.mkdir(workspace);
  const stores = [new Store(':memory:'), new Store(':memory:')];
  const image = randomBytes(140000);
  const desktop = {
    enabled: true, active: new Map(), specs: async () => [],
    call: async () => ({ success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,' + image.toString('base64') }] }),
  };
  const windows = new WindowsOperations({
    config: { stateDir: dir, workspaces: { project: {
      root: workspace, write: true, desktop: true,
      commands: { wait: [process.execPath, '-e', 'setTimeout(() => {}, 20000)'] },
    } } },
    store: stores[0], desktop,
  });
  const bridgeEndpoint = new Endpoint(stores[0], (frame) => windows.call(frame));
  const clientEndpoint = new Endpoint(stores[1], () => assert.fail('unexpected request'));
  const options = { host: '127.0.0.1', port, servername: 'localhost', ca };
  const bridge = new Relay({ ...options, deviceId: 'bridge', token: tokens.bridge, role: 'bridge' });
  const orch = new Relay({ ...options, deviceId: 'orch', token: tokens.orch, role: 'orchestrator' });
  bridgeEndpoint.attach('relay', bridge);
  clientEndpoint.attach('relay:mac', orch);
  t.after(() => { bridge.stop(); orch.stop(); });
  bridge.start();
  orch.start();
  await until(() => orch.online && bridge.online);
  const task = randomUUID();
  const files = new RemoteFiles(clientEndpoint);
  const data = randomBytes(150000);
  const stream_id = await files.upload('relay:mac', task, data);
  assert.equal(await files.upload('relay:mac', task, data, stream_id), stream_id);
  const body = { operation: 'write', workspace: 'project', path: 'test.bin', version: null, stream_id };
  const mutation = messageId();
  const result = await clientEndpoint.request('relay:mac', task, 'file.write', body, 3000, mutation);
  assert.equal(result.size, data.length);
  const fetched = await files.download('relay:mac', task, { operation: 'read', workspace: 'project', path: 'test.bin' });
  assert.deepEqual(fetched, data);
  const status = await files.call('relay:mac', task, 'task.status', { operation: 'operation_status', request_id: mutation }, 3000);
  assert.equal(status.state, 'finished');
  await assert.rejects(files.call('relay:mac', task, 'file.write', body, 3000), /version_conflict/);
  await assert.rejects(files.call('relay:mac', task, 'file.read', { operation: 'read', workspace: 'project', path: '../test.bin' }, 3000), /invalid_path/);
  const shot = await files.call('relay:mac', task, 'task.request', { operation: 'desktop', workspace: 'project', tool: 'desktop_screenshot', arguments: {} });
  const artifact = shot.contentItems[0];
  assert.deepEqual(await files.download('relay:mac', task, { operation: 'artifact', ...artifact }), image);
  const controller = new AbortController();
  const command = files.call('relay:mac', task, 'command.execute', {
    operation: 'run', workspace: 'project', command: 'wait', permission: 'development', timeout_ms: 15000,
  }, 16000, controller.signal);
  await until(() => windows.commands.size);
  const [requestId] = windows.commands.keys();
  controller.abort();
  await assert.rejects(command, /operation_cancelled/);
  await until(() => !windows.commands.size);
  const cancelled = await files.call('relay:mac', task, 'task.status', { operation: 'operation_status', request_id: requestId });
  assert.equal(cancelled.outcome.error, 'command_cancelled');
});

test('recovers a persisted pending Windows operation for reconciliation', async (t) => {
  const stateDir = await folder(t);
  // Closed in finally rather than t.after: after-hooks run in registration order, so the folder
  // would be deleted while the database is still open, which Windows refuses (EBUSY).
  const store = new Store(path.join(stateDir, 'state.db'));
  try {
  const id = randomUUID();
  const pendingRequest = messageId();
  store.saveTask({ id, state: 'testing', pendingRequest, pendingKind: 'test', steps: [] }, { state: 'testing' });
  const scheduler = new Scheduler({
    config: { stateDir }, store,
    files: { call: async (_route, _id, _kind, body) => {
      assert.equal(body.request_id, pendingRequest);
      return { state: 'finished', kind: 'result', outcome: { value: { code: 0 } } };
    } },
  });
  assert.equal(scheduler.tasks.get(id).state, 'needs_review');
  const result = await scheduler.reconcile(scheduler.tasks.get(id));
  assert.equal(result.state, 'completed');
  assert.equal(result.pendingRequest, undefined);
  } finally {
    store.close();
  }
});

test('manual route selection persists independently for each bridge', () => {
  const store = new Store(':memory:');
  try {
    const config = {
      sshBridges: ['mac'], relayBridges: { mac: {} },
      workspaces: { mac: { sshBridge: 'mac' }, windows: {} },
    };
    const scheduler = new Scheduler({ config, store, files: {} });
    assert.equal(scheduler.bridgeRoute('mac'), 'ssh:mac');
    assert.equal(scheduler.bridgeRoute('windows'), 'ssh');
    scheduler.setRoute('relay', 'mac');
    assert.equal(scheduler.bridgeRoute('mac'), 'relay:mac');
    assert.equal(scheduler.bridgeRoute('windows'), 'ssh');
    const recovered = new Scheduler({ config, store, files: {} });
    assert.equal(recovered.bridgeRoute('mac'), 'relay:mac');
    recovered.setRoute('ssh', 'mac');
    assert.equal(recovered.bridgeRoute('mac'), 'ssh:mac');
  } finally {
    store.close();
  }
});

test('a submitted task retains its selected provider and model', () => {
  const store = new Store(':memory:');
  try {
    const scheduler = new Scheduler({
      config: { workspaces: { mac: {} } },
      store,
      files: { endpoint: {} },
    });
    const id = randomUUID();
    const input = { workspace: 'mac', prompt: 'Review files', provider: 'grok', model: 'grok-build-0.1' };
    scheduler.submit(id, input);
    assert.equal(scheduler.status(id).provider, 'grok');
    assert.equal(scheduler.status(id).model, 'grok-build-0.1');
    // Claude is the lead and cannot be pinned as a task's executor.
    assert.throws(() => scheduler.submit(randomUUID(), { ...input, provider: 'claude', model: 'claude-sonnet-5-5' }), /claude_reserved/);
    assert.throws(() => scheduler.submit(id, { ...input, provider: 'codex' }), /task_id_conflict/);
    assert.throws(() => scheduler.submit(randomUUID(), { ...input, provider: undefined }), /invalid_model_selection/);
    assert.throws(() => scheduler.submit(randomUUID(), { ...input, model: '--help' }), /invalid_model_selection/);
  } finally {
    store.close();
  }
});

test('the Mac Bridge module only starts when run directly', () => {
  const bridge = require('../orchestrator/mac-bridge');
  assert.equal(typeof bridge.main, 'function');
  assert.equal(typeof bridge.createSpawnSsh, 'function');
});
