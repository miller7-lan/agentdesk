// Reports are pure functions over saved tasks so they can run on the VPS without a database query
// language. Numbers are rounded only at the edge; filtering always uses the task's recorded start.

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_review']);
const POSITIVE = new Set(['accept', 'pass', 'accept_with_risk']);
const TOKEN_KEYS = {
  input: ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'],
  output: ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'],
  cacheRead: ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cacheReadTokens'],
  cacheWrite: ['cache_creation_input_tokens', 'cacheWriteInputTokens', 'cacheWriteTokens'],
  reasoning: ['reasoning_tokens', 'reasoningTokens', 'reasoning_output_tokens'],
};

function time(value, field) {
  if (value === undefined || value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid_report_' + field);
  return parsed;
}

function taskStart(task) {
  return time(task.metrics?.startedAt ?? task.createdAt ?? task.startedAt, 'time');
}

function filterTasks(tasks, { since, until, owner, project, tag, tags } = {}) {
  const from = time(since, 'since');
  const to = time(until, 'until');
  if (from !== undefined && to !== undefined && from > to) throw new Error('invalid_report_range');
  const wantedTags = tags !== undefined ? (Array.isArray(tags) ? tags : [tags]) : tag !== undefined ? [tag] : [];
  return [...tasks].filter((task) => {
    if (owner !== undefined && (task.owner || 'local') !== owner) return false;
    if (project !== undefined && task.project !== project) return false;
    if (wantedTags.length && !wantedTags.every((value) => (task.tags || []).includes(value))) return false;
    const start = taskStart(task);
    if (from !== undefined && (start === undefined || start < from)) return false;
    if (to !== undefined && (start === undefined || start > to)) return false;
    return true;
  });
}

function acceptedTask(task) {
  if (task.metrics?.accepted !== undefined) return task.metrics.accepted === true;
  return task.state === 'completed' || POSITIVE.has(task.acceptance?.verdict);
}

function firstPassTask(task) {
  if (task.metrics?.firstPass !== undefined) return task.metrics.firstPass === true;
  return acceptedTask(task) && !(task.reworkRounds || 0) && !(task.triageRounds || 0) &&
    !(task.reviewConflicts || 0) && !(task.testFailures || 0);
}

function roleCalls(task) {
  if (task.metrics?.roleCalls) return task.metrics.roleCalls;
  const calls = {};
  for (const step of task.steps || []) {
    if (!step.role) continue;
    calls[step.role] = (calls[step.role] || 0) + (step.attempts || 1);
  }
  return calls;
}

function reassignments(task) {
  if (Number.isFinite(task.metrics?.reassignments)) return task.metrics.reassignments;
  return (task.steps || []).reduce((sum, step) => sum + (step.tried?.length || 0), 0);
}

function addNumbers(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (Number.isFinite(value)) target[key] = (target[key] || 0) + value;
  }
  return target;
}

function numericToken(source, aliases) {
  for (const key of aliases) if (Number.isFinite(source?.[key])) return source[key];
  return 0;
}

function avg(total, count) {
  return count ? Math.round((total / count) * 10) / 10 : 0;
}

