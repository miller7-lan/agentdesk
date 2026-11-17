const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, benchmark, toTable, toCsv, toJson } = require('../orchestrator/report');

function task(index, overrides = {}) {
  const arm = index < 5 ? 'single' : 'multi';
  const day = String(10 + (index % 5)).padStart(2, '0');
  return {
    id: 'task-' + index,
    state: index % 5 === 4 ? 'failed' : index % 5 === 3 ? 'needs_review' : 'completed',
    owner: index % 2 ? 'bob' : 'alice',
    project: 'agentdesk',
    tags: index % 2 ? ['ui'] : ['backend', 'tests'],
    benchmarkId: 'bench-1',
    arm,
    acceptance: index % 5 === 3 ? { verdict: 'accept' } : undefined,
    steps: [{ role: index % 2 ? 'grok' : 'codex', attempts: 2, tried: index % 3 === 0 ? ['claude'] : [] }],
    usage: { codex: { input_tokens: 100, output_tokens: 20 }, grok: { input_tokens: 10 } },
    quota: { codex: { fiveHour: 1.5, weekly: 0.5 } },
    reworkRounds: index % 4 === 0 ? 1 : 0,
    triageRounds: index % 5 === 4 ? 1 : 0,
    testFailures: index % 5 === 4 ? 2 : 0,
    reviewConflicts: index % 5 === 4 ? 1 : 0,
    metrics: {
      startedAt: '2026-11-' + day + 'T10:00:00.000Z',
      endedAt: '2026-11-' + day + 'T10:00:10.000Z',
      durationMs: 10_000,
      accepted: index % 5 < 3 || index % 5 === 3,
      firstPass: index % 5 === 0,
      roleCalls: { [index % 2 ? 'grok' : 'codex']: 2 },
      reassignments: index % 3 === 0 ? 1 : 0,
      reworkRounds: index % 4 === 0 ? 1 : 0,
      triageRounds: index % 5 === 4 ? 1 : 0,
      testFailures: index % 5 === 4 ? 2 : 0,
    },
    ...overrides,
  };
}

test('a ten-task fixture summarizes success, rework, roles, tokens and quota', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task(index));
  const summary = summarize(tasks);
  assert.equal(summary.count, 10);
  assert.equal(summary.accepted, 8);      // three completed + one accepted needs_review in each arm
  assert.equal(summary.successRate, 0.8);
  assert.equal(summary.firstPass, 2);
  assert.equal(summary.states.completed, 6);
  assert.equal(summary.states.needs_review, 2);
  assert.equal(summary.states.failed, 2);
  assert.equal(summary.reworkRounds, 3); // indexes 0, 4, 8
  assert.equal(summary.tasksReworked, 3);
  assert.equal(summary.triageRounds, 2);
  assert.equal(summary.testFailures, 4);
  assert.equal(summary.reviewConflicts, 2);
  assert.equal(summary.durationMs.total, 100_000);
  assert.equal(summary.durationMs.average, 10_000);
  assert.equal(summary.roleCalls.codex, 10);
  assert.equal(summary.roleCalls.grok, 10);
  assert.equal(summary.reassignments, 4);
  assert.equal(summary.tokens.input, 1100);
  assert.equal(summary.tokens.output, 200);
  assert.equal(summary.tokens.total, 1300);
  assert.deepEqual(summary.usage.codex, { input_tokens: 1000, output_tokens: 200 });
  assert.deepEqual(summary.quota.codex, { fiveHour: 15, weekly: 5, tasks: 10 });
});

test('reports filter by time, owner, project and tag', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task(index));
  assert.equal(summarize(tasks, { owner: 'alice' }).count, 5);
  assert.equal(summarize(tasks, { project: 'other' }).count, 0);
  assert.equal(summarize(tasks, { tag: 'ui' }).count, 5);
  assert.equal(summarize(tasks, { tags: ['ui', 'missing'] }).count, 0);
  assert.equal(summarize(tasks, { since: '2026-11-12T00:00:00.000Z' }).count, 6);
  assert.equal(summarize(tasks, { until: '2026-11-11T00:00:00.000Z' }).count, 2);
  assert.throws(() => summarize(tasks, { since: 'yesterday' }), /invalid_report_since/);
  assert.throws(() => summarize(tasks, { since: '2026-11-13T00:00:00Z', until: '2026-11-12T00:00:00Z' }),
    /invalid_report_range/);
});

test('a benchmark reports both arms and their difference', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task(index));
  const report = benchmark(tasks, { benchmarkId: 'bench-1' });
  assert.equal(report.count, 10);
  assert.equal(report.groups.single.count, 5);
  assert.equal(report.groups.multi.count, 5);
  assert.equal(report.groups.single.accepted, 4);
  assert.equal(report.groups.multi.accepted, 4);
  assert.equal(report.compare.successRate, 0);
  assert.equal(report.compare.tokens, 0);
  assert.equal(report.groups.multi.reworkRounds, 1);
  assert.throws(() => benchmark(tasks, {}), /benchmark_id_required/);
});

test('table, csv and json render the same summary', () => {
  const tasks = Array.from({ length: 10 }, (_, index) => task(index));
  const summary = summarize(tasks);
  assert.match(toTable(summary), /metric\s+value/);
  assert.match(toTable(summary), /tokens\.input\s+1100/);
  const csv = toCsv(summary);
  assert.match(csv, /^metric,value/);
  assert.match(csv, /"tokens\.input","1100"/);
  assert.doesNotThrow(() => JSON.parse(toJson(summary)));
});