const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');
const {
  MAX_BRIEF, clip, tail, redact, buildAcceptanceBrief, buildTriageBrief, buildLeadBrief, compactProject,
  stepDigest,
} = require('../orchestrator/summary');

const adapters = (...names) => Object.fromEntries(names.map((name) => [name, { bin: name, env: {} }]));

function task(steps) {
  return {
    id: randomUUID(), workspace: 'mac', prompt: 'Add a pause button to the player', state: 'running', detail: 'patches_ready',
    owner: 'alice', project: 'agentdesk', tags: ['ui'],
    steps: steps || [
      { id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'completed', attempts: 1,
        prompt: 'Change the player', output: 'A'.repeat(10_000), paths: ['src/player.js', 'src/player.css'] },
      { id: 'review', role: 'grok', capability: 'review', state: 'completed', attempts: 1,
        prompt: 'Review the player', output: 'Looks fine', paths: [], verdict: { verdict: 'pass', summary: 'Small, clear change' } },
    ],
  };
}

test('clip keeps line beginnings, redacts credentials and never exceeds its limit', () => {
  const raw = 'first line\nsecond line\n' + 'x'.repeat(5000);
  const clipped = clip(raw, 120);
  assert.ok(clipped.length <= 120);
  assert.match(clipped, /^first line\nsecond line/);
  assert.match(clipped, /chars clipped/);

  const text = redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\nAuthorization: Bearer abcdefghijklmnop\npassword=hunter22');
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /Bearer abcdefghijklmnop/);
  assert.doesNotMatch(text, /hunter22/);
  assert.match(text, /\[redacted/);
});

test('tail keeps the end of a test log within the limit', () => {
  const log = 'early noise\n' + 'middle\n'.repeat(1000) + 'FAIL expected 2 got 3\n';
  const out = tail(log, 200);
  assert.ok(out.length <= 200);
  assert.match(out, /FAIL expected 2 got 3/);
  assert.doesNotMatch(out, /early noise/);
});

test('an acceptance brief carries summaries, tests and paths but never the raw output or its secret', () => {
  const original = task();
  original.steps[0].output = 'A'.repeat(9000) + '\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n' + 'B'.repeat(1000);
  original.steps[0].paths = Array.from({ length: 30 }, (_, index) => 'src/file-' + index + '.js');
  original.testResult = { code: 1, stdout: 'noise\n'.repeat(1000) + 'FAIL at the end\n', stderr: '' };
  original.testFailures = 2;
  original.lastTestFailure = 'windows_test_failed';
  original.reviewConflicts = 1;

  const acceptance = buildAcceptanceBrief(original);
  const text = JSON.stringify(acceptance);
  assert.ok(text.length <= MAX_BRIEF);
  assert.match(text, /Add a pause button/);
  assert.doesNotMatch(text, /A{1000}/);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /B{1000}/);
  assert.match(text, /FAIL at the end/);
  assert.equal(acceptance.steps[0].output.length <= 600, true);
  assert.equal(acceptance.steps[0].paths.length, 20);
  assert.equal(acceptance.steps[0].pathCount, 30);
  assert.equal(acceptance.tests.status, 'failed');
  assert.equal(acceptance.diff.fileCount, 30);

  const triage = buildTriageBrief(original, 'review_conflict');
  assert.equal(triage.kind, 'triage');
  assert.equal(triage.reason, 'review_conflict');
  assert.deepEqual([triage.failures.count, triage.failures.reviewConflicts], [2, 1]);

  original.testResult = undefined;
  assert.equal(buildAcceptanceBrief(original).tests.status, 'not_run_pre_apply');
});

test('a brief stays under 12 KB even when every step produced a large output', () => {
  const steps = Array.from({ length: 12 }, (_, index) => ({
    id: 'step-' + index, role: 'codex', capability: index === 0 ? 'implement' : 'scout', write: index === 0,
    state: 'completed', attempts: 1, prompt: 'P'.repeat(2000), output: 'O'.repeat(20_000),
    paths: Array.from({ length: 40 }, (_, file) => 'src/' + index + '/' + file + '.js'),
  }));
  const brief = buildLeadBrief(task(steps), 'lead');
  assert.ok(JSON.stringify(brief).length <= MAX_BRIEF);
  assert.ok(brief.steps.length <= 12);
});

test('compactProject keeps counts and short requests, not step output', () => {
  const tasks = Array.from({ length: 40 }, (_, index) => ({
    id: randomUUID(), state: index % 2 ? 'completed' : 'failed', detail: 'detail-' + index,
    prompt: 'request ' + index + ' ' + 'Q'.repeat(500), output: 'NOT INCLUDED',
  }));
  const brief = compactProject({ id: 'agentdesk', name: 'AgentDesk' }, tasks);
  const text = JSON.stringify(brief);
  assert.ok(text.length <= MAX_BRIEF);
  assert.equal(brief.project, 'AgentDesk');
  assert.equal(brief.taskCount, 40);
  assert.equal(brief.recent.length, 20);
  assert.doesNotMatch(text, /NOT INCLUDED/);
  assert.ok(brief.recent.every((item) => item.request.length <= 200));
});

test('a step marked usesBrief receives a summary, not upstream raw output', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-brief-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  const mirror = path.join(dir, 'mirror.git');
  await fs.mkdir(workspace);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(workspace, 'init');
  await fs.writeFile(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--bare', workspace, mirror);

  const store = new Store(':memory:');
  t.after(() => store.close());
  let captured;
  const adapter = async ({ prompt }) => {
    captured = prompt;
    return { output: '{"verdict":"accept"}' };
  };
  const scheduler = new Scheduler({
    config: { stateDir: dir, quota: false, adapters: adapters('codex', 'claude'), workspaces: { mac: { repository: mirror } } },
    store, files: { endpoint: {} }, adapter,
  });
  const original = task();
  original.base = head;
  original.steps[1].state = 'completed';
  original.steps.push({
    id: 'accept', role: 'claude', capability: 'accept', write: false, usesBrief: true, state: 'queued',
    attempts: 0, dependsOn: ['edit', 'review'], prompt: 'Judge the work and return the JSON verdict.',
  });
  await scheduler.run(original, new AbortController().signal);

  assert.match(captured, /Judge the work/);
  assert.match(captured, /Brief \(summaries only/);
  assert.doesNotMatch(captured, /Upstream results/);
  assert.doesNotMatch(captured, /A{1000}/);
  assert.match(captured, /A{500}/);
  assert.ok(original.briefs.acceptance);
  assert.ok(JSON.stringify(original.briefs.acceptance).length <= MAX_BRIEF);
  assert.equal(stepDigest(original.steps[0]).output.length <= 600, true);
});