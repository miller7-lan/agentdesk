// The lead (Claude) sees summaries, not transcripts. A brief keeps the plan, each step's outcome, test
// tails and the list of touched files, while never carrying raw logs, full patches or credentials.
// Every string is redacted and clipped before it leaves this module.

const MAX_BRIEF = 12 * 1024;
const STEP_OUTPUT = 600;
const MAX_PATHS = 20;
const TEST_TAIL = 2000;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted token]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|passwd|password|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    '$1[redacted]'],
];

function redact(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

// Keeps the beginning of each line, which is where a report usually states what a step did, and marks
// how much was removed. The result never exceeds max characters.
function clip(value, max = STEP_OUTPUT) {
  const text = redact(value).replace(/\r\n?/g, '\n');
  if (text.length <= max) return text;
  const marker = '\n…[' + text.length + ' chars clipped]';
  const room = Math.max(0, max - marker.length);
  let out = '';
  for (const line of text.split('\n')) {
    const candidate = out ? out + '\n' + line : line;
    if (candidate.length > room) break;
    out = candidate;
  }
  if (!out) out = text.slice(0, room);
  return (out + marker).slice(0, max);
}

// The end of a test log is where the failure is; keep it and drop the beginning.
function tail(value, max = TEST_TAIL) {
  const text = redact(value).replace(/\r\n?/g, '\n');
  if (text.length <= max) return text;
  const marker = '…[' + (text.length - max) + ' chars clipped]\n';
  const room = Math.max(0, max - marker.length);
  return marker + text.slice(-room);
}

function verdictDigest(verdict) {
  if (!verdict || typeof verdict !== 'object') return verdict;
  return {
    verdict: verdict.verdict,
    ...(verdict.summary && { summary: clip(verdict.summary, 400) }),
    ...(Array.isArray(verdict.findings) && {
      findings: verdict.findings.slice(0, 20).map((finding) => ({
        severity: finding?.severity,
        ...(finding?.file && { file: clip(finding.file, 200) }),
        ...(Number.isSafeInteger(finding?.line) && { line: finding.line }),
        ...(finding?.issue && { issue: clip(finding.issue, 240) }),
      })),
    }),
    ...(verdict.tests && { tests: clip(String(verdict.tests), 200) }),
  };
}

function stepDigest(step) {
  const paths = (step.paths || []).slice(0, MAX_PATHS).map((file) => clip(file, 240));
  return {
    id: step.id,
    role: step.role,
    ...(step.model && { model: step.model }),
    ...(step.capability && { capability: step.capability }),
    state: step.state,
    attempts: step.attempts,
    ...(step.error && { error: clip(step.error, 300) }),
    ...(step.prompt && { prompt: clip(step.prompt, 400) }),
    ...(step.output !== undefined && { output: clip(step.output, STEP_OUTPUT) }),
    ...(paths.length && { paths, pathCount: (step.paths || []).length }),
    ...(step.verdict && { verdict: verdictDigest(step.verdict) }),
  };
}

function reviewDigest(task) {
  if (task.reviews && typeof task.reviews === 'object') {
    return Object.entries(task.reviews).slice(-20).map(([stepId, verdict]) => ({ stepId, ...verdictDigest(verdict) }));
  }
  return task.steps.filter((step) => ['review', 'accept'].includes(step.capability)).map((step) => ({
    stepId: step.id, role: step.role, ...(step.verdict ? verdictDigest(step.verdict) : { output: clip(step.output, 500) }),
  }));
}

function diffStat(task) {
  const files = new Set();
  const writers = task.steps.filter((step) => step.write);
  for (const step of writers) for (const file of step.paths || []) files.add(file);
  return {
    fileCount: files.size,
    files: [...files].slice(0, MAX_PATHS).map((file) => clip(file, 240)),
    ...(files.size > MAX_PATHS && { truncated: files.size - MAX_PATHS }),
    steps: writers.map((step) => ({ id: step.id, role: step.role, files: (step.paths || []).length })),
  };
}

function testDigest(result) {
  if (!result || typeof result !== 'object') return { status: 'not_run_pre_apply' };
  return {
    status: result.code === 0 ? 'passed' : 'failed',
    ...(Number.isFinite(result.code) && { code: result.code }),
    ...(result.signal && { signal: clip(result.signal, 80) }),
    ...(result.timedOut && { timedOut: true }),
    ...(result.stdout && { stdoutTail: tail(result.stdout, 1400) }),
    ...(result.stderr && { stderrTail: tail(result.stderr, 600) }),
  };
}

function taskFacts(task) {
  return {
    id: task.id,
    ...(task.owner && { owner: task.owner }),
    ...(task.project && { project: task.project }),
    ...(Array.isArray(task.tags) && task.tags.length && { tags: task.tags.slice(0, 12) }),
    request: clip(task.prompt, 1200),
    state: task.state,
    detail: task.detail,
    ...(task.stage && { stage: task.stage }),
  };
}

function plannedSteps(task) {
  return task.steps.map((step) => ({
    id: step.id, role: step.role, ...(step.capability && { capability: step.capability }),
    prompt: clip(step.prompt, 300), dependsOn: step.dependsOn,
  }));
}

function buildAcceptanceBrief(task, options = {}) {
  const brief = {
    kind: 'acceptance',
    task: taskFacts(task),
    plan: plannedSteps(task),
    steps: task.steps.map(stepDigest),
    reviews: reviewDigest(task),
    tests: testDigest(task.testResult),
    ...(task.isolatedTest?.code === 0 && { windowsBuild: {
      version: task.isolatedTest.version, command: task.isolatedTest.command,
      artifacts: (task.isolatedTest.artifacts || []).map(({ name, sha256 }) => ({ name, sha256 })),
    } }),
    diff: diffStat(task),
    rules: [
      'Judge the summarised results against the request and the plan.',
      'Writer tests have not run on the target before apply; report tests as not_run_pre_apply unless a test result is shown.',
      'Do not run commands or touch files. Return the JSON verdict requested in the prompt.',
    ],
    ...(options.reason && { reason: clip(options.reason, 400) }),
  };
  return fitBrief(brief);
}

function buildTriageBrief(task, reason) {
  const brief = {
    ...buildAcceptanceBrief(task),
    kind: 'triage',
    reason: clip(reason || task.escalation?.reason || 'unknown', 400),
    failures: {
      count: task.testFailures || 0,
      last: task.lastTestFailure ? clip(task.lastTestFailure, 600) : undefined,
      reviewConflicts: task.reviewConflicts || 0,
      reworkRounds: task.reworkRounds || 0,
      triageRounds: task.triageRounds || 0,
      ...(task.lastStepFailure && { steps: task.lastStepFailure }),
    },
    ...(task.lastStepFailure && task.reassignOptions && { reassignOptions: task.reassignOptions }),
  };
  return fitBrief(brief);
}

// Used by future lead-only steps that need the same facts but do not fit acceptance or triage.
function buildLeadBrief(task, stage = 'lead') {
  return fitBrief({ kind: stage, task: taskFacts(task), plan: plannedSteps(task), steps: task.steps.map(stepDigest),
    reviews: reviewDigest(task), tests: testDigest(task.testResult), diff: diffStat(task) });
}

function buildPlannerBrief(task) {
  return fitBrief({ kind: 'planning', task: taskFacts(task), previous: task.briefs?.planning || undefined });
}

// Keeps a project context short enough for a planner or triage call: counts, recent requests and states,
// never step output. `project` may be the project ID or a record with a name.
function compactProject(project, tasks = []) {
  const name = typeof project === 'string' ? project : project?.name || project?.id || 'project';
  const counts = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  const recent = tasks.slice(-20).map((task) => ({
    id: task.id,
    state: task.state,
    detail: task.detail,
    request: clip(task.prompt, 200),
    ...(Array.isArray(task.tags) && task.tags.length && { tags: task.tags.slice(0, 8) }),
  }));
  return fitBrief({ kind: 'project', project: name, taskCount: tasks.length, counts, recent });
}

// Shortens a brief until it fits the budget. The fallback still carries the request and one line per
// step, so a very large task is never silently sent as an empty brief.
function fitBrief(brief) {
  if (JSON.stringify(brief).length <= MAX_BRIEF) return brief;
  const copy = structuredClone(brief);
  for (const [output, prompt] of [[300, 150], [120, 100], [60, 80]]) {
    for (const step of copy.steps || []) {
      if (step.output !== undefined) step.output = clip(step.output, output);
      if (step.prompt !== undefined) step.prompt = clip(step.prompt, prompt);
    }
    for (const item of copy.recent || []) item.request = clip(item.request, 120);
    if (JSON.stringify(copy).length <= MAX_BRIEF) return copy;
  }
  for (const step of copy.steps || []) {
    delete step.output;
    delete step.prompt;
    delete step.error;
  }
  for (const item of copy.reviews || []) delete item.findings;
  if (copy.tests?.stdoutTail) copy.tests.stdoutTail = tail(copy.tests.stdoutTail, 400);
  if (copy.tests?.stderrTail) copy.tests.stderrTail = tail(copy.tests.stderrTail, 200);
  if (JSON.stringify(copy).length <= MAX_BRIEF) return copy;
  return {
    kind: copy.kind,
    ...(copy.task && { task: { id: copy.task.id, request: clip(copy.task.request, 400), state: copy.task.state } }),
    steps: (copy.steps || []).slice(0, 12).map((step) => ({ id: step.id, role: step.role, state: step.state,
      ...(step.paths && { paths: step.paths.slice(0, 5) }) })),
    truncated: true,
  };
}

module.exports = {
  MAX_BRIEF, STEP_OUTPUT, MAX_PATHS, TEST_TAIL,
  redact, clip, tail, stepDigest, reviewDigest, diffStat, testDigest,
  compactProject, buildPlannerBrief, buildAcceptanceBrief, buildTriageBrief, buildLeadBrief, fitBrief,
};