// Summary of a task set. `accepted` means completed or accepted by the lead (a patch may still await a
// person's apply); successRate is accepted/count. firstPass excludes rework, triage, conflicts and tests.
function summarize(tasks, filters = {}) {
  const list = filterTasks(tasks, filters);
  const states = {};
  const roleCallsTotal = {};
  const usage = {};
  const quota = {};
  let accepted = 0;
  let firstPass = 0;
  let duration = 0;
  let durationCount = 0;
  let reworkRounds = 0;
  let triageRounds = 0;
  let testFailures = 0;
  let reviewConflicts = 0;
  let reassignmentsTotal = 0;
  for (const task of list) {
    states[task.state] = (states[task.state] || 0) + 1;
    if (acceptedTask(task)) accepted += 1;
    if (firstPassTask(task)) firstPass += 1;
    const metrics = task.metrics || {};
    const taskDuration = Number.isFinite(metrics.durationMs) ? metrics.durationMs
      : metrics.endedAt && metrics.startedAt ? time(metrics.endedAt, 'ended_at') - time(metrics.startedAt, 'started_at') : undefined;
    if (Number.isFinite(taskDuration)) {
      duration += taskDuration;
      durationCount += 1;
    }
    reworkRounds += task.reworkRounds || metrics.reworkRounds || 0;
    triageRounds += task.triageRounds || metrics.triageRounds || 0;
    testFailures += task.testFailures || metrics.testFailures || 0;
    reviewConflicts += task.reviewConflicts || metrics.reviewConflicts || 0;
    reassignmentsTotal += reassignments(task);
    for (const [role, count] of Object.entries(roleCalls(task))) {
      roleCallsTotal[role] = (roleCallsTotal[role] || 0) + count;
    }
    for (const [role, values] of Object.entries(task.usage || {})) addNumbers(usage[role] ||= {}, values);
    for (const [role, windows] of Object.entries(task.quota || {})) {
      const target = quota[role] ||= { fiveHour: 0, weekly: 0, tasks: 0 };
      target.tasks += 1;
      if (Number.isFinite(windows.fiveHour)) target.fiveHour += windows.fiveHour;
      if (Number.isFinite(windows.weekly)) target.weekly += windows.weekly;
    }
  }
  const tokens = {};
  let totalTokens = 0;
  for (const [kind, aliases] of Object.entries(TOKEN_KEYS)) {
    const value = Object.keys(usage).reduce((sum, role) => sum + numericToken(usage[role], aliases), 0);
    tokens[kind] = value;
    totalTokens += value;
  }
  tokens.total = totalTokens;
  return {
    count: list.length,
    accepted,
    firstPass,
    successRate: list.length ? Math.round((accepted / list.length) * 1000) / 1000 : 0,
    firstPassRate: list.length ? Math.round((firstPass / list.length) * 1000) / 1000 : 0,
    states,
    durationMs: { total: duration, average: avg(duration, durationCount) },
    reworkRounds,
    tasksReworked: list.filter((task) => (task.reworkRounds || task.metrics?.reworkRounds || 0) > 0).length,
    triageRounds,
    tasksTriaged: list.filter((task) => (task.triageRounds || task.metrics?.triageRounds || 0) > 0).length,
    testFailures,
    reviewConflicts,
    reassignments: reassignmentsTotal,
    roleCalls: roleCallsTotal,
    tokens,
    usage,
    quota,
  };
}

// Groups benchmark tasks by their arm. The two planned arms are always present, even when empty, so a
// comparison is never silently absent. An unrecognised arm is still reported under its own name.
function benchmark(tasks, { benchmarkId } = {}) {
  if (typeof benchmarkId !== 'string' || !benchmarkId.trim()) throw new Error('benchmark_id_required');
  const selected = [...tasks].filter((task) => task.benchmarkId === benchmarkId);
  const groups = { single: summarize([]), multi: summarize([]) };
  for (const arm of new Set(selected.map((task) => task.arm || 'unassigned'))) groups[arm] = summarize([]);
  for (const arm of Object.keys(groups)) {
    const list = selected.filter((task) => (task.arm || 'unassigned') === arm);
    groups[arm] = summarize(list);
  }
  return {
    benchmarkId,
    count: selected.length,
    groups,
    compare: {
      successRate: Math.round((groups.multi.successRate - groups.single.successRate) * 1000) / 1000,
      firstPassRate: Math.round((groups.multi.firstPassRate - groups.single.firstPassRate) * 1000) / 1000,
      averageDurationMs: groups.multi.durationMs.average - groups.single.durationMs.average,
      reworkRounds: groups.multi.reworkRounds - groups.single.reworkRounds,
      tokens: groups.multi.tokens.total - groups.single.tokens.total,
    },
  };
}

function flatten(value, prefix = '', rows = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) flatten(value[key], prefix ? prefix + '.' + key : key, rows);
  } else if (value !== undefined) {
    rows.push([prefix, Array.isArray(value) ? value.join('|') : value]);
  }
  return rows;
}

function toTable(summary) {
  const rows = summary?.groups
    ? Object.entries(summary.groups).flatMap(([arm, group]) => flatten(group, 'groups.' + arm))
    : flatten(summary);
  const width = Math.max(7, ...rows.map(([key]) => key.length));
  return ['metric'.padEnd(width) + '  value', ...rows.map(([key, value]) => key.padEnd(width) + '  ' + value)].join('\n');
}

function toCsv(summary) {
  const rows = summary?.groups
    ? Object.entries(summary.groups).flatMap(([arm, group]) => flatten(group).map(([key, value]) => ['groups.' + arm + '.' + key, value]))
    : flatten(summary);
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  return ['metric,value', ...rows.map(([key, value]) => quote(key) + ',' + quote(value))].join('\n');
}

function toJson(summary) {
  return JSON.stringify(summary, null, 2);
}

module.exports = { summarize, benchmark, toTable, toCsv, toJson, filterTasks, TERMINAL };