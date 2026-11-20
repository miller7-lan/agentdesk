const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { CommandRuns } = require('../orchestrator/command-runs');
const { RemoteFiles, WindowsOperations } = require('../orchestrator/windows');
const { commandProgress, stepActivity } = require('../orchestrator/activity');
const local = require('../local-commands');

test('direct command uses the session project and rechecks the approved program and directory', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-project-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = path.join(folder, 'project-a');
  const other = path.join(folder, 'project-b');
  const worktree = path.join(folder, 'project-a-worktree');
  await Promise.all([project, other, worktree].map((directory) => fs.mkdir(directory)));
  const configFile = path.join(folder, 'commands.json');
  const argv = [process.execPath, '-p', 'process.cwd()'];
  await fs.writeFile(configFile, JSON.stringify({ workspaces: {
    a: { root: project, agentCommands: ['verify'], commands: { verify: argv } },
    b: { root: other, agentCommands: ['verify'], commands: { verify: [process.execPath, '-p', '"wrong project"'] } },
  } }));
  const runs = new CommandRuns();
  const call = (approved) => local.call('agentdesk_command_run', { name: 'verify' },
    { configFile, localRoot: project, worktree, approved, runs });
  const rejected = await call({ cwd: project, argv });
  assert.equal(rejected.success, false);
  assert.equal(JSON.parse(rejected.contentItems[0].text).error, 'command_changed_after_approval');
  const outcome = await call({ cwd: worktree, argv });
  assert.equal(outcome.success, true);
  assert.equal(await fs.realpath(JSON.parse(outcome.contentItems[0].text).stdout.trim()), await fs.realpath(worktree));
});

test('local command streams before exit, uses the bound directory and replays the completed run', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const journal = () => path.join(folder, 'journal.json');
  const updates = [];
  const runs = new CommandRuns((scope, event) => updates.push({ scope, ...event }), journal);
  t.after(() => runs.close());
  const request = { scope: 'thread-a', key: 'turn-a-tool-1', turnId: 'turn-a', name: 'build', cwd: folder,
    argv: [process.execPath, '-e', 'console.log(process.cwd()); setTimeout(() => console.error("finished"), 400)'] };
  const done = runs.start(request);
  assert.strictEqual(runs.start(request), done);
  const [current] = runs.list('thread-a');
  assert.equal(current.state, 'running');
  assert.deepEqual(runs.list('thread-b'), []);
  assert.equal(runs.cancel('thread-b', current.id), null);
  const finished = await done;
  assert.equal(finished.code, 0);
  const realFolder = await fs.realpath(folder);
  const streamed = updates.find(({ state, stdout }) => state === 'running' && stdout.trim());
  assert.ok(streamed);
  assert.equal(await fs.realpath(streamed.stdout.trim()), realFolder);
  assert.equal(finished.stderr.trim(), 'finished');
  const reopened = new CommandRuns(undefined, journal);
  assert.deepEqual(await reopened.start(request), finished);
  assert.equal(reopened.list('thread-a')[0].id, current.id);
});

test('unknown after Bridge restart is queried by the same ID and stopping kills the child process tree', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-stop-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const journal = () => path.join(folder, 'journal.json');
  const events = new (require('node:events').EventEmitter)();
  const runs = new CommandRuns((_, run) => { if (run.stdout) events.emit('output', run); }, journal);
  t.after(() => runs.close());
  const childCode = 'console.log(process.pid); setInterval(() => {}, 1000)';
  const parentCode = 'require("node:child_process").spawn(process.execPath, ["-e", process.argv[1]], { stdio: "inherit" });' +
    'setInterval(() => {}, 1000)';
  const request = { scope: 'thread', key: 'tool', turnId: 'turn', name: 'test', cwd: folder,
    argv: [process.execPath, '-e', parentCode, childCode] };
  const output = once(events, 'output', { signal: AbortSignal.timeout(4000) });
  const done = runs.start(request);
  const [running] = await output;
  const pid = Number(running.stdout.trim());
  assert.ok(pid > 0);
  const reopened = new CommandRuns(undefined, journal);
  assert.equal((await reopened.start(request)).state, 'unknown');
  assert.equal(reopened.list('thread')[0].id, running.id);
  assert.equal(runs.cancel('thread', running.id).state, 'cancelling');
  assert.equal((await done).state, 'cancelled');
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux' && /\) Z /.test(await fs.readFile('/proc/' + pid + '/stat', 'utf8'))) return;
    } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return; throw error; }
    await delay(50);
  }
  assert.fail('command descendant still exists');
});

test('group command reconciles a lost response on the replacement route without starting it again', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-route-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const taskId = 'test-task';
  const stepId = 'build';
  const requests = [];
  await fs.mkdir(path.join(folder, 'logs', taskId), { recursive: true });
  let route = 'ssh';
  let status = 0;
  let originalId;
  const files = new RemoteFiles({
    request(channel, _task, kind, body, _timeout, id) {
      assert.equal(kind, 'command.execute');
      requests.push([channel, body.operation]);
      if (body.operation === 'run') {
        assert.equal(channel, 'ssh');
        originalId = id;
        route = 'relay';
        return new Promise(() => {});
      }
      assert.equal(channel, 'relay');
      assert.equal(body.request_id, originalId);
      return Promise.resolve({ name: 'build', sequence: ++status, cwd: folder, stdout: 'build output',
        ...(status === 1 ? { state: 'running' } : { state: 'completed', finishedAt: Date.now(), code: 0 }), stderr: '' });
    },
  });
  const record = commandProgress(folder, taskId, stepId);
  const seen = [];
  const result = await files.runCommand(() => route, taskId, {
    operation: 'run', command: 'build', timeout_ms: 300000,
  }, { onStatus(snapshot) { seen.push(snapshot.state); record(snapshot); } });
  assert.deepEqual(result, { code: 0, stdout: 'build output', stderr: '' });
  assert.ok(seen.includes('running'));
  assert.equal(requests.filter(([, op]) => op === 'run').length, 1);
  const activity = await stepActivity(folder, { id: taskId, steps: [{ id: stepId, state: 'completed' }] }, stepId);
  assert.equal(activity.items[0].location, 'local');
  assert.equal(activity.items[0].status, 'completed');
  assert.equal(activity.items[0].requestId, originalId);
});

test('group command cancelled while its workspace resolves never launches', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-pending-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const marker = path.join(folder, 'started');
  const ops = new WindowsOperations({ config: { workspaces: {
    project: { root: folder, commands: { test: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "started")', marker] } },
  } } });
  const run = ops.call({ task_id: 'task', message_id: 'req', kind: 'command.execute',
    body: { operation: 'run', workspace: 'project', permission: 'development', command: 'test', timeout_ms: 1000 } });
  const cancel = (task) => ops.call({ task_id: task, kind: 'command.execute', body: { operation: 'cancel', request_id: 'req' } });
  assert.deepEqual(await cancel('other-task'), { state: 'unknown' });
  assert.deepEqual(await cancel('task'), { state: 'cancelling' });
  await assert.rejects(run, /command_cancelled/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
