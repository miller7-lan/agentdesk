const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');
const { WindowsOperations, RemoteFiles } = require('../orchestrator/windows');
const { decodeSnapshot } = require('../orchestrator/test-snapshot');

function setup(t, replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(workspace, 'init', '-q');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '-q', '--bare', workspace, path.join(dir, 'mirror.git'));
  const prompts = [];
  const mcps = [];
  const capabilities = new Map();
  const scheduler = new Scheduler({
    config: {
      stateDir: dir, quota: false, acceptance: { mode: 'off' },
      adapters: Object.fromEntries(['codex', 'claude', 'grok'].map((name) => [name, { bin: name, env: {} }])),
      workspaces: { mac: { repository: path.join(dir, 'mirror.git') } },
      mcp: { socket: path.join(dir, 'mcp.sock'), capabilities },
    },
    store: new Store(':memory:'),
    files: { endpoint: {} },
    adapter: async (options) => {
      const { name, prompt, mcp } = options;
      prompts.push(prompt);
      if (mcp) {
        const scope = capabilities.get(mcp.capability);
        mcps.push({ name, runCommands: scope?.runCommands, readAnyFolder: scope?.readAnyFolder });
      }
      const reply = replies.shift();
      if (typeof reply === 'function') return reply(options);
      if (reply instanceof Error) throw reply;
      return { output: reply ?? '' };
    },
  });
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'move my desktop project into the repo' }, true);
  task.groupPlan.base = head;
  return { scheduler, task, prompts, mcps, workspace, git, head };
}

test('a lead reply with text around fenced JSON and long questions still becomes questions', async (t) => {
  const long = '你 Mac 桌面上的目录我们这边读不到，也写不进去：' + '说明'.repeat(300);
  const { scheduler, task, prompts, mcps } = setup(t, [
    '我先看了一下仓库。\n```json\n' + JSON.stringify({ questions: [long, '客户端是哪几个？'] }) + '\n```\n以上。',
  ]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_details');
  assert.equal(task.detail, 'plan_questions');
  const round = task.groupPlan.rounds.at(-1);
  assert.equal(round.questions.length, 2);
  assert.ok(round.questions[0].length <= 1200);
  // The lead can read the person's computer while planning, but never run commands there.
  assert.match(prompts[0], /windows_list_locations/);
  assert.deepEqual(mcps, [{ name: 'claude', runCommands: false, readAnyFolder: true }]);
});

test('a reply that cannot be used is sent back once, then becomes a question the person can answer', async (t) => {
  const { scheduler, task, prompts } = setup(t, ['好的，我来规划。', '还是一段话。',
    JSON.stringify({ summary: '按方案修改', steps: [{ id: 'edit', capability: 'implement', prompt: 'do it', dependsOn: [] }] })]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /could not be used/);
  assert.equal(task.state, 'awaiting_details');
  assert.equal(task.detail, 'plan_failed');
  assert.match(task.groupPlan.rounds.at(-1).questions[0], /没能整理成问题或方案/);

  // Answering in the same conversation plans again; this time the lead returns a plan.
  scheduler.updatePlan(task, { operation: 'plan_reply', revision: task.groupPlan.rounds.at(-1).revision, reply: '重试' });
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_approval');
  assert.equal(task.groupPlan.rounds.at(-1).summary, '按方案修改');
});

test('a CLI error while planning is explained to the person instead of failing the task', async (t) => {
  const { scheduler, task } = setup(t, [new Error('cli_exit_1')]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_details');
  assert.match(task.groupPlan.rounds.at(-1).questions[0], /规划出错了：cli_exit_1/);
});

test('a new group pins the working project, resumes a stalled writer and checks the version on apply', async (t) => {
  let writerModel;
  const content = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8').replace(/\r\n/g, '\n');
  const { scheduler, task, workspace, git, head, mcps } = setup(t, [
    ({ cwd, mcp }) => {
      // The lead reads the project from the snapshot and keeps read tools for files outside it only.
      assert.equal(mcp.scope, 'files');
      assert.equal(content(cwd, 'README.md'), 'working\n');
      assert.equal(content(cwd, '加入.txt'), 'new\n');
      // New files come along unless .gitignore excludes them; secret-looking files never do.
      assert.equal(content(cwd, 'private.txt'), 'untracked\n');
      assert.equal(fs.existsSync(path.join(cwd, 'build.log')), false);
      assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
      return { output: JSON.stringify({ summary: '修改项目', steps: [
        { id: 'edit', capability: 'implement', prompt: 'edit readme' },
      ] }) };
    },
    ({ cwd, model, onSession }) => {
      writerModel = model;
      fs.writeFileSync(path.join(cwd, 'README.md'), 'working\nagent\n');
      onSession('writer-session');
      throw new Error('cli_stalled: quiet');
    },
    ({ cwd, model, session, prompt }) => {
      assert.equal(session, 'writer-session');
      assert.equal(model, writerModel);
      assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), 'working\nagent\n');
      assert.match(prompt, /Continue only unfinished work/);
      return { output: 'done' };
    },
  ]);
  delete task.groupPlan.base;
  const readme = path.join(workspace, 'README.md');
  fs.writeFileSync(readme, 'staged\n');
  git(workspace, 'add', 'README.md');
  fs.writeFileSync(readme, 'working\n');
  fs.writeFileSync(path.join(workspace, '加入.txt'), 'new\n');
  git(workspace, 'add', '-N', '加入.txt');
  fs.writeFileSync(path.join(workspace, 'private.txt'), 'untracked\n');
  fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'build.log\n');
  fs.writeFileSync(path.join(workspace, 'build.log'), 'ignored\n');
  fs.writeFileSync(path.join(workspace, '.env'), 'TOKEN=secret\n');
  const bridge = new WindowsOperations({ store: scheduler.store,
    config: { stateDir: path.join(path.dirname(workspace), 'bridge'), workspaces: { mac: { root: workspace, write: true } } } });
  scheduler.files = new RemoteFiles({ request: (_route, taskId, kind, body, _timeout, requestId) =>
    bridge.call({ task_id: taskId, kind, body, id: requestId }) });
  const signal = new AbortController().signal;
  await scheduler.run(task, signal);
  assert.equal(task.state, 'awaiting_approval', JSON.stringify(task.groupPlan.rounds.at(-1)));
  assert.equal(task.snapshot.head, head);
  assert.deepEqual(task.snapshotSkipped, ['.env']);
  assert.notEqual(task.snapshot.base, head);
  scheduler.approveRound(task, task.groupPlan.rounds.at(-1));
  await scheduler.run(task, signal);
  // Only the lead's planning had the (read, outside the project) tools; the writer worked on the snapshot alone.
  assert.deepEqual(mcps.map((entry) => entry.name), ['claude']);
  assert.equal(task.steps[0].state, 'completed');
  assert.equal(task.steps[0].attempts, 2);
  const checkpoint = task.steps[0].checkpoint;
  assert.equal(checkpoint.base, task.snapshot.base);
  assert.equal(checkpoint.head, task.snapshot.base);
  assert.equal(checkpoint.session, 'writer-session');
  assert.deepEqual(checkpoint.changedFiles, ['README.md']);
  assert.match(checkpoint.trackedDiffHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(task.cliCalls.filter((call) => call.stepId === 'edit').map((call) => [call.result, call.resumed]), [
    ['failed', false], ['completed', true],
  ]);
  assert.equal(task.detail, 'patches_ready');
  assert.equal(fs.readFileSync(readme, 'utf8'), 'working\n');
  const delta = fs.readFileSync(path.join(scheduler.config.stateDir, 'worktrees', task.id, 'edit.patch'));
  fs.appendFileSync(readme, 'changed after planning\n');
  await assert.rejects(scheduler.files.patch('unused', task.id, 'mac', task.snapshot.head,
    delta, randomUUID(), signal, task.snapshot.version), /plan_workspace_changed/);
  assert.equal(fs.readFileSync(readme, 'utf8'), 'working\nchanged after planning\n');
  fs.writeFileSync(readme, 'working\n');
  await scheduler.apply(task);
  assert.equal(task.state, 'completed');
  assert.equal(content(workspace, 'README.md'), 'working\nagent\n');
  assert.equal(git(workspace, 'show', ':README.md'), 'staged');
  assert.equal(fs.readFileSync(path.join(workspace, 'private.txt'), 'utf8'), 'untracked\n');
});

test('restart keeps an interrupted local operation for verification and never queues it again', async (t) => {
  const { scheduler, task, head } = setup(t, []);
  task.state = 'running';
  task.snapshot = { base: head };
  task.steps = [{ id: 'edit', role: 'codex', capability: 'implement', write: true, localTools: 'commands',
    state: 'running', session: 'original-session' }];
  task.cliCalls = [{
    id: randomUUID(), stepId: 'edit', provider: 'codex', result: 'running', startedAt: '2026-11-20T00:00:00Z',
  }];
  scheduler.store.put('tasks', task.id, task);
  const restarted = new Scheduler({ config: scheduler.config, store: scheduler.store, files: scheduler.files });
  const restored = restarted.tasks.get(task.id);
  assert.equal(restored.state, 'needs_review');
  assert.equal(restored.detail, 'local_operation_unknown');
  assert.equal(restored.steps[0].session, 'original-session');
  assert.equal(restored.cliCalls[0].result, 'interrupted');
  assert.equal(restored.cliCalls[0].failureCode, 'service_restarted');
  assert.equal(restored.cliCalls[0].endedAt, undefined);
  await assert.rejects(restarted.apply(restored), /patch_not_applicable/);
});

test('acceptance rework keeps the original writer session for a fixed snapshot', (t) => {
  const { scheduler, task, head } = setup(t, []);
  task.snapshot = { base: head };
  task.steps = [{ id: 'edit', role: 'codex', capability: 'implement', write: true,
    paths: ['README.md'], state: 'completed', session: 'writer-1' }];
  assert.equal(scheduler.appendRework(task, { summary: 'fix the failure' }), 'rework');
  assert.equal(task.steps[1].role, 'codex');
  assert.equal(task.steps[1].reworkOf, 'edit');
  assert.equal(task.steps[1].session, 'writer-1');
});

test('a group builds an isolated Windows project and syncs only the first repair before applying', async (t) => {
  const compiler = process.platform === 'win32' && path.join(process.env.SystemRoot,
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compileExe = Boolean(compiler && fs.existsSync(compiler));
  const artifactName = compileExe ? 'build.exe' : 'build.bin';
  const { scheduler, task, workspace, git } = setup(t, [
    JSON.stringify({ summary: 'build it', steps: [{ id: 'edit', capability: 'implement', prompt: 'edit source' }] }),
    ({ cwd, onSession }) => {
      fs.writeFileSync(path.join(cwd, 'marker.txt'), 'FAIL');
      fs.writeFileSync(path.join(cwd, 'payload.bin'), Buffer.from([0, 1, 2, 255]));
      if (compileExe) fs.writeFileSync(path.join(cwd, 'Program.cs'), 'invalid C#');
      onSession('build-writer');
      return { output: 'first draft' };
    },
    ({ cwd, session, prompt }) => {
      assert.equal(session, 'build-writer');
      assert.match(prompt, /Windows test failed/);
      fs.writeFileSync(path.join(cwd, 'marker.txt'), 'PASS');
      if (compileExe) fs.writeFileSync(path.join(cwd, 'Program.cs'),
        'class Program { static void Main() { System.Console.WriteLine("ISOLATED_EXE_OK"); } }');
      return { output: 'repaired' };
    },
    ({ name, prompt }) => {
      assert.equal(name, 'claude');
      assert.match(prompt, /"windowsBuild":/);
      assert.match(prompt, /"code":0/);
      return { output: JSON.stringify({ verdict: 'accept', summary: 'verified', findings: [] }) };
    },
  ]);
  const stateDir = path.join(path.dirname(workspace), 'bridge-state');
  fs.mkdirSync(stateDir);
  delete task.groupPlan.base;
  task.command = 'compile-fixture';
  scheduler.config.workspaces.mac.isolatedTests = [task.command];
  const spec = {
    runner: compileExe ? [process.execPath, '-e', [
      "const {spawnSync}=require('node:child_process'), path=require('node:path');",
      "const build=spawnSync(process.argv[1],['/nologo','/out:build.exe','Program.cs'],{stdio:'inherit'});",
      "if(build.status!==0)process.exit(build.status||1);",
      "const app=spawnSync(path.resolve('build.exe'),[],{encoding:'utf8'});",
      "if(app.status!==0||app.stdout.trim()!=='ISOLATED_EXE_OK')process.exit(2);",
      "console.log(app.stdout.trim());",
    ].join('\n'), compiler] :
      [process.execPath, '-e', "const fs=require('node:fs'); if(fs.readFileSync('marker.txt','utf8')!=='PASS')process.exit(3); fs.writeFileSync('build.bin',fs.readFileSync('payload.bin'));"],
    artifacts: [artifactName],
  };
  const bridge = new WindowsOperations({ store: scheduler.store,
    config: { stateDir, workspaces: { mac: { root: workspace, write: true, isolatedCommands: { [task.command]: spec } } } } });
  const tested = [];
  const syncs = [];
  scheduler.files = new RemoteFiles({ request: async (_route, taskId, kind, body, _timeout, requestId) => {
    if (body.operation === 'isolated_test_sync') syncs.push(decodeSnapshot(fs.readFileSync(bridge.streamPath(body.stream_id))));
    if (body.operation === 'run_isolated_test') tested.push(body.version);
    return bridge.call({ task_id: taskId, kind, body, message_id: requestId });
  } });
  const signal = new AbortController().signal;
  await scheduler.run(task, signal);
  assert.equal(task.state, 'awaiting_approval', JSON.stringify(task.groupPlan.rounds.at(-1)));
  scheduler.approveRound(task, task.groupPlan.rounds.at(-1));
  await scheduler.run(task, signal);
  assert.equal(task.detail, 'patches_ready');
  assert.equal(task.acceptance.verdict, 'accept');
  assert.equal(tested.length, 2);
  assert.equal(syncs[0].previous, null);
  assert.equal(syncs[1].previous, tested[0]);
  assert.deepEqual([...syncs[1].files.keys()], compileExe ? ['Program.cs', 'marker.txt'] : ['marker.txt']);
  assert.equal(task.isolatedTest.version, tested[1]);
  const [artifact] = task.isolatedTest.artifacts;
  const artifactRef = 'build:' + artifact.stream_id;
  const control = (body) => scheduler.control({ task_id: task.id, kind: 'task.status', body }, 'admin');
  assert.equal(control({ operation: 'task_artifacts', artifact: artifactRef }).version, tested[1]);
  assert.equal((await control({ operation: 'task_artifacts', artifact: artifactRef, offset: 0 })).offset, 0);
  const bytes = await scheduler.files.download('fixture', task.id, { operation: 'artifact', ...artifact }, signal);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  if (compileExe) {
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    assert.equal(bytes.subarray(bytes.readUInt32LE(60), bytes.readUInt32LE(60) + 4).toString(), 'PE\0\0');
    assert.match(task.isolatedTest.stdout, /ISOLATED_EXE_OK/);
    t.diagnostic('Windows C# compiler produced a verified native executable');
  } else assert.deepEqual(bytes, Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.existsSync(path.join(workspace, 'marker.txt')), false);
  assert.equal(git(workspace, 'status', '--porcelain'), '');
  await scheduler.apply(task);
  assert.equal(task.state, 'completed');
  assert.equal(fs.readFileSync(path.join(workspace, 'marker.txt'), 'utf8'), 'PASS');
  assert.equal(tested.length, 2);
  assert.equal(fs.existsSync(path.join(workspace, artifactName)), false);
});

test('a local commit VPS2 does not have yet is brought over from the Bridge as a bundle, without a manual push', async (t) => {
  const { scheduler, task, workspace, git } = setup(t, [
    ({ cwd }) => {
      assert.equal(fs.readFileSync(path.join(cwd, 'only-local.txt'), 'utf8'), 'committed here\n');
      return { output: JSON.stringify({ questions: ['好的？'] }) };
    },
  ]);
  delete task.groupPlan.base;
  fs.writeFileSync(path.join(workspace, 'only-local.txt'), 'committed here\n');
  git(workspace, 'add', 'only-local.txt');
  git(workspace, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'local only');
  const local = git(workspace, 'rev-parse', 'HEAD');
  const bridge = new WindowsOperations({ store: scheduler.store,
    config: { stateDir: path.join(path.dirname(workspace), 'bridge'), workspaces: { mac: { root: workspace, write: true } } } });
  scheduler.files = new RemoteFiles({ request: (_route, taskId, kind, body, _timeout, requestId) =>
    bridge.call({ task_id: taskId, kind, body, id: requestId }) });
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.snapshot.head, local);
  assert.equal(task.state, 'awaiting_details');
  assert.ok(scheduler.store.events(task.id).some((event) => String(event.detail).startsWith('mirror_synced:' + local.slice(0, 12))));
});

test('群聊在已启用的盘符交付，返工继承权限并校验写入回执', async (t) => {
  const { scheduler, task } = setup(t, []);
  scheduler.config.workspaces.mac.groupLocalDrives = ['C', 'D'];
  scheduler.config.workspaces.mac.deliveryDesktop = 'C:/Users/test/Desktop';
  task.snapshot = { base: 'snapshot' };
  for (const drive of ['C', 'D']) {
    const target = drive + ':/Reports/results.md';
    task.prompt = '把报告写入 ' + target;
    const step = { id: 'report', write: true, role: 'codex', capability: 'implement', prompt: task.prompt, outputPath: target };
    scheduler.bindLocalAccess(task, step);
    assert.equal(step.localTools, 'files');
    assert.deepEqual(step.localDrives, ['C', 'D']);
    assert.equal(step.deliveryTarget, path.win32.normalize(target));
    await scheduler.collectDeliveries(task, step);
    assert.match(step.writeFailure, /missing_delivery_receipt/);
    const dir = path.join(scheduler.config.stateDir, 'logs', task.id);
    fs.mkdirSync(dir, { recursive: true });
    const receipt = { operation: 'write', root: 'computer', path: step.deliveryTarget, ok: true };
    fs.writeFileSync(path.join(dir, 'report.receipts.jsonl'), JSON.stringify(receipt));
    await scheduler.collectDeliveries(task, step);
    assert.equal(step.writeFailure, undefined);
    task.steps = [step];
    scheduler.appendRework(task, { summary: '补充验收结果' });
    assert.equal(task.steps[1].deliveryTarget, step.deliveryTarget);
    assert.deepEqual(task.steps[1].localDrives, step.localDrives);
  }
  task.prompt = '保存到桌面';
  const desktop = { prompt: '生成桌面报告', desktopOutput: '报告.md', write: true };
  scheduler.bindLocalAccess(task, desktop);
  assert.equal(desktop.deliveryTarget, path.win32.normalize('C:/Users/test/Desktop/报告.md'));
  const repo = { prompt: '修改工作树里的源代码', write: true };
  scheduler.bindLocalAccess(task, repo);
  assert.equal(repo.localTools, undefined);
});

test('group delivery reconciles the Bridge journal without repeating a mutation', async (t) => {
  const { scheduler, task } = setup(t, []);
  const step = { id: 'delivery', deliveryTarget: 'D:/REPORT.md' };
  const dir = path.join(scheduler.config.stateDir, 'logs', task.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'delivery.receipts.jsonl');
  const pending = { requestId: 'request', index: 0, phase: 'pending', operation: 'write', root: 'computer', path: 'd:/report.md', ok: false };
  fs.writeFileSync(file, JSON.stringify(pending) + '\n');
  scheduler.files.call = async (_route, _task, kind, body) => {
    assert.equal(kind, 'task.status');
    assert.equal(body.request_id, 'request');
    return { state: 'finished', kind: 'result', outcome: { value: { version: 'v' } } };
  };
  await scheduler.collectDeliveries(task, step);
  assert.equal(step.writeFailure, undefined);
  scheduler.files.call = () => assert.fail('already reconciled');
  await scheduler.collectDeliveries(task, step);
  assert.equal(step.deliveries.length, 1);
  fs.appendFileSync(file, JSON.stringify({ operation: 'move', path: 'D:/a', destination: 'D:/b', ok: false, error: 'version_conflict' }) + '\n');
  await scheduler.collectDeliveries(task, step);
  assert.match(step.writeFailure, /version_conflict/);
});
