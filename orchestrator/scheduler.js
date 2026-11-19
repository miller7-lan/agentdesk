const { mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { messageId } = require('./transport');
const { runAdapter, addUsage, EFFORTS, effortsFor } = require('./adapters');
const { Router, CAPABILITIES, ROLES, LEAD_ROLE, LEAD_CAPABILITIES, usedPercent } = require('./routing');
const { git, worktree, patchFor } = require('./git');
const { modelId, plannerProfiles, newestFirst, preferredModel } = require('./model-profiles');
const { refreshModelCatalog } = require('./model-catalog');
const { validAttachments, attachmentNote } = require('./attachments');
const { writeTextCopy } = require('./extract');
const { quotaStatus } = require('./quotas');
const { teamAdapter } = require('./team');
const { cleanup, retention, historyCandidates } = require('./cleanup');
const { taskPatch, taskOutput, MAX_PATCH } = require('./task-output');
const { stepActivity } = require('./activity');
const { hostResources } = require('./host-resources');
const { buildAcceptanceBrief, buildTriageBrief, buildLeadBrief, compactProject, clip } = require('./summary');
const {
  REVIEW_INSTRUCTION, ACCEPTANCE_INSTRUCTION, parseReviewVerdict, reviewConflicts, mergeFindings,
} = require('./review');
const { TRIAGE_INSTRUCTION, parseTriageDecision } = require('./triage');
const { summarize, benchmark, toTable, toCsv } = require('./report');
const { validateOwnerCaps, allow: ownerAllow, nextReset, ownerUsageReport } = require('./ledger');

const roles = ['codex', 'claude', 'grok', 'gemini'];
const MAX_TRIAGE = 2;
// A planned step that fails goes back to the lead, who reassigns it (another member or model) or replans it.
// Each step may be handed back at most this many times; a replacement step inherits the count.
const MAX_REASSIGN = 3;
const taskModes = new Set(['normal', 'chat', 'duo', 'team', 'review_only', 'edit']);
const readOnlyMode = (mode) => mode === 'chat' || mode === 'review_only';
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const teamTimeout = 40 * 60_000;
// A single CLI turn may run this long before the session is continued. The stall watchdog still stops a CLI
// that writes nothing for 10 minutes, so a longer turn limit does not leave a hung process running forever.
const defaultCliTimeoutMs = 45 * 60_000;

const CAPABILITY_GUIDE = [
  'Give each step a capability; the scheduler assigns the CLI from the configured candidates and moves a step to the next candidate when a CLI is out of quota or signed out.',
  'Capabilities: scout (read code, logs or docs and report what matters), implement (change code; the only capability that can write), review (read a diff and report problems), research (look things up outside the repository), accept (judge the summarised results against the plan).',
  'Keep small tasks small: a single implement step, adding review only for risky or large changes. Put a scout step first only when the code must be understood before it can be changed, and have it end with a short brief the implement step can follow.',
  'Tests and builds run automatically after implementation, so do not spend a step on them. Add an accept step only for complex tasks; it receives summaries, not raw logs.',
  'You may add an optional role to suggest a specific CLI; it is used only when that CLI is a candidate for the capability and available.',
].join(' ');
const PLANNER_PROMPT = 'Plan this development task. Return only a JSON array of steps {id, capability, prompt, dependsOn (earlier step IDs)} with at most 12 steps. ' +
  CAPABILITY_GUIDE + ' The CLIs run on subscriptions, so quota is what runs out; Claude and Codex quota is the scarcest. Task: ';
const terminal = new Set(['completed', 'failed', 'cancelled', 'needs_review']);

function validateAcceptance(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_acceptance');
  const mode = value.mode ?? 'auto';
  const maxRework = value.maxRework ?? 2;
  if (!['auto', 'always', 'off'].includes(mode) || (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      !Number.isSafeInteger(maxRework) || maxRework < 0 || maxRework > 5) throw new Error('invalid_acceptance');
  return { enabled: value.enabled !== false && mode !== 'off', mode, maxRework };
}

// Fingerprints the uncommitted state of a worktree: which files are dirty (including untracked ones)
// and the exact tracked diff. A read-only step must leave this unchanged.
async function worktreeState(folder, signal) {
  const status = await git(folder, ['status', '--porcelain=v1', '-z'], signal);
  const diff = await git(folder, ['diff', '--binary', 'HEAD'], signal);
  return createHash('sha256').update(status).update('\0').update(diff).digest('hex');
}

const FIVE_HOURS = 5 * 3600_000;
const WEEK = 7 * 24 * 3600_000;

function parseJson(output) {
  const text = String(output ?? '').trim();
  try {
    return JSON.parse(text.replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
  } catch { /* not a bare JSON reply */ }
  // A model often writes a sentence before its JSON, or puts it in a fenced block: take the last block that
  // parses, then the outermost {...} or [...] of the reply.
  const candidates = [...text.matchAll(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/gi)].map((m) => m[1]).reverse();
  const object = text.indexOf('{'), array = text.indexOf('[');
  if (object >= 0) candidates.push(text.slice(object, text.lastIndexOf('}') + 1));
  if (array >= 0) candidates.push(text.slice(array, text.lastIndexOf(']') + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.trim()); } catch { /* next */ }
  }
  throw new Error('invalid_plan');
}

// Receipts are one JSON object per line, written by the MCP server for every mutation it forwarded.
async function readReceipts(filename) {
  let text;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((receipt) => receipt && typeof receipt === 'object');
}

// What is wrong with a lead's planning reply, in words the lead can act on; '' when it can be used.
function planProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'it was not one JSON object';
  if (Array.isArray(value.questions)) return value.questions.some((q) => typeof q === 'string' && q.trim()) ? '' : 'questions was empty';
  if (typeof value.summary !== 'string' || !value.summary.trim()) return 'it had neither questions nor a summary';
  if (!Array.isArray(value.steps) || !value.steps.length) return 'it had a summary but no steps';
  if (value.steps.some((step) => typeof step?.prompt !== 'string' || step.prompt.length > 1000)) return 'a step prompt was missing or over 1000 characters';
  return '';
}

function parsePlan(output, availableRoles = roles, router, pick, allowedRole) {
  return validateSteps(parseJson(output), availableRoles, router, pick, allowedRole);
}

// A step names either a role (a specific CLI) or a capability. A capability is resolved by the router to the
// first available candidate; a role the planner suggests is kept when it is a candidate and available.
// Claude is reserved: a plan that tries to hand Claude implementation, review or scouting is rejected.
function validateSteps(plan, availableRoles, router, pick, allowedRole = () => true) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 12) throw new Error('invalid_plan');
  const ids = new Set(['planner', 'group-planner']);
  const choose = pick || ((capability, exclude) => router.pick(capability, exclude));
  const writers = new Map();   // step id -> member who changes files in it
  return plan.map((step) => {
    if (!step || typeof step !== 'object') throw new Error('invalid_plan');
    const { capability } = step;
    let role = step.role;
    // A root step may omit dependsOn; treat it as an empty dependency list.
    const dependsOn = step.dependsOn === undefined ? [] : step.dependsOn;
    if (capability !== undefined) {
      if (!router || !Object.hasOwn(CAPABILITIES, capability)) throw new Error('invalid_plan');
      if (role === LEAD_ROLE && !LEAD_CAPABILITIES.has(capability)) throw new Error('invalid_plan:lead_capability');
      if (!(router.routes[capability].includes(role) && availableRoles.includes(role) &&
        router.quotaAllows(role, capability) && allowedRole(role))) role = choose(capability);
      if (!role) {
        // Configured candidates exist but are blocked by login, quota or an owner cap: the task waits.
        const configured = (router.routes[capability] || []).filter((candidate) => router.configured(candidate));
        throw new Error(configured.length ? 'executor_waiting:' + capability : 'no_executor:' + capability);
      }
      // Cross review: whoever wrote the change it reviews does not review it, when someone else can.
      if (capability === 'review' && Array.isArray(dependsOn)) {
        const authors = dependsOn.map((id) => writers.get(id)).filter(Boolean);
        if (authors.includes(role)) role = choose(capability, authors) || role;
      }
    } else if (role === LEAD_ROLE) {
      throw new Error('invalid_plan:lead_capability');
    }
    if (!/^[a-z0-9_-]{1,32}$/.test(step.id) || ids.has(step.id) || !availableRoles.includes(role) ||
      typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 8000 ||
      !Array.isArray(dependsOn) || dependsOn.some((id) => id === 'planner' || id === 'group-planner' || !ids.has(id))) throw new Error('invalid_plan');
    ids.add(step.id);
    if (capability !== undefined ? CAPABILITIES[capability].write && router.canWrite(role) : role === 'codex') writers.set(step.id, role);
    return {
      id: step.id, role, ...(capability !== undefined && { capability }), ...(step.role && step.role === role && { named: true }),
      prompt: step.prompt, dependsOn: [...new Set(dependsOn)],
      write: capability !== undefined ? CAPABILITIES[capability].write && router.canWrite(role) : role === 'codex',
      state: 'queued', attempts: 0,
    };
  });
}

// What another member of the same project may see: progress and verdicts, never the owner's prompt,
// raw CLI output, file paths, patches, logs or workspace name. The owner and an admin still receive
// the full status through Scheduler.status.
function publicTask(task) {
  const metrics = task.metrics;
  const acceptance = task.acceptance;
  const container = task.container;
  return {
    id: task.id, owner: task.owner || 'local', project: task.project,
    state: task.state, stage: task.stage, createdAt: task.createdAt, updatedAt: task.updatedAt,
    mode: task.mode || 'normal', replyTo: task.replyTo, via: task.via, broadcastId: task.broadcastId, group: task.group,
    detail: String(task.detail || '').split(':')[0],
    ...(metrics && { metrics: {
      startedAt: metrics.startedAt, endedAt: metrics.endedAt, durationMs: metrics.durationMs,
      stepCount: metrics.stepCount, roleCalls: metrics.roleCalls, reassignments: metrics.reassignments,
      testFailures: metrics.testFailures, reviewConflicts: metrics.reviewConflicts,
      reworkRounds: metrics.reworkRounds, triageRounds: metrics.triageRounds,
    } }),
    steps: (task.steps || []).map((step) => ({
      id: step.id, role: step.role, capability: step.capability, state: step.state,
      attempts: step.attempts, dependsOn: step.dependsOn,
      ...(step.continuations && { continuations: step.continuations }),
      ...(step.deliveries?.length && { deliveryCount: step.deliveries.length }),
      ...(step.verdict && { verdict: { verdict: step.verdict.verdict, summary: step.verdict.summary } }),
    })),
    ...(acceptance && { acceptance: {
      verdict: acceptance.verdict, summary: acceptance.summary, round: acceptance.round, at: acceptance.at,
    } }),
    ...(task.testResult && Number.isFinite(task.testResult.code) && { testResult: { code: task.testResult.code } }),
    ...(container && { container: {
      memPeak: container.memPeak,
    } }),
    redacted: true,
  };
}

class Scheduler {
  constructor({ config, store, files, adapter = runAdapter, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.files = files;
    this.adapter = adapter;
    this.teamAdapter = teamAdapter(config.docker, config.stateDir);
    retention(config.retention);   // fail at start-up on a bad retention setting, not at the first clean-up
    this.now = now;
    this.router = new Router(config, now);
    this.modelCatalog = null;      // last result of asking each CLI which models its login can use
    this.modelCatalogReading = null;
    this.acceptance = validateAcceptance(config.acceptance);
    this.ownerCaps = validateOwnerCaps(config.ownerCaps);
    this.running = new Map();
    // Several people share one VPS: tasks run in parallel up to maxConcurrentTasks, but each CLI runs one
    // process at a time across all tasks, because every task uses the same subscription login for that CLI.
    this.cliBusy = new Map();     // role -> number of processes running
    this.cliWaiters = new Map();  // role -> queue of { resolve } waiting for that CLI
    this.tasks = new Map(store.all('tasks').map((task) => [task.id, task]));
    this.route = store.get('settings', 'route')?.value || 'ssh';
    this.maintenance = store.get('settings', 'maintenance')?.value || null;
    for (const task of this.tasks.values()) {
      if (task.state === 'applying' || task.state === 'testing') {
        this.save(task, 'needs_review', 'interrupted_windows_operation');
      } else if (['planning', 'running', 'awaiting_acceptance', 'triaging'].includes(task.state)) {
        for (const step of task.steps) {
          if (step.state === 'running') step.state = 'queued';
        }
        this.save(task, 'queued', 'recovered');
      }
    }
  }

  availableRoles() {
    return this.router.availableRoles();
  }

  // Runs one CLI call. When the CLI reports an expired login or an exhausted quota, the CLI is set aside
  // for a while and the step moves to the next candidate for its capability. Every move is recorded.
  async execute(task, step, folder, signal, prompt) {
    for (;;) {
      try {
        const result = await this.invoke(task, step, folder, signal, prompt);
        this.recordUsage(task, step, result.usage);
        return result;
      } catch (error) {
        this.recordUsage(task, step, error.usage);
        const reason = { cli_quota_exhausted: 'quota', cli_auth_required: 'auth' }[error.message];
        if (signal.aborted || !reason) throw error;
        // A quota block lasts until the reset the CLI stated, when it stated one; otherwise the default.
        this.router.block(step.role, reason, reason === 'quota' && error.retryAfterMs ? error.retryAfterMs : undefined);
        step.tried = [...new Set([...(step.tried || []), step.role])];
        const next = step.capability && !step.fixedReview && !step.pinnedReadOnly && this.pickForTask(task, step.capability, step.tried);
        if (!next || (step.write && !this.router.canWrite(next))) {
          const configured = step.capability
            ? (this.router.routes[step.capability] || []).filter((role) => this.router.configured(role))
            : [];
          // Waiting applies only to capability steps; a CLI pinned by the caller still fails loudly.
          if (configured.length) throw new Error('executor_waiting:' + step.capability);
          throw error;
        }
        this.save(task, task.state, `${step.id}:reassigned:${step.role}->${next}:${reason}`);
        step.role = next;
        delete step.session;
        delete step.model;   // a model ID belongs to one CLI; the next CLI uses its default
      }
    }
  }

  // Subscriptions are limited by quota, so quota is what each task is charged with. The status is cached
  // briefly: reading Codex quota starts an App Server process.
  async refreshQuota(maxAgeMs = 120_000) {
    if (this.config.quota === false) return this.quotaSnapshot || [];
    if (this.quotaSnapshot && this.now() - this.quotaAt < maxAgeMs) return this.quotaSnapshot;
    this.quotaReading ||= quotaStatus(this.config.adapters).then((status) => this.withEstimates(status)).then((status) => {
      this.quotaSnapshot = status;
      this.quotaAt = this.now();
      this.router.setQuota(status);
      return status;
    }).catch(() => this.quotaSnapshot || []).finally(() => { this.quotaReading = null; });
    return this.quotaReading;
  }

  // Ask every catalog-capable CLI which models its current sign-in offers. Model profiles are runtime state:
  // the configuration keeps hand-written descriptions, and a new login can add a model family (Gemini 4) or a
  // retired model can disappear without editing the configuration or restarting the service.
  refreshModelCatalog() {
    this.modelCatalogReading ||= refreshModelCatalog(this.config).then((providers) => {
      this.modelCatalog = { at: new Date(this.now()).toISOString(), providers };
      return this.modelCatalog;
    }).finally(() => { this.modelCatalogReading = null; });
    return this.modelCatalogReading;
  }

  // Every CLI call is remembered for a week, so a CLI that reports no quota can still be judged by how often
  // it has been called against the limits configured for it (adapters.<cli>.callLimits).
  recordCall(role) {
    if (!this.config.adapters[role]?.callLimits) return;
    const now = this.now();
    const calls = (this.store.get('settings', 'calls:' + role)?.at || []).filter((time) => now - time < WEEK);
    calls.push(now);
    this.store.put('settings', 'calls:' + role, { at: calls });
  }

  // Fills in an estimated 5-hour and weekly window for each CLI without a quota source but with call limits.
  withEstimates(list) {
    const now = this.now();
    return (list || []).map((entry) => {
      const limits = this.config.adapters[entry.provider]?.callLimits;
      if (!limits || entry.buckets?.length) return entry;
      const calls = (this.store.get('settings', 'calls:' + entry.provider)?.at || []).filter((time) => now - time < WEEK);
      const window = (span, limit) => {
        if (!limit) return null;
        const inside = calls.filter((time) => now - time < span);
        return { usedPercent: Math.min(100, Math.round(inside.length / limit * 1000) / 10),
          resetsAt: inside.length ? Math.ceil((inside[0] + span) / 1000) : null, calls: inside.length, limit };
      };
      return { ...entry, state: 'available', source: 'estimate', reason: undefined,
        buckets: [{ id: entry.provider + '-estimate', fiveHour: window(FIVE_HOURS, limits.fiveHour), weekly: window(WEEK, limits.weekly) }] };
    });
  }

  // Adds what routing makes of each CLI's quota: the percent the router uses (live, or the cached snapshot when
  // the live reading has none), its limits, and whether it is working normally, reserved for its main jobs, or stopped.
  decorateQuota(list) {
    list = this.withEstimates(list);
    const cached = this.quotaSnapshot || [];
    return list.map((entry) => {
      const routing = cached.find((item) => item.provider === entry.provider);
      const used = usedPercent(entry) ?? usedPercent(routing);
      const policy = this.router.quotaPolicy[entry.provider];
      const level = used === null || !policy ? 'unknown' : used >= policy.hard ? 'stopped' : used >= policy.soft ? 'reserved' : 'ok';
      return { ...entry, used, level, policy,
        ...(usedPercent(entry) === null && used !== null && { usedSource: routing.source, usedObservedAt: routing.observedAt }) };
    });
  }

  // Percent used per CLI and window, for comparing a task's start and end.
  static quotaWindows(status) {
    return Object.fromEntries((status || []).filter((entry) => entry.buckets?.length).map((entry) => {
      const windows = {};
      for (const { fiveHour, weekly } of entry.buckets) {
        for (const [name, window] of [['fiveHour', fiveHour], ['weekly', weekly]]) {
          if (Number.isFinite(window?.usedPercent)) windows[name] = Math.max(windows[name] ?? 0, window.usedPercent);
        }
      }
      return [entry.provider, windows];
    }));
  }

  // Quota used during the task: end minus start for each CLI and window. Other use of the same account in the
  // meantime is included, and a window that reset in between gives no number.
  async chargeQuota(task) {
    if (!task.quotaStart) return;
    const end = Scheduler.quotaWindows(await this.refreshQuota(0));
    const charged = {};
    for (const [role, windows] of Object.entries(end)) {
      for (const [name, used] of Object.entries(windows)) {
        const start = task.quotaStart[role]?.[name];
        if (start === undefined || used < start) continue;
        (charged[role] ||= {})[name] = Math.round((used - start) * 10) / 10;
      }
    }
    task.quota = charged;
    // Recorded as an event without touching state or detail: apply() relies on detail === 'patches_ready'.
    this.store.saveTask(task, { ...this.event(task, task.state, 'quota_charged'), quota: charged });
  }

  // Budget for one task tree (planning, every member call, reassignments, rework, acceptance), like Lancer's
  // limits on branches and tokens. Tokens are input plus output; cached reads are not counted. Past the budget
  // the next step does not start and the task waits for the person (needs_review, budget_exceeded:<kind>).
  budget() {
    const configured = this.config.taskBudget || {};
    const value = (number, fallback) => Number.isSafeInteger(number) && number >= 0 ? number : fallback;   // 0 turns a limit off
    return { steps: value(configured.steps, 24), tokens: value(configured.tokens, 3_000_000) };
  }

  spent(task) {
    const steps = (task.steps || []).reduce((sum, step) => sum + (step.attempts || 0), 0);
    const tokens = Object.values(task.usage || {}).reduce((sum, usage) => sum + (usage.input_tokens || 0) + (usage.output_tokens || 0), 0);
    return { steps, tokens };
  }

  checkBudget(task) {
    const limit = this.budget();
    const used = this.spent(task);
    const kind = limit.steps && used.steps >= limit.steps ? 'steps' : limit.tokens && used.tokens >= limit.tokens ? 'tokens' : null;
    if (kind) throw Object.assign(new Error('budget_exceeded:' + kind), { budget: { limit, used } });
  }

  recordUsage(task, step, usage) {
    if (!usage) return;
    step.usage = addUsage(step.usage, usage);
    task.usage = { ...(task.usage || {}), [step.role]: addUsage(task.usage?.[step.role], usage) };
  }

  doctor() {
    const version = (role) => new Promise((resolve) => {
      const { bin, env } = this.config.adapters[role];
      execFile(bin, ['--version'], { env, timeout: 10000 }, (error, stdout, stderr) => resolve(error
        ? { role, ok: false, error: error.code === 'ENOENT' ? 'not_installed' : (stderr || error.message).trim().slice(0, 200) }
        : { role, ok: true, version: (stdout || stderr).trim().split('\n')[0].slice(0, 120) }));
    });
    return Promise.all(this.router.roles().map(version)).then((clis) => ({
      clis, ...this.router.status(), cleanup: this.lastCleanup || null, modelCatalog: this.modelCatalog,
    }));
  }

  // One clean-up pass at a time; the hourly tick and `ad gc` share it.
  cleanupNow() {
    this.cleaning ||= cleanup({
      tasks: [...this.tasks.values()], running: this.running, config: this.config, now: this.now(),
      onCleared: (task) => this.save(task, task.state, task.detail, false),   // marks cleanedAt without a new event
    }).then((result) => {
      // Records are kept for the history window; files were already cleared 3/7 days after the task ended.
      // A task referenced by a newer review/reply is kept for one more pass so its link does not dangle.
      const keep = retention(this.config.retention);
      const referenced = new Set();
      for (const task of this.tasks.values()) {
        for (const key of ['replyTo', 'reviewOf']) {
          if (typeof task[key] === 'string') referenced.add(task[key]);
        }
      }
      const expired = historyCandidates([...this.tasks.values()], this.running, this.now(), keep, { referenced });
      if (expired.length) {
        const ids = expired.map((task) => task.id);
        result.historyRemoved = this.store.deleteTasks(ids);
        for (const id of ids) this.tasks.delete(id);
        try { this.store.vacuum(); result.vacuumed = true; }
        catch (error) { console.error('cleanup vacuum:', error.message); result.vacuumed = false; }
      } else {
        result.historyRemoved = 0;
        result.vacuumed = false;
      }
      this.lastCleanup = result;
      if (result.lowDisk) console.error('cleanup: low disk', result.freePercent + '% free');
      return result;
    }).finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  async diagnosticStatus({ named, admin = false } = {}) {
    const { clis } = await this.doctor();
    const snapshot = await hostResources();
    const imageDigests = [...new Set([this.config.docker?.image, ...Object.values(this.config.docker?.images || {})]
      .map((image) => typeof image === 'string' ? image.match(/sha256:[a-f0-9]{64}$/)?.[0] : undefined).filter(Boolean))];
    return {
      clis: clis.map(({ role, ok, version }) => {
        const block = this.router.blocked.get(role);
        const state = !ok ? 'unavailable' : this.config.adapters[role].authRequired ? 'auth_required' : block?.until > this.now()
          ? block.reason === 'auth' ? 'auth_required' : 'quota_limited' : 'ready';
        return { provider: role, state, ...(version && { version: version.match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] }) };
      }),
      ...(admin || this.config.quotaBridges?.includes(named) ? { quota: this.router.quota } : {}),
      resources: snapshot,
      imageDigests,
    };
  }

  list() {
    return [...this.tasks.values()].slice(-50).reverse().map(({ id, owner, workspace, prompt, state, detail, stage, steps, quota, usage, project, tags, metrics }) => ({
      id, owner: owner || 'local', workspace, state, detail, stage, project, tags, prompt: prompt.slice(0, 80),
      roles: [...new Set(steps.map((step) => step.role))], quota, usage, metrics,
    }));
  }

  // A saved event is both a short human detail and a small structured record for the client. It never
// contains step output, prompts or patches, so it is safe to hand to a project member.
event(task, state, detail) {
    const value = String(detail ?? '');
    const step = value.includes(':') ? (task.steps || []).find((item) => item.id && value.startsWith(item.id + ':')) : undefined;
    const data = this.eventData(value) ||
      (value === 'owner_quota_cap' && task.waitingFor ? { capability: task.waitingFor } : undefined);
    const stepId = step?.id || data?.stepId;
    const related = step || (stepId && (task.steps || []).find((item) => item.id === stepId));
    return {
      state, detail: value, kind: this.eventKind(value), owner: task.owner || 'local',
      ...(task.project && { project: task.project }),
      ...(stepId && { stepId }), ...(related?.role && { role: related.role }), ...(data && { data }),
    };
  }

  eventKind(detail) {
    if (detail.startsWith('executor_waiting:') || detail === 'owner_quota_cap') return 'waiting';
    if (detail.startsWith('triage_') || detail.startsWith('escalated:') || detail === 'rework_after_apply') return 'escalation';
    if (detail.startsWith('acceptance_')) return 'acceptance';
    if (detail.startsWith('review_')) return 'review';
    if (detail.startsWith('test_') || detail.startsWith('windows_test_')) return 'test';
    if (detail.startsWith('plan') || detail === 'submitted') return 'plan';
    if (detail === 'quota_charged') return 'usage';
    if (/^[\w-]+:(started|completed|failed|session|waiting|reassigned)/.test(detail)) return 'step';
    return 'state';
  }

  eventData(detail) {
    let match;
    if ((match = /^executor_waiting:(\w+)$/.exec(detail))) return { capability: match[1] };
    if ((match = /^([\w-]+):reassigned:(\w+)->(\w+):(quota|auth|busy)$/.exec(detail))) {
      return { stepId: match[1], from: match[2], to: match[3], reason: match[4] };
    }
    if ((match = /^review_verdict:([^:]+):([a-z_]+)$/.exec(detail))) return { stepId: match[1], verdict: match[2] };
    if ((match = /^triage_decision:([a-z_]+)$/.exec(detail))) return { decision: match[1] };
    if ((match = /^acceptance_verdict:([a-z_]+)$/.exec(detail))) return { verdict: match[1] };
    if ((match = /^test_failed:(\d+)$/.exec(detail))) return { failures: Number(match[1]) };
    return undefined;
  }

  save(task, state, detail, record = true, data) {
    task.state = state;
    task.detail = detail;
    if (record) task.updatedAt = new Date(this.now()).toISOString();
    this.updateMetrics(task, state);
    if (record) {
      const event = this.event(task, state, detail);
      this.store.saveTask(task, data ? { ...event, kind: 'question', data } : event);
    }
    else this.store.put('tasks', task.id, task);
  }

  // Metrics live with the task so reports work after a restart. They are counts, never transcripts or
  // prompts. A task that leaves a resting state (needs_review -> applying) clears its end time so the
  // eventual terminal state records the full duration.
  updateMetrics(task, state) {
    const metrics = task.metrics ||= {};
    const now = new Date(this.now()).toISOString();
    if (!metrics.startedAt && !['queued', 'awaiting_details', 'awaiting_approval', 'submitted'].includes(state)) {
      metrics.startedAt = now;
    }
    const roleCalls = {};
    let reassignments = 0;
    for (const step of task.steps || []) {
      if (step.role) roleCalls[step.role] = (roleCalls[step.role] || 0) + (step.attempts || 0);
      reassignments += step.tried?.length || 0;
    }
    metrics.stepCount = (task.steps || []).length;
    metrics.roleCalls = roleCalls;
    metrics.reassignments = reassignments;
    metrics.testFailures = task.testFailures || 0;
    metrics.reviewConflicts = task.reviewConflicts || 0;
    metrics.reworkRounds = task.reworkRounds || 0;
    metrics.triageRounds = task.triageRounds || 0;
    if (terminal.has(state)) {
      if (!metrics.endedAt) {
        metrics.endedAt = now;
        const start = Date.parse(metrics.startedAt || '');
        metrics.durationMs = Number.isFinite(start) ? Math.max(0, Date.parse(now) - start) : 0;
      }
      metrics.result = state;
      const accepted = state === 'completed' || ['accept', 'pass', 'accept_with_risk'].includes(task.acceptance?.verdict);
      metrics.accepted = accepted;
      metrics.firstPass = accepted && !metrics.testFailures && !metrics.reviewConflicts &&
        !metrics.reworkRounds && !metrics.triageRounds;
    } else {
      delete metrics.endedAt;
      delete metrics.durationMs;
      delete metrics.result;
      delete metrics.accepted;
      delete metrics.firstPass;
    }
  }

  submit(id, body, groupPlan = false) {
    const mode = body.mode ?? 'normal';
    // Attachments go with a single chat or with a group task (its lead and every member see them); a review of
    // a patch has nothing to attach to.
    if (body.attachments !== undefined && (!validAttachments(body.attachments) || mode === 'review_only')) throw Error('invalid_attachment');
    if (!taskModes.has(mode) || (readOnlyMode(mode) && body.command != null) ||
        (body.replyTo !== undefined && (typeof body.replyTo !== 'string' || !taskIdPattern.test(body.replyTo))) ||
        // group: which of the project's group chats the task belongs to (a project may have several).
        (body.group !== undefined && (typeof body.group !== 'string' || !/^[A-Za-z0-9._~-]{1,96}$/.test(body.group))) ||
        // leadEffort: how hard the lead (Claude) thinks while planning, diagnosing and accepting; the person picks it.
        (body.leadEffort !== undefined && !EFFORTS.claude.includes(body.leadEffort)) ||
        // approval: whether the person confirms each plan (always), only bigger ones (small) or none (auto).
        (body.approval !== undefined && !['always', 'small', 'auto'].includes(body.approval)) ||
        // leadModel: which of the lead's models plans, diagnoses and accepts; the person may pick any of them.
        (body.leadModel !== undefined && (typeof body.leadModel !== 'string' ||
          !Object.hasOwn(this.config.adapters[LEAD_ROLE]?.profiles?.models || {}, body.leadModel))) ||
        (body.routeOrder !== undefined && !this.validRouteOrder(body.routeOrder)) ||
        (body.broadcastId !== undefined && (typeof body.broadcastId !== 'string' || !taskIdPattern.test(body.broadcastId))) ||
        (body.reviewOf !== undefined && (mode !== 'review_only' || typeof body.reviewOf !== 'string' || !taskIdPattern.test(body.reviewOf))) ||
        (body.via !== undefined && !['desktop', 'wechat'].includes(body.via))) throw new Error('invalid_task');
    groupPlan = mode !== 'edit' && !readOnlyMode(mode) && (groupPlan || mode === 'duo' || mode === 'team');
    const existing = this.tasks.get(id);
    if (existing) {
      if (Boolean(existing.groupPlan) !== groupPlan || existing.prompt !== body.prompt || existing.workspace !== body.workspace ||
          existing.command !== body.command || existing.provider !== body.provider || existing.model !== body.model ||
          (existing.mode || 'normal') !== mode || existing.replyTo !== body.replyTo ||
          existing.via !== body.via || existing.broadcastId !== body.broadcastId || existing.reviewOf !== body.reviewOf ||
          existing.project !== body.project || existing.benchmarkId !== body.benchmarkId || existing.arm !== body.arm ||
          JSON.stringify(existing.attachments) !== JSON.stringify(body.attachments) ||
          JSON.stringify(existing.tags || []) !== JSON.stringify(Array.isArray(body.tags)
            ? [...new Set(body.tags.map((tag) => typeof tag === 'string' ? tag.trim() : tag))] : body.tags || [])) {
        throw new Error('task_id_conflict');
      }
      return existing;
    }
    if (!Object.hasOwn(this.config.workspaces, body.workspace) || typeof body.prompt !== 'string' ||
      !body.prompt.trim() || body.prompt.length > 12000 || (body.command != null && typeof body.command !== 'string')) {
      throw new Error('invalid_task');
    }
    if (body.provider === 'gemini' && !this.config.adapters?.gemini) throw new Error('gemini_not_configured');
    if (body.provider === 'antigravity' && !this.config.adapters?.antigravity) throw new Error('antigravity_not_configured');
    // The lead role is reserved for planning, triage and acceptance; a caller cannot pin a task to Claude.
    if (mode === 'team' && this.slots() < 2) throw new Error('team_requires_two_slots');
    if (mode === 'duo' && body.provider) throw new Error('duo_uses_group_routing');
    const directWriter = this.config.writeProviders?.includes(body.provider);
    if (mode === 'edit' && (!directWriter || !this.router.configured(body.provider))) throw new Error('provider_write_not_enabled');
    if (body.provider === LEAD_ROLE && !(directWriter && ['edit', 'chat'].includes(mode))) throw new Error('claude_reserved');
    if ((body.provider !== undefined && !ROLES.includes(body.provider)) ||
        (body.model !== undefined && (!body.provider || typeof body.model !== 'string' ||
          !modelId.test(body.model)))) throw new Error('invalid_model_selection');
    const tags = body.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 8 ||
        tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 32)) throw new Error('invalid_task');
    if (body.project !== undefined && (typeof body.project !== 'string' || !projectIdPattern.test(body.project))) {
      throw new Error('invalid_task');
    }
    const owner = this.ownerOf(body.workspace);
    const project = body.project !== undefined ? this.config.projects?.[body.project] : undefined;
    if (project) {
      // A project belongs to a fixed set of bridges. The local admin may submit on any workspace, but a
      // named bridge must be a member and, when a per-member workspace is declared, use that workspace.
      if (owner !== 'local' && !project.members?.includes(owner)) throw new Error('project_access_denied');
      if (owner !== 'local' && project.workspaces?.[owner] !== undefined && project.workspaces[owner] !== body.workspace) {
        throw new Error('project_workspace_mismatch');
      }
    }
    if (body.replyTo) {
      const target = this.tasks.get(body.replyTo);
      if (!target || target.project !== body.project || (target.owner !== owner && !project)) throw new Error('unknown_task');
    }
    if (body.reviewOf) {
      const source = this.tasks.get(body.reviewOf);
      if (!source || source.owner !== owner || source.workspace !== body.workspace || source.project !== body.project) throw new Error('unknown_task');
    }
    if (body.benchmarkId !== undefined && (typeof body.benchmarkId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.benchmarkId))) {
      throw new Error('invalid_task');
    }
    if (body.arm !== undefined && !['single', 'multi', 'manual'].includes(body.arm)) throw new Error('invalid_task');
    if (this.tasks.size >= 10000) throw new Error('task_capacity');
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim()))];
    const task = { id, workspace: body.workspace, prompt: body.prompt, command: body.command, provider: body.provider, model: body.model, steps: [],
      ...(body.attachments && { attachments: body.attachments }),
      owner, tags: normalizedTags, mode, createdAt: new Date(this.now()).toISOString(),
      ...(body.replyTo && { replyTo: body.replyTo }),
      ...(body.via && { via: body.via }),
      ...(body.group && { group: body.group }),
      ...(body.leadEffort && { leadEffort: body.leadEffort }),
      ...(body.leadModel && { leadModel: body.leadModel }),
      ...(body.approval && { approval: body.approval }),
      ...(body.routeOrder && Object.keys(body.routeOrder).length && { routeOrder: body.routeOrder }),
      ...(body.broadcastId && { broadcastId: body.broadcastId }),
      ...(body.reviewOf && { reviewOf: body.reviewOf }),
      ...(mode === 'team' && { slotCost: 2 }),
      ...(body.project !== undefined && { project: body.project }),
      ...(body.benchmarkId !== undefined && { benchmarkId: body.benchmarkId }),
      ...(body.arm !== undefined && { arm: body.arm }) };
    if (groupPlan) task.groupPlan = { rounds: [] };
    this.tasks.set(id, task);
    this.save(task, 'queued', 'submitted');
    this.pump();
    return task;
  }

  broadcast(id, body) {
    const owner = this.ownerOf(body.workspace);
    const key = JSON.stringify([body.workspace, body.project, body.prompt, body.replyTo, body.via, body.tags]);
    let entry = this.store.get('broadcasts', id);
    if (entry && (entry.owner !== owner || entry.key !== key)) throw new Error('task_id_conflict');
    if (!entry) {
      const providers = this.availableRoles().filter((role) => role !== LEAD_ROLE &&
        this.router.quotaAllows(role, 'scout') && this.ownerAllows({ owner }, role).allowed).slice(0, 5);
      if (!providers.length) throw new Error('no_executor:scout');
      entry = { key, owner, tasks: providers.map((provider) => ({ provider, id: randomUUID() })) };
      this.store.put('broadcasts', id, entry);
    }
    return entry.tasks.map(({ provider, id: child }) => this.status(this.submit(child, {
      ...body, mode: 'chat', command: undefined, reviewOf: undefined, model: undefined, provider, broadcastId: id,
    }).id));
  }

  compact(project, named, workspace) {
    if (project !== undefined ? typeof project !== 'string' || !projectIdPattern.test(project) ||
        !Object.hasOwn(this.config.projects || {}, project) || (named && !this.isProjectMember(project, named))
      : !Object.hasOwn(this.config.workspaces, workspace) || (named && this.ownerOf(workspace) !== named)) {
      throw new Error('project_access_denied');
    }
    const key = project ?? 'workspace:' + workspace;
    const tasks = [...this.tasks.values()].filter((task) => task.project === project && (project || task.workspace === workspace))
      .map(({ id, state, tags }) => ({ id, state, tags }));
    const brief = compactProject(project ?? workspace, tasks);
    this.store.put('projectBriefs', key, brief);
    return brief;
  }

  projectBrief(task) {
    return this.store.get('projectBriefs', task.project ?? 'workspace:' + task.workspace);
  }

  addDuoReviews(task, steps) {
    if (task.mode !== 'duo') return;
    const configured = this.router.routes.review.filter((role) => role !== LEAD_ROLE && this.router.configured(role));
    if (configured.length < 2) throw new Error('duo_requires_two_reviewers');
    // Each review has one distinct provider. Preserve a planned review when it already fills a slot.
    const reviews = steps.filter((step) => step.capability === 'review');
    const used = new Set();
    for (const review of reviews) {
      if (used.has(review.role) || !configured.includes(review.role)) continue;
      review.fixedReview = true;
      used.add(review.role);
    }
    while (used.size < 2) {
      const role = this.pickForTask(task, 'review', [...used, LEAD_ROLE]);
      if (!role) throw new Error('executor_waiting:review');
      const writer = steps.findLast((step) => step.write);
      let index = steps.length;
      while (steps.some(({ id }) => id === 'duo-review-' + index)) index++;
      steps.push({ id: 'duo-review-' + index, role, capability: 'review', fixedReview: true,
        dependsOn: writer ? [writer.id] : steps.filter((step) => step.capability !== 'accept').map((step) => step.id),
        prompt: task.prompt, write: false, state: 'queued', attempts: 0 });
      used.add(role);
    }
  }

  async prepareReadOnly(task, signal) {
    if (task.steps.length) return;
    const capability = task.mode === 'review_only' ? 'review' : 'scout';
    const fallback = capability === 'scout' && this.router.available('codex') &&
      this.router.quotaAllows('codex', capability) && this.ownerAllows(task, 'codex').allowed ? 'codex' : null;
    const role = task.provider || this.pickForTask(task, capability) || fallback;
    if (!role) throw new Error('executor_waiting:' + capability);
    if (task.provider && ((role === LEAD_ROLE && !this.config.writeProviders?.includes(role)) || !this.router.available(role) ||
        !(task.mode === 'chat' && task.tags?.includes('direct') ? this.router.quotaAllowsDirect(role) : this.router.quotaAllows(role, capability)) ||
        !this.ownerAllows(task, role).allowed)) throw new Error('executor_waiting:' + capability);
    if (task.mode === 'review_only' && !this.router.routes.review.includes(role)) throw new Error('invalid_review_provider');
    const prompt = (task.mode === 'chat' ? 'Respond in read-only mode. Do not modify files or run write operations. For files on the user\'s computer, use agentdesk_windows MCP tools: first windows_list_locations, then read/list with the chosen root. Your VPS checkout is not the user\'s live filesystem. Request: '
      : 'Review the supplied uncommitted changes without modifying them. Request: ') + task.prompt;
    if (task.mode === 'review_only') {
      const snapshot = task.reviewOf ? await taskPatch(this.config.stateDir, this.tasks.get(task.reviewOf))
        : await this.files.call(this.bridgeRoute(task.workspace), task.id, 'command.execute', {
          operation: 'git_review_diff', workspace: task.workspace,
        });
      if (!/^[0-9a-f]{40,64}$/.test(snapshot.base || '') || typeof snapshot.patch !== 'string' ||
          Buffer.byteLength(snapshot.patch) > MAX_PATCH) throw new Error('review_snapshot_failed');
      if (!snapshot.patch) {
        this.save(task, 'completed', 'no_review_changes');
        return;
      }
      const dir = path.join(this.config.stateDir, 'worktrees', task.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, 'review-input.patch'), snapshot.patch, { mode: 0o600 });
      task.base = snapshot.base;
    } else {
      // Conversation tools read the live Bridge files; the local project need not be clean or committed.
      const repo = this.config.workspaces[task.workspace].repository;
      const head = (await git(repo, ['rev-parse', 'HEAD'], signal)).trim();
      if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('invalid_workspace_baseline');
      task.base = head;
    }
    const repo = this.config.workspaces[task.workspace].repository;
    await git(repo, ['cat-file', '-e', task.base + '^{commit}'], signal);
    task.steps = [{ id: capability, role, capability, model: task.model, prompt, pinnedReadOnly: Boolean(task.provider),
      dependsOn: [], write: false, state: 'queued', attempts: 0 }];
  }

  status(id, after) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('unknown_task');
    const { steps, prompt, groupPlan, ...summary } = task;
    return {
      ...summary, route: this.bridgeRoute(task.workspace),
      ...(groupPlan && { plan: {
        rounds: groupPlan.rounds.slice(-8).map(({ steps, ...round }, index, rounds) => ({
          ...round, ...(steps && index === rounds.length - 1 && {
            steps: steps.map(({ role, model, effort, prompt, id, dependsOn, write }) => ({ role, model, ...(effort && { effort }), prompt, id, dependsOn, write })),
          }),
        })),
        ...(groupPlan.approved && { approved: groupPlan.approved }),
      } }),
      // brief: what the lead asked this member to do, shown at the top of that member's own conversation.
      steps: steps.map(({ prompt, output, ...step }) => ({ ...step, brief: prompt?.slice(0, 800), output: output?.slice(0, 1600),
        paths: step.paths?.slice(0, 20) })),
      events: this.store.events(id, after),
      live: this.liveState(task),
    };
  }

  // What a task is doing or waiting for right now, as facts the desktop turns into one line per step (after
  // Grok Bot's "every piece of work has an owner who reports its state"): for a running step its member, when it
  // started and when its CLI last wrote anything; for a queued step the member it waits for and who holds that
  // member now; for a task waiting for an executor, why each candidate cannot take it (login, cooling, quota).
  liveState(task) {
    if (!['running', 'queued', 'planning', 'triaging', 'awaiting_acceptance'].includes(task.state)) return undefined;
    const fs = require('node:fs');
    const steps = [];
    const holds = (step) => (this.cliHolders?.get(step.role) || []).some((entry) => entry.taskId === task.id && entry.stepId === step.id);
    for (const step of task.steps || []) {
      // A step is marked running before it gets its member's CLI; until then it is waiting for that member.
      if (step.state === 'running' && holds(step)) {
        let lastOutputAt;
        try { lastOutputAt = fs.statSync(path.join(this.config.stateDir, 'logs', task.id, step.id + '.log')).mtime.toISOString(); } catch { /* no output yet */ }
        steps.push({ id: step.id, role: step.role, state: 'running', startedAt: step.startedAt, lastOutputAt });
      } else if (['queued', 'running'].includes(step.state) && (this.cliBusy.get(step.role) || 0) >= (this.config.cliConcurrency?.[step.role] ?? 1)) {
        const holder = (this.cliHolders?.get(step.role) || [])[0];
        const other = holder && this.tasks.get(holder.taskId);
        steps.push({ id: step.id, role: step.role, state: 'waiting_member', ...(holder && {
          holder: { taskId: holder.taskId, stepId: holder.stepId, since: new Date(holder.since).toISOString(),
            prompt: holder.taskId === task.id ? undefined : String(other?.prompt || '').slice(0, 60) },
        }) });
      }
    }
    const waitingFor = task.waitingFor;
    const reasons = waitingFor ? Object.fromEntries((this.router.routes[waitingFor] || []).filter((role) => this.router.configured(role))
      .map((role) => [role, { reason: this.router.unavailableReason(role, waitingFor),
        until: this.router.status().blocked[role]?.until }])) : undefined;
    return { at: new Date(this.now()).toISOString(), steps, ...(waitingFor && { waitingFor, reasons, notBefore: task.notBefore ? new Date(task.notBefore).toISOString() : undefined }) };
  }

  updatePlan(task, { operation, revision, reply }) {
    const plan = task?.groupPlan;
    const round = plan?.rounds.at(-1);
    if (!round || !Number.isSafeInteger(revision)) throw new Error('plan_changed');
    if (operation === 'plan_reply') {
      if (typeof reply !== 'string' || !reply.trim() || reply.length > 2000) throw new Error('invalid_plan_reply');
      const previous = plan.rounds.find((item) => item.revision === revision);
      if (previous?.reply === reply) return this.status(task.id);
      if (round.revision !== revision || !['awaiting_details', 'awaiting_approval'].includes(task.state)) {
        throw new Error('plan_changed');
      }
      round.reply = reply;
      this.save(task, 'queued', 'plan_reply_received', true, { revision });
    } else {
      if (plan.approved === revision) return this.status(task.id);
      if (round.revision !== revision || task.state !== 'awaiting_approval' || !round.steps?.length) throw new Error('plan_changed');
      this.approveRound(task, round);
      this.save(task, 'queued', 'plan_approved');
    }
    this.pump();
    return this.status(task.id);
  }

  // In a group the person talks to the lead of the task in hand. A message while that task is still going changes
  // its plan instead of starting another task: the lead stops the work not yet finished, keeps what is done and
  // plans the rest again with the person's words; the person confirms the new plan as usual.
  revisePlan(task, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('invalid_plan_reply');
    if (!task.groupPlan) throw new Error('not_group_task');
    if (terminal.has(task.state)) throw new Error('task_finished');
    const plan = task.groupPlan;
    const round = plan.rounds.at(-1);
    if (['awaiting_details', 'awaiting_approval'].includes(task.state) && round) {
      return this.updatePlan(task, { operation: 'plan_reply', revision: round.revision, reply: text });
    }
    // While members are at work, the lead first decides what the message means for each step, so a remark that
    // only adds something does not throw away half-done work (decideRevision). With nothing at work, or while
    // the task is between stages, the rest is planned again.
    const active = (task.steps || []).filter((step) => ['running', 'queued'].includes(step.state) && !this.isAcceptStep(step));
    if (active.length && task.state === 'running' && this.running.has(task.id)) {
      (task.revisions ||= []).push({ text: text.trim(), at: new Date(this.now()).toISOString(), state: 'deciding' });
      task.revisions = task.revisions.slice(-10);
      this.save(task, task.state, 'revise_deciding');
      this.decideRevision(task, text.trim()).catch((error) => this.reviseFallback(task, text.trim(), error));
      return this.status(task.id);
    }
    const done = (task.steps || []).filter((step) => step.state === 'completed');
    task.keptSteps = done.map((step) => ({ ...step }));
    for (const step of task.steps || []) {
      if (step.state === 'running') this.stepControllers?.get(task.id + ':' + step.id)?.abort(new Error('revised'));
    }
    task.steps = done;
    delete plan.approved;
    delete plan.pending;
    delete task.escalation;
    delete task.pendingTriage;
    if (round) round.reply = round.reply ? round.reply + '\n' + text.trim() : text.trim();
    else plan.rounds.push({ revision: 0, reply: text.trim() });
    this.save(task, 'queued', 'plan_revise_requested');
    this.running.get(task.id)?.abort(new Error('revised'));
    this.pump();
    return this.status(task.id);
  }

  // The lead reads the person's new words against the steps in hand and answers, for each step still to do or
  // at work: continue (unaffected), guide (it carries on in the same session with a note) or stop (the direction
  // changed); and it may add steps. Added steps follow the group's plan approval setting.
  async decideRevision(task, text) {
    const lead = this.pickForTask(task, 'triage');
    if (!lead) throw new Error('lead_unavailable');
    const steps = (task.steps || []).filter((step) => !this.isAcceptStep(step));
    const context = {
      request: clip(task.prompt, 4000), planSummary: task.groupPlan?.rounds?.at(-1)?.summary, newMessage: text,
      steps: steps.map(({ id, role, capability, state, prompt, output, dependsOn }) => ({ id, role, capability, state,
        prompt: clip(prompt, 600), ...(output && { output: clip(output, 600) }), dependsOn })),
      capabilities: Object.fromEntries(Object.entries(this.router.routes)
        .map(([name, list]) => [name, this.ordered(task, name, list.filter((role) => this.router.available(role)))])),
      models: plannerProfiles(this.availableRoles(), this.config.adapters, task.provider, task.model),
    };
    const prompt = [
      'You are 组长, the group lead. While the members were working, the person sent a new message about this task (newMessage).',
      'Decide for every step that is queued or running: "continue" when the message does not affect it, "guide" when it should take the message into account and carry on with the work it has done (give a short instruction in the person’s language), "stop" only when the step is now pointless or wrong. Prefer guide over stop: stopping throws away half-done work.',
      'If the message needs work no step covers, add steps in "add" with the same fields as a plan step (id, capability, prompt, optional role, model, effort, dependsOn); dependsOn may name existing steps.',
      'In add, model must be an exact id listed under models for that role (never a label, a family name or the person’s shorthand), and effort one of that model’s efforts; leave either out to use the member’s default. Match the newest generation and the size of the model to the work, as in the original plan.',
      'Reply with JSON alone: {"summary":"one sentence for the person","steps":{"<id>":{"action":"continue|guide|stop","guidance":"..."}},"add":[]}.',
      JSON.stringify(context),
    ].join('\n');
    const step = { id: 'revise-' + ((task.revisions || []).length), role: lead, capability: 'triage', write: false, model: this.leadModelFor(task) };
    const folder = path.join(this.config.stateDir, 'worktrees', task.id, 'group-planner');
    const cwd = await stat(folder).then(() => folder, () => path.join(this.config.stateDir, 'worktrees', task.id));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const controller = this.running.get(task.id);
    const { output } = await this.execute(task, step, cwd, controller?.signal || new AbortController().signal, prompt);
    const decision = parseJson(output);
    if (!decision || typeof decision !== 'object') throw new Error('invalid_revision');
    if (terminal.has(task.state)) return;
    const record = task.revisions?.at(-1);
    const actions = decision.steps && typeof decision.steps === 'object' ? decision.steps : {};
    const outcome = { continued: [], guided: [], stopped: [], added: [], modelFallbacks: [] };
    for (const item of steps) {
      if (!['running', 'queued'].includes(item.state)) continue;
      const choice = actions[item.id] || {};
      if (choice.action === 'stop') {
        item.revisedOut = true;
        if (item.state === 'queued') { item.state = 'skipped'; this.save(task, task.state, item.id + ':revised_out'); }
        else this.stepControllers?.get(task.id + ':' + item.id)?.abort(new Error('revised_out'));
        outcome.stopped.push(item.id);
      } else if (choice.action === 'guide') {
        const note = typeof choice.guidance === 'string' && choice.guidance.trim() ? choice.guidance.trim().slice(0, 2000) : text;
        try { this.steerStep(task, item.id, note); outcome.guided.push(item.id); } catch { /* it finished meanwhile */ }
      } else outcome.continued.push(item.id);
    }
    if (Array.isArray(decision.add) && decision.add.length) {
      const existing = new Set(task.steps.map((item) => item.id));
      const raw = decision.add.slice(0, 6);
      const outside = raw.map((item) => (Array.isArray(item?.dependsOn) ? item.dependsOn : []).filter((id) => existing.has(id)));
      const added = validateSteps(raw.map((item) => ({ ...item, dependsOn: (Array.isArray(item?.dependsOn) ? item.dependsOn : []).filter((id) => !existing.has(id)) })),
        this.availableRoles(), this.router, (capability, exclude) => this.pickForTask(task, capability, exclude),
        (role) => this.ownerAllows(task, role).allowed);
      const renamed = new Map();
      for (const item of added) {
        let next = item.id;
        for (let n = 2; existing.has(next); n += 1) next = item.id + '-' + n;
        existing.add(next);
        renamed.set(item.id, next);
      }
      const ask = !this.autoApproves(task, added);
      added.forEach((item, index) => {
        const models = this.config.adapters[item.role]?.profiles?.models || {};
        const requestedModel = raw[index]?.model;
        const resolvedModel = this.resolveModel(item.role, requestedModel);
        item.model = resolvedModel || preferredModel(this.config.adapters[item.role]?.profiles);
        const effort = raw[index]?.effort;
        if (typeof effort === 'string' && effortsFor(item.role, this.config.adapters[item.role], item.model).includes(effort)) item.effort = effort;
        item.dependsOn = [...outside[index], ...item.dependsOn.map((id) => renamed.get(id) || id)];
        item.id = renamed.get(item.id);
        if (ask) item.state = 'proposed';
        item.addedBy = 'revision';
        task.steps.push(item);
        outcome.added.push(item.id);
        // A name the lead invented (often the person's shorthand) is not silently swapped for the default: say so
        // in the revision record, so the group chat can show which model the added steps really run on.
        if (typeof requestedModel === 'string' && requestedModel.trim() && !resolvedModel) {
          outcome.modelFallbacks.push({ step: item.id, requested: clip(requestedModel.trim(), 80), used: item.model || '(default)' });
        }
      });
    }
    if (record) Object.assign(record, { state: 'decided', summary: clip(String(decision.summary || ''), 600), ...outcome });
    const proposed = task.steps.some((item) => item.state === 'proposed');
    // The run may have ended while the lead was deciding: start it again for the work that is left.
    if (!this.running.has(task.id) && !terminal.has(task.state)) {
      this.save(task, proposed && !task.steps.some((item) => item.state === 'queued') ? 'awaiting_approval' : 'queued',
        proposed ? 'revise_needs_approval' : 'revise_decided');
      this.pump();
    } else this.save(task, task.state, proposed ? 'revise_needs_approval' : 'revise_decided');
  }

  // The lead names a model for an added step: accept an exact id, the same id ignoring case and punctuation, or a
  // profile's display label. Anything else is a miss; the caller falls back to the member's default and records it.
  resolveModel(role, requested) {
    if (typeof requested !== 'string' || !requested.trim()) return null;
    const models = this.config.adapters[role]?.profiles?.models || {};
    if (Object.hasOwn(models, requested)) return requested;
    const fold = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = fold(requested);
    return Object.keys(models).find((id) => fold(id) === wanted)
      || Object.keys(models).find((id) => fold(models[id]?.label || '') === wanted)
      || null;
  }

  // The lead could not decide (unavailable or an unusable reply): every member at work gets the message as
  // guidance, so nothing done so far is lost.
  reviseFallback(task, text, error) {
    const record = task.revisions?.at(-1);
    const guided = [];
    for (const step of task.steps || []) {
      if (!['running', 'queued'].includes(step.state) || this.isAcceptStep(step)) continue;
      try { this.steerStep(task, step.id, text); guided.push(step.id); } catch { /* finished meanwhile */ }
    }
    if (record) Object.assign(record, { state: 'fallback', reason: String(error?.message || error), guided });
    if (!terminal.has(task.state)) this.save(task, task.state, 'revise_fallback');
  }

  // The person confirms the steps the lead added after a change of direction.
  approveAddition(task) {
    const proposed = (task.steps || []).filter((step) => step.state === 'proposed');
    if (!proposed.length) throw new Error('plan_changed');
    for (const step of proposed) step.state = 'queued';
    if (this.running.has(task.id)) this.save(task, task.state, 'revise_approved');
    else { this.save(task, 'queued', 'revise_approved'); this.pump(); }
    return this.status(task.id);
  }

  // Whose task this is: the bridge (one per person's machine) its workspace belongs to.
  ownerOf(workspace) {
    return this.config.workspaces?.[workspace]?.sshBridge || 'local';
  }

  isProjectMember(projectId, bridge) {
    return Boolean(projectId && bridge && this.config.projects?.[projectId]?.members?.includes(bridge));
  }

  projectsFor(bridge) {
    return Object.entries(this.config.projects || {})
      .filter(([, project]) => Array.isArray(project?.members) && project.members.includes(bridge))
      .map(([id]) => id);
  }

  // Whether this person may still spend one more step of this CLI today.
  ownerAllows(task, role, at = new Date(this.now())) {
    return ownerAllow([...this.tasks.values()], task.owner || 'local', role, this.ownerCaps, at);
  }

  // The single place where a step's CLI is chosen. Owner caps are applied here in T1.9.
  // The person may put the members of a capability in their own order (the quota page); the order only ranks
  // members the orchestrator already routes that capability to, so it can never hand work to someone the
  // configuration does not allow (Claude never implements).
  static ORDERABLE = ['scout', 'implement', 'review', 'research'];

  validRouteOrder(order) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) return false;
    return Object.entries(order).every(([capability, list]) => Scheduler.ORDERABLE.includes(capability) &&
      Array.isArray(list) && list.length <= 8 && new Set(list).size === list.length &&
      list.every((role) => typeof role === 'string' && (this.router.routes[capability] || []).includes(role)));
  }

  ordered(task, capability, list) {
    const preferred = task?.routeOrder?.[capability];
    if (!preferred) return list;
    const rank = (role) => { const i = preferred.indexOf(role); return i < 0 ? preferred.length + list.indexOf(role) : i; };
    return [...list].sort((a, b) => rank(a) - rank(b));
  }

  pickForTask(task, capability, exclude = []) {
    const candidates = this.ordered(task, capability, this.router.candidates(capability, exclude));
    if (!candidates.length) {
      delete task.ownerCapBlocked;
      return null;
    }
    const role = candidates.find((candidate) => this.ownerAllows(task, candidate).allowed);
    if (role) {
      delete task.ownerCapBlocked;
      return role;
    }
    // Every otherwise-available candidate is over the person's daily cap. The task waits for the
    // local midnight reset rather than being handed to a different CLI outside the capability.
    task.ownerCapBlocked = true;
    return null;
  }

  // Codex (or Claude for plan/triage/accept) is configured but temporarily unusable: keep the task
  // queued and retry after a short delay instead of failing it or lending the work to another CLI.
  waitForExecutor(task, capability) {
    task.waitingFor = capability;
    if (task.ownerCapBlocked) {
      delete task.ownerCapBlocked;
      const reset = nextReset(new Date(this.now())).getTime();
      task.notBefore = reset;
      // One event per daily wait, no matter how often the planner retries before midnight.
      if (task.ownerCapNotifiedUntil !== reset) {
        task.ownerCapNotifiedUntil = reset;
        this.save(task, 'queued', 'owner_quota_cap');
      } else {
        this.save(task, 'queued', 'owner_quota_cap', false);
      }
      return;
    }
    task.notBefore = this.now() + 60_000;
    this.save(task, 'queued', 'executor_waiting:' + capability);
  }

  // Stall watchdog (after gbdev's per-role stall_timeout_s): a running step whose CLI has written nothing to its
  // log for the member's stall time is stopped as cli_stalled, so it goes to the lead to be reassigned instead
  // of hanging until the CLI's own long timeout. Output is the only signal; the time is per member
  // (adapters.<member>.stallTimeoutMs, default 10 minutes, 0 turns it off).
  watchStalls() {
    const now = this.now();
    for (const [key, controller] of this.stepControllers || []) {
      const [taskId, stepId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const task = this.tasks.get(taskId);
      const step = task?.steps?.find((item) => item.id === stepId);
      if (!step || step.state !== 'running' || controller.signal.aborted) continue;
      const limit = this.config.adapters[step.role]?.stallTimeoutMs ?? this.config.stallTimeoutMs ?? 600_000;
      if (!limit) continue;
      let last = Date.parse(step.startedAt || '') || now;
      try { last = Math.max(last, require('node:fs').statSync(path.join(this.config.stateDir, 'logs', taskId, stepId + '.log')).mtimeMs); } catch { /* no output yet */ }
      if (now - last < limit) continue;
      this.save(task, task.state, `${stepId}:stalled:${step.role}:${Math.round(limit / 60000)}`);
      controller.abort(new Error(`cli_stalled: ${Math.round(limit / 60000)} 分钟没有任何输出`));
    }
  }

  // After a stall: the same member with one of its other models, the default first, never one that already
  // stalled on this step. Returns false when there is none left or the step has switched twice already.
  switchModel(task, step) {
    const profiles = this.config.adapters[step.role]?.profiles;
    // no model set means the member's default model ran
    const tried = step.stalledModels = [...new Set([...(step.stalledModels || []), step.model || preferredModel(profiles) || '(default)'])];
    if (tried.length > 2) return false;
    const models = Object.keys(profiles?.models || this.config.adapters[step.role]?.models || {});
    const choices = newestFirst(models).filter((model) => model && !tried.includes(model));
    const next = choices[0];
    if (!next) return false;
    this.save(task, task.state, `${step.id}:model_switch:${step.role}:${step.model || 'default'}->${next}:stalled`);
    step.model = next;
    delete step.session;
    delete step.error;
    return true;
  }

  // The person guides a member from the member's own conversation (like talking to a Grok Bot teammate). A step
  // at work stops and resumes its session with the guidance; a step not started yet gets it when it starts.
  steerStep(task, stepId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('invalid_guidance');
    const step = (task.steps || []).find((item) => item.id === stepId);
    if (!step) throw new Error('unknown_step');
    if (!['queued', 'running'].includes(step.state) || terminal.has(task.state)) throw new Error('step_finished');
    step.guidance = [...(step.guidance || []), { text: text.trim(), at: new Date(this.now()).toISOString() }].slice(-10);
    this.save(task, task.state, `${stepId}:steered`);
    this.stepControllers?.get(task.id + ':' + stepId)?.abort(new Error('steered'));
    return this.status(task.id);
  }

  // The person stops one step (it looks stuck or wrong); the lead then reassigns it.
  stopStep(task, stepId) {
    const controller = this.stepControllers?.get(task.id + ':' + stepId);
    if (!controller) throw new Error('step_not_running');
    this.save(task, task.state, `${stepId}:stopped_by_person`);
    controller.abort(new Error('stopped_by_person: 你手动停止了这一步'));
    return this.status(task.id);
  }

  // Called by the service timer: refresh cached quota (a Codex read starts an App Server) and retry
  // tasks whose executor may have become available.
  tick() {
    const now = this.now();
    try { this.watchStalls(); } catch (error) { console.error('stall watch:', error.message); }
    if (!this.lastCleanupAt || now - this.lastCleanupAt >= 3600_000) {
      this.lastCleanupAt = now;
      this.cleanupNow().catch((error) => console.error('cleanup:', error.message));
    }
    this.refreshQuota().catch(() => {}).finally(() => {
      // A triage that was waiting for Claude is retried in place; the task is not lent to another CLI.
      const now = this.now();
      for (const task of this.tasks.values()) {
        if (task.state === 'triaging' && !this.running.has(task.id) && (!task.notBefore || task.notBefore <= now)) {
          delete task.notBefore;
          delete task.waitingFor;
          this.save(task, 'queued', 'triage_retry');
        }
      }
      this.pump();
    });
  }

  slots() {
    const limit = this.config.maxConcurrentTasks ?? 2;
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 8 ? limit : 2;
  }

  // Each CLI runs one process at a time, and most kinds of work prefer Antigravity, so parallel steps used to
  // queue behind one member while others sat idle. When a step's member is busy, the step moves to the next
  // member for its kind of work that is idle, available, within quota and allowed to write if the step writes.
  // A member the person chose for the task, or the lead named for the step, is waited for instead; a review
  // never moves to the author of the work it reviews.
  spillOver(task, step, taken = new Set()) {
    const role = step.role;
    const limit = (r) => this.config.cliConcurrency?.[r] ?? 1;
    const busy = (r) => taken.has(r) || (this.cliBusy.get(r) || 0) >= limit(r);
    if (!busy(role) || !step.capability || step.named || task.provider || step.fixedReview || step.pinnedReadOnly ||
        LEAD_CAPABILITIES.has(step.capability)) return;
    const authors = step.capability === 'review'
      ? (task.steps || []).filter((other) => step.dependsOn?.includes(other.id) && other.write).map((other) => other.role) : [];
    const next = this.ordered(task, step.capability, this.router.candidates(step.capability, [role, ...authors]))
      .find((candidate) => !busy(candidate) && this.ownerAllows(task, candidate).allowed &&
        (!step.write || this.router.canWrite(candidate)));
    if (!next) return;
    this.save(task, task.state, `${step.id}:reassigned:${role}->${next}:busy`);
    step.role = next;
    delete step.session;
    delete step.effort;
    // The new member's own default model, passed explicitly, so it never falls back to whatever its CLI sign-in
    // defaults to.
    const fallback = preferredModel(this.config.adapters[next]?.profiles);
    if (fallback) step.model = fallback; else delete step.model;
  }

  async acquireCli(task, step, signal) {
    const role = step.role;
    const limit = this.config.cliConcurrency?.[role] ?? 1;
    if ((this.cliBusy.get(role) || 0) >= limit) {
      this.save(task, task.state, `${step.id}:waiting:${role}`);
      await new Promise((resolve, reject) => {
        const queue = this.cliWaiters.get(role) || [];
        const waiter = { resolve };
        queue.push(waiter);
        this.cliWaiters.set(role, queue);
        signal.addEventListener('abort', () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(signal.reason);
        }, { once: true });
      });
    }
    this.cliBusy.set(role, (this.cliBusy.get(role) || 0) + 1);
    const holding = { taskId: task.id, stepId: step.id, since: this.now() };
    this.cliHolders ||= new Map();
    this.cliHolders.set(role, [...(this.cliHolders.get(role) || []), holding]);
    step.startedAt = new Date(holding.since).toISOString();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cliHolders.set(role, (this.cliHolders.get(role) || []).filter((entry) => entry !== holding));
      this.cliBusy.set(role, this.cliBusy.get(role) - 1);
      this.cliWaiters.get(role)?.shift()?.resolve();
    };
  }

  setRoute(route, bridge) {
    if (!['ssh', 'relay'].includes(route)) throw new Error('invalid_route');
    // Only this bridge's own running work blocks a switch; other people's tasks carry on.
    const busy = [...this.running.keys()].some((id) => bridge === undefined || this.tasks.get(id)?.owner === bridge);
    if (busy) throw new Error('operations_in_progress');
    if (bridge !== undefined) {
      if (!this.config.sshBridges?.includes(bridge)) throw new Error('unknown_ssh_bridge');
      if (route === 'relay' && !Object.hasOwn(this.config.relayBridges || {}, bridge)) {
        throw new Error('relay_bridge_not_configured');
      }
      this.store.put('settings', 'route:' + bridge, { value: route });
    } else {
      this.store.put('settings', 'route', { value: route });
      this.route = route;
    }
    this.pump();
    return { route, bridge };
  }

  cancel(task) {
    if (terminal.has(task.state)) return { state: task.state };
    this.running.get(task.id)?.abort(new Error('cancelled'));
    this.save(task, task.pendingRequest ? 'needs_review' : 'cancelled', 'cancel_requested');
    return { state: task.state };
  }

  bridgeRoute(workspace) {
    const name = Object.hasOwn(this.config.workspaces || {}, workspace)
      && this.config.workspaces[workspace].sshBridge;
    return name ? this.namedBridgeRoute(name) : this.route;
  }

  namedBridgeRoute(name) {
    const relay = Object.hasOwn(this.config.relayBridges || {}, name) &&
      this.store.get('settings', 'route:' + name)?.value === 'relay';
    return (relay ? 'relay:' : 'ssh:') + name;
  }

  // Fills free slots. The next slot goes to the person with the fewest tasks running, then to the oldest task,
  // so one person's queue cannot hold everyone else back.
  pump() {
    while (!this.stopped && this.running.size < this.slots()) {
      const task = this.nextTask();
      if (!task) return;
      this.start(task);
    }
  }

  nextTask() {
    // Maintenance stops new work. Tasks already executing keep their current step so a service update
    // never turns a half-finished write into a restarted step.
    if (this.maintenance) return undefined;
    const runningBy = new Map();
    for (const id of this.running.keys()) {
      const running = this.tasks.get(id);
      if (running?.slotCost === 2) return undefined;
      const owner = running?.owner || 'local';
      runningBy.set(owner, (runningBy.get(owner) || 0) + 1);
    }
    const ready = [...this.tasks.values()].filter((candidate) => {
      if (candidate.state !== 'queued' || this.running.has(candidate.id)) return false;
      if (candidate.slotCost === 2 && this.slots() < 2) return false;
      if (candidate.notBefore && candidate.notBefore > this.now()) return false;
      if (!this.files.endpoint) return true;
      const route = this.bridgeRoute(candidate.workspace);
      const port = this.files.endpoint[route];
      return port?.ready && (!route.startsWith('relay') || port.online);
    });
    let best;
    for (const candidate of ready) {     // insertion order is submission order, so ties go to the oldest
      const load = runningBy.get(candidate.owner || 'local') || 0;
      if (!best || load < best.load) best = { task: candidate, load };
    }
    return best?.task.slotCost === 2 && this.running.size ? undefined : best?.task;
  }

  // Maintenance drains rather than kills: no queued task starts, every already-running task keeps its
  // current step, and "ready" becomes true only when no task is executing. Deployment waits for that.
  maintenanceStatus() {
    const running = [...this.running.keys()].map((id) => {
      const task = this.tasks.get(id);
      const step = task?.steps?.find((candidate) => candidate.state === 'running');
      return { id, state: task?.state, detail: task?.detail, step: step?.id, role: step?.role, startedAt: step?.startedAt };
    });
    return {
      enabled: Boolean(this.maintenance),
      ...(this.maintenance || {}),
      running,
      queued: [...this.tasks.values()].filter((task) => task.state === 'queued').length,
      ready: running.length === 0,
      at: new Date(this.now()).toISOString(),
    };
  }

  setMaintenance(action = 'status', reason, source) {
    if (!['status', 'on', 'off'].includes(action)) throw new Error('invalid_maintenance_action');
    if (action === 'on') {
      this.maintenance = {
        since: this.maintenance?.since || new Date(this.now()).toISOString(),
        reason: clip(reason || 'deployment', 300),
        source: clip(source || 'admin', 120),
      };
      this.store.put('settings', 'maintenance', { value: this.maintenance });
    } else if (action === 'off') {
      this.maintenance = null;
      this.store.delete('settings', 'maintenance');
      this.pump();
    }
    return this.maintenanceStatus();
  }

  start(task) {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    const timer = task.mode === 'team' ? setTimeout(() => controller.abort(new Error('team_timeout')), teamTimeout) : undefined;
    this.run(task, controller.signal).catch((error) => {
      // The person changed direction: the task went back to its lead to plan again (revisePlan).
      if (controller.signal.reason?.message === 'revised' && task.state === 'queued') return;
      if (error.message?.startsWith('executor_waiting:')) {
        this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
        return;
      }
      if (!controller.signal.aborted || task.state !== 'cancelled') {
        if (error.message?.startsWith('budget_exceeded:')) {
          task.budget = error.budget;
          this.save(task, 'needs_review', error.message);
          return;
        }
        const unknown = task.pendingRequest && !error.remoteConfirmed;
        if (!unknown) {
          delete task.pendingRequest;
          delete task.pendingKind;
        }
        this.save(task, unknown ? 'needs_review' : 'failed', error.message);
      }
    }).finally(() => {
      clearTimeout(timer);
      this.running.delete(task.id);
      this.pump();
      this.chargeQuota(task).catch(() => {});   // after releasing the task, so review and apply are not held up
    });
  }

  // One time budget produces both deadlines. The CLI's print deadline ends first, leaving the controller
  // enough room to save the session and reap the child instead of killing it as cli_timeout.
  cliBudget(task) {
    const outer = task.mode === 'team' ? teamTimeout : this.config.cliTimeoutMs || defaultCliTimeoutMs;
    const grace = Math.min(60000, Math.max(5000, Math.floor(outer * 0.05)));
    const configured = Number.isFinite(this.config.printTimeoutMs) ? this.config.printTimeoutMs : outer - grace;
    return { outer, print: Math.max(1000, Math.min(configured, outer - 5000)) };
  }

  // Reads the bridge receipts for this attempt and keeps a compact delivery list on the step. A failed
  // write with no later success for the same target is unresolved: the step must not claim completion.
  async collectDeliveries(task, step) {
    const receipts = await readReceipts(path.join(this.config.stateDir, 'logs', task.id, step.id + '.receipts.jsonl'));
    if (!receipts.length) {
      delete step.deliveries;
      delete step.writeFailure;
      return;
    }
    step.deliveries = receipts.slice(-50).map((receipt) => ({
      operation: receipt.operation,
      ...(receipt.root && { root: receipt.root }),
      ...(receipt.path && { path: receipt.path }),
      ...(receipt.destination && { destination: receipt.destination }),
      ...(receipt.expectedVersion && { expectedVersion: receipt.expectedVersion }),
      ok: receipt.ok === true,
      ...(receipt.version && { version: receipt.version }),
      ...(Number.isFinite(receipt.size) && { size: receipt.size }),
      ...(receipt.error && { error: String(receipt.error).slice(0, 200) }),
      ...(receipt.at && { at: receipt.at }),
    }));
    const latest = new Map();
    for (const receipt of receipts) {
      if (receipt.operation !== 'write') continue;
      latest.set(String(receipt.root || '') + '\0' + String(receipt.path || ''), receipt);
    }
    const failed = [...latest.values()].find((receipt) => receipt.ok !== true);
    if (failed) {
      step.writeFailure = 'write_failed:' + (failed.path || 'unknown') +
        (failed.error ? ': ' + String(failed.error).slice(0, 200) : '');
    } else {
      delete step.writeFailure;
    }
  }

  async invoke(task, step, folder, signal, prompt = step.prompt) {
    const config = this.config.adapters[step.role];
    if (!config) throw new Error(step.role + '_not_configured');
    const bridgeTools = config.template ? step.role === 'antigravity' : ['codex', 'claude', 'grok'].includes(step.role);
    // Every step, the lead's planning included, may read the person's project and authorized folders on their
    // computer through the Bridge tools; only the lead may also use the read-only computer location. Running
    // commands stays off for planning and other read-only steps.
    const mcp = bridgeTools ? this.config.mcp : undefined;
    let attachmentDirectory;
    if (task.attachments?.length) {
      const directory = path.join(this.config.stateDir, 'worktrees', task.id, 'chat-input');
      attachmentDirectory = directory;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files = [];
      for (const item of task.attachments) {
        const name = item.id + '-' + item.name.replace(/[^\p{L}\p{N}_.-]/gu, '_');
        const filename = path.join(directory, name);
        const existing = await readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!existing || existing.length !== item.size || createHash('sha256').update(existing).digest('hex') !== item.sha256) {
          const bytes = await this.files.download(this.bridgeRoute(task.workspace), task.id,
            { operation: 'chat_attachment', attachmentId: item.id, sha256: item.sha256 }, signal);
          if (bytes.length !== item.size) throw Error('invalid_attachment');
          await writeFile(filename, bytes, { mode: 0o400 });
        }
        const copy = filename + '.txt';
        const text = await readFile(copy).then(() => copy, () => writeTextCopy(require('node:fs'), filename, item.name,
          existing && existing.length === item.size ? existing : require('node:fs').readFileSync(filename)));
        files.push({ name: item.name, path: filename, ...(text && { text }) });
      }
      prompt += attachmentNote(files);
    }
    this.spillOver(task, step);
    const release = await this.acquireCli(task, step, signal);
    // A step can be stopped on its own (stall watchdog, or the person) without cancelling the task; the reason
    // becomes the step's error and goes to the lead like any failure.
    const stepController = new AbortController();
    const stepKey = task.id + ':' + step.id;
    (this.stepControllers ||= new Map()).set(stepKey, stepController);
    const stepSignal = AbortSignal.any([signal, stepController.signal]);
    this.recordCall(step.role);
    const capability = mcp && randomBytes(32).toString('base64url');
    if (mcp) mcp.capabilities.set(capability, { taskId: task.id, workspace: task.workspace,
      runCommands: step.id !== 'group-planner' && step.role !== 'antigravity' && !readOnlyMode(task.mode) && Boolean(step.write || step.capability === 'scout'),
      // Every step may read the whole computer (on a bridge that opted in with readAnyFolder); steps that change
      // files may also write there (when the bridge also has writeAnyFolder). The project still changes by patch.
      readAnyFolder: true,
      writeFiles: step.id !== 'group-planner' && !readOnlyMode(task.mode) && Boolean(step.write) });
    try {
      const useTeam = task.mode === 'team' && task.groupPlan?.approved && step.role === 'codex' && step.write && this.teamAdapter;
      const run = useTeam || this.adapter;
      const budget = this.cliBudget(task);
      const result = await run({
        ...(useTeam && {
          taskId: task.id, stepId: step.id, owner: task.owner, project: task.project,
          repository: this.config.workspaces[task.workspace].repository,
        }),
        name: step.role, config, cwd: folder, prompt, readonly: !step.write,
        timeout: budget.outer, printTimeoutMs: budget.print, signal: stepSignal,
        log: path.join(this.config.stateDir, 'logs', task.id, step.id + '.log'),
        session: step.session, model: step.model,
        effort: step.effort || (step.role === LEAD_ROLE && task.leadEffort &&
          effortsFor(step.role, this.config.adapters[step.role], step.model).includes(task.leadEffort) ? task.leadEffort : undefined),
        mcp: mcp && { socket: mcp.socket, capability,
          receipts: path.join(this.config.stateDir, 'logs', task.id, step.id + '.receipts.jsonl') },
        attachmentDirectory,
        onSession: (id) => {
          if (step.session === id) return;
          step.session = id;
          this.save(task, task.state, step.id + ':session');
        },
      });
      if (useTeam && result.container) task.container = result.container;
      return result;
    } finally {
      mcp?.capabilities.delete(capability);
      this.stepControllers?.delete(stepKey);
      release();
    }
  }

  async run(task, signal) {
    const status = await this.refreshQuota();
    // A task that starts while the start-up model discovery is still running would otherwise pick the
    // configured default before discovery has replaced a retired model. Waiting avoids that race.
    if (this.modelCatalogReading) await this.modelCatalogReading.catch(() => {});
    task.quotaStart ||= Scheduler.quotaWindows(status);
    this.refreshModels(task);
    delete task.notBefore;
    delete task.waitingFor;
    const repo = this.config.workspaces[task.workspace].repository;
    const root = path.join(this.config.stateDir, 'worktrees', task.id);
    await mkdir(path.join(this.config.stateDir, 'logs', task.id), { recursive: true, mode: 0o700 });
    if (task.groupPlan && !task.groupPlan.approved) {
      await this.planGroup(task, repo, root, signal);
      return;
    }
    if (readOnlyMode(task.mode)) {
      await this.prepareReadOnly(task, signal);
      if (!task.steps.length) return;
    }
    if (!task.base) {
      const { head, clean } = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'command.execute', {
        operation: 'git_baseline', workspace: task.workspace,
      });
      if (!clean || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error('windows_workspace_dirty');
      if (task.groupPlan && task.groupPlan.base !== head) throw new Error('plan_workspace_changed');
      await git(repo, ['cat-file', '-e', head + '^{commit}'], signal);
      task.base = head;
    }
    if (task.pendingTriage || task.escalation?.active) {
      // consumePendingTriage also runs the triage it starts; only a triage recovered from an earlier
      // crash reaches runTriage directly.
      if (task.pendingTriage) await this.consumePendingTriage(task, repo, root, signal);
      else await this.runTriage(task, repo, root, signal);
      return;
    }
    if (!task.steps.length && task.provider) {
      if (task.mode === 'edit' && (!this.router.available(task.provider) ||
          !this.router.quotaAllowsDirect(task.provider) || !this.ownerAllows(task, task.provider).allowed)) {
        throw new Error('executor_waiting:implement');
      }
      task.steps = [{ id: task.provider, role: task.provider, model: task.model, prompt: task.prompt,
        dependsOn: [], write: this.router.canWrite(task.provider), state: 'queued', attempts: 0 }];
    }
    if (!task.steps.length) {
      this.save(task, 'planning', 'planning_started');
      if (!task.planRaw) {
        const lead = this.pickForTask(task, 'plan');
        if (!lead) {
          this.waitForExecutor(task, 'plan');
          return;
        }
        const planner = { id: 'planner', role: lead, capability: 'plan', write: false, prompt: PLANNER_PROMPT + task.prompt + (this.projectBrief(task) ? '\nProject context: ' + JSON.stringify(this.projectBrief(task)) : '') };
        const folder = path.join(root, 'planner');
        await this.ensureWorktree(repo, folder, task, planner, signal);
        const { output } = await this.execute(task, planner, folder, signal, planner.prompt);
        task.planRaw = output;
      }
      try {
        task.steps = parsePlan(task.planRaw, this.availableRoles(), this.router,
          (capability, exclude) => this.pickForTask(task, capability, exclude),
          (role) => this.ownerAllows(task, role).allowed);
      } catch (error) {
        if (!error.message.startsWith('executor_waiting:')) throw error;
        // Keep the plan text so the next attempt does not pay for planning again.
        this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
        return;
      }
      delete task.planRaw;
    }
    // A step left "running" belongs to a run that is no longer alive (the service stopped mid-step and the
    // task was put back in line later). Nothing of this task is executing now, so put those steps back in
    // line; otherwise the loop below finds no ready step and fails the whole task with dependency_failed.
    for (const step of task.steps) {
      if (step.state === 'running') step.state = 'queued';
    }
    this.save(task, 'running', 'plan_ready');
    for (;;) {
      while (task.steps.some((step) => !this.isAcceptStep(step) && step.state === 'queued')) {
        signal.throwIfAborted();
        const ready = task.steps.filter((step) => step.state === 'queued' && !this.isAcceptStep(step) &&
          step.dependsOn.every((id) => ['completed', 'skipped'].includes(task.steps.find((dep) => dep.id === id).state)));
        // One step per member at a time; a further ready step for a member already in this wave moves to an idle
        // member of its kind of work (spillOver) instead of waiting for the next wave.
        const taken = new Set();
        const wave = [];
        for (const step of ready) {
          if (taken.has(step.role)) this.spillOver(task, step, taken);
          if (taken.has(step.role)) continue;
          taken.add(step.role);
          wave.push(step);
        }
        if (!wave.length) {
          // The same staleness can appear while the loop runs if a step was requeued from outside. Reset
          // once and try again; a dependency that is really failed or replaced still ends the task below.
          const stale = task.steps.filter((step) => step.state === 'running');
          if (!stale.length) throw new Error('dependency_failed');
          for (const step of stale) step.state = 'queued';
          continue;
        }
        const results = await Promise.allSettled(wave.map((step) => this.runStep(task, step, repo, root, signal)));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) {
          if (!this.requestReassign(task, failed.reason, signal)) throw failed.reason;
          await this.consumePendingTriage(task, repo, root, signal);
          return;
        }
      }
      signal.throwIfAborted();
      // Steps the lead added after a change of direction and the person has not confirmed yet: the task waits.
      if (task.steps.some((step) => step.state === 'proposed')) {
        this.save(task, 'awaiting_approval', 'revise_needs_approval');
        return;
      }
      // Competing review verdicts are escalated before acceptance; the triage may add fix steps.
      if (task.pendingTriage) {
        await this.consumePendingTriage(task, repo, root, signal);
        return;
      }
      const outcome = await this.finalize(task, repo, root, signal);
      if (outcome === 'rework') continue;
      if (outcome !== 'accept') return;
      break;
    }
    signal.throwIfAborted();
    const writers = task.steps.filter((step) => step.write && step.paths?.length && !step.supersededBy);
    const seen = new Set();
    for (const step of writers) {
      for (const file of step.paths) {
        const key = file.normalize('NFC').toLowerCase();
        if (seen.has(key)) {
          this.save(task, 'needs_review', 'overlapping_change:' + file);
          return;
        }
        seen.add(key);
      }
    }
    if (writers.length) {
      this.save(task, 'needs_review', 'patches_ready');
      return;
    }
    if (task.command) {
      const passed = await this.runTests(task, signal);
      if (!passed) {
        if (task.pendingTriage) await this.consumePendingTriage(task, repo, root, signal);
        return;
      }
    }
    this.save(task, 'completed', 'completed');
  }

  async planGroup(task, repo, root, signal) {
    this.save(task, 'planning', 'planning_started');
    const plan = task.groupPlan;
    if (!plan.base) {
      const { head } = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'command.execute', {
        operation: 'git_baseline', workspace: task.workspace,
      });
      if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('invalid_workspace_baseline');
      await git(repo, ['cat-file', '-e', head + '^{commit}'], signal);
      plan.base = head;
    }
    const context = {
      request: task.prompt, preferredExecutor: task.provider, preferredModel: task.model,
      availableExecutors: this.availableRoles(),
      quotaUsedPercent: this.router.quota,
      capabilities: Object.fromEntries(Object.entries(this.router.routes)
        .map(([name, list]) => [name, this.ordered(task, name, list.filter((role) => this.router.available(role)))])),
      ...(task.routeOrder && { personPreferredOrder: task.routeOrder }),
      models: plannerProfiles(this.availableRoles(), this.config.adapters, task.provider, task.model),
      projectBrief: this.projectBrief(task),
      rounds: plan.rounds.slice(-8).map(({ questions, summary, reply }) => ({ questions, summary, reply })),
      ...(task.keptSteps?.length && { completedWork: task.keptSteps.map(({ id, role, capability, output, paths }) => ({
        id, role, capability, output: String(output || '').slice(0, 1200), ...(paths?.length && { paths: paths.slice(0, 40) }) })) }),
    };
    const prompt = [
      'You are 组长, the group lead. Stay in read-only planning mode. Inspect the checked-out code when useful.',
      'The checkout here is a copy on the server. The person\u2019s real project and the folders they authorized (for example their Desktop) are on their computer: call windows_list_locations, then list, search, grep and read files there with the windows_* tools (pass the location id as root). When the computer location is listed, use it read-only to inspect any folder in the person\u2019s home, mounted volumes or temporary folders; system and credential folders are blocked. Members can read there too, and members whose steps change files can create, change, move and delete files there (windows_write_file, windows_make_directory, windows_move_path, windows_delete_path); plan such work as implement steps and name the folder in the step prompt. Project files are still changed in the task workspace and applied as a reviewed patch. Read what you need before asking; do not ask the person to paste files you can read.',
      'Reply with the JSON object alone, with no text before or after it and no code fence.',
      'When completedWork is present the person changed direction while the work was under way: that work is done and kept. Plan only what remains under the newest reply, build on the finished work instead of redoing it, and do not depend on its step ids.',
      'Ask the requester every material question you cannot resolve from the repository or the discussion. Ask specific questions and offer options when helpful. Do not re-ask answered questions or ask about details you can determine.',
      'If clarification is needed return only JSON {"questions":["question 1","question 2"]}, at most 6 questions, each at most 600 characters. You can ask more in a later round.',
      'When clear return only JSON {"summary":"outline the scope and validation in at most 1800 characters","steps":[{"id":"step","capability":"implement","prompt":"concrete work and checks","dependsOn":[]}]}. User-visible text should match the requester’s language.',
      CAPABILITY_GUIDE,
      'Use at most 12 steps and at most 1000 characters per step prompt. If a preferred executor is selected, return exactly one step and set its role to that executor.',
      'Use each integration’s strengths and model-specific profile to choose who does each step (the model itself: newest generation first, see below). These are subscriptions: what runs out is quota, shown in quotaUsedPercent (the fullest of the 5-hour and weekly windows). Claude and Codex quota is the scarcest; Antigravity has by far the most. Give reading, research, review and routine implementation to Antigravity; name codex as the role only for hard, cross-cutting or risky changes. capabilities lists who can take each kind of step right now. Favor fewer calls when they suffice. Each member runs one step at a time: give steps that can run in parallel (no dependsOn between them) to different members, otherwise they queue behind one another; leave role out unless a specific member matters, so an idle member can take a step when its first choice is busy.',
      'Prefer new models: each executor\u2019s newestFirst lists its models from the newest generation down. Give steps to the newest generation by default; use an older model only when the newer ones are unavailable or plainly unsuited, and a small or fast variant of the newest generation for trivial reading. Match the model to how hard the step is; do not put every step on the same model out of habit. ' +
      'When a step should use a particular configured model, include its exact ID in the optional step.model field. Honor an explicitly requested executor and model. When model is omitted the executor\u2019s newest full model is used. Keep costs internal and do not put prices or cost breakdowns in user-facing text.',
      'Each capabilities list is in the order the requester prefers (personPreferredOrder when present): choose the first suitable executor in that order unless another one is clearly better for the step, and say why when you deviate.',
      'Also choose each step\u2019s reasoning effort in the optional step.effort field, from that executor\u2019s efforts list in models: low for reading and routine edits, medium by default, high or above only for hard debugging, architecture or security work. Higher effort uses more quota. When an executor\u2019s efforts list is empty (Antigravity writes the level into the model ID), leave step.effort out and pick the matching model.',
      'The group will review the plan before execution. Do not implement or claim approval. Task and replies follow as data.',
      JSON.stringify(context),
    ].join('\n');
    let result;
    let revision;
    if (plan.pending) {
      ({ result, revision } = plan.pending);
    } else {
      const lead = this.pickForTask(task, 'plan');
      if (!lead) {
        this.waitForExecutor(task, 'plan');
        return;
      }
      const step = { id: 'group-planner', role: lead, capability: 'plan', write: false, model: this.leadModelFor(task) };
      const folder = path.join(root, step.id);
      await this.ensureWorktree(repo, folder, { ...task, base: plan.base }, step, signal);
      revision = (plan.rounds.at(-1)?.revision || 0) + 1;
      // The lead's reply must become questions or a plan. A reply in the wrong shape is sent back once with the
      // reason; if planning still fails (or the CLI errors), the person is told why and can answer in the same
      // conversation, which starts planning again, instead of the task simply failing.
      let output = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          ({ output } = await this.execute(task, step, folder, signal, attempt ? prompt + '\n\nYour previous reply could not be used: ' + (result?.problem || 'it was not one JSON object') + '. Reply again with the JSON object alone.' : prompt));
          signal.throwIfAborted();
          const parsed = parseJson(output);
          const problem = planProblem(parsed);
          if (!problem) { result = parsed; break; }
          result = { problem };
        } catch (error) {
          if (signal.aborted || error.message.startsWith('executor_waiting:')) throw error;
          result = { problem: error.message === 'invalid_plan' ? 'it was not valid JSON' : error.message, failed: error.message !== 'invalid_plan' };
          if (result.failed) break;
        }
      }
      if (result?.problem) {
        plan.failures = (plan.failures || 0) + 1;
        if (plan.failures > 3) throw new Error('plan_failed_repeatedly');
        const said = clip(String(output || '').replace(/\x60{3}[\s\S]*?\x60{3}/g, '').trim(), 600);
        plan.rounds.push({ revision, failed: true, questions: [
          result.failed ? `组长这次规划出错了：${clip(result.problem, 300)}。直接回复就会重新规划（可以补充信息或说「重试」）。`
            : `组长的回复没能整理成问题或方案（${result.problem}）。${said ? '它说：' + said + '。' : ''}直接回复就会重新规划。`] });
        this.save(task, 'awaiting_details', 'plan_failed', true, { revision });
        return;
      }
      plan.failures = 0;
    }
    if (Array.isArray(result?.questions)) {
      delete plan.pending;
      plan.rounds.push({ revision, questions: result.questions.filter((question) => typeof question === 'string' && question.trim())
        .slice(0, 8).map((question) => clip(question, 1200)) });
      this.save(task, 'awaiting_details', 'plan_questions', true, { revision });
      return;
    }
    if (typeof result?.summary !== 'string' || !result.summary.trim()) throw new Error('invalid_plan');
    result.summary = clip(result.summary, 3000);
    let steps;
    try {
      steps = validateSteps(result.steps, this.availableRoles(), this.router,
        (capability, exclude) => this.pickForTask(task, capability, exclude),
        (role) => this.ownerAllows(task, role).allowed);
      if (!steps.every((step) => step.prompt.length <= 1000) || (task.provider && steps.length !== 1)) throw new Error('invalid_plan');
      this.addDuoReviews(task, steps);
    } catch (error) {
      if (!error.message.startsWith('executor_waiting:')) throw error;
      plan.pending = { result, revision };
      this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
      return;
    }
    delete plan.pending;
    if (task.provider) {
      steps[0].role = task.provider;
      steps[0].write = task.provider !== 'gemini';
    }
    for (const [index, step] of steps.entries()) {
      const selected = (index === 0 ? task.model : undefined) || result.steps[index]?.model;
      const { models } = context.models[step.role];
      if (selected !== undefined && (typeof selected !== 'string' || !Object.hasOwn(models, selected))) throw new Error('invalid_plan');
      step.model = selected || preferredModel(this.config.adapters[step.role]?.profiles);
      // The lead picks each member's reasoning effort too; an unknown level is dropped, not an error.
      const effort = result.steps[index]?.effort;
      if (typeof effort === 'string' && effortsFor(step.role, this.config.adapters[step.role], step.model).includes(effort)) step.effort = effort;
    }
    plan.rounds.push({ revision, summary: result.summary, steps });
    this.save(task, 'awaiting_approval', 'plan_proposed');
    // A small plan starts by itself when the group allows it; the final changes still wait for the person's review.
    if (this.autoApproves(task, steps)) {
      this.approveRound(task, plan.rounds.at(-1));
      this.save(task, 'queued', 'plan_auto_approved');
    }
  }

  // always (when the client says nothing, e.g. WeChat): every plan waits for the person. small (the desktop's
  // default): a plan that changes no files, or has at most three steps, starts by itself. auto: every plan does.
  autoApproves(task, steps) {
    const mode = task.approval || 'always';
    if (mode === 'auto') return true;
    if (mode !== 'small' || !steps?.length) return false;
    return !steps.some((step) => step.write) || steps.length <= 3;
  }

  // The plan's steps become the task's steps; after a change of direction the steps already done stay first.
  approveRound(task, round) {
    task.groupPlan.approved = round.revision;
    const kept = (task.keptSteps || []).map((step) => ({ ...step }));
    const taken = new Set(kept.map((step) => step.id));
    const renamed = new Map();
    for (const step of round.steps) {
      let next = step.id;
      for (let n = 2; taken.has(next); n += 1) next = step.id + '-' + n;
      taken.add(next);
      renamed.set(step.id, next);
    }
    task.steps = [...kept, ...round.steps.map((step) => ({ ...step, id: renamed.get(step.id),
      dependsOn: (step.dependsOn || []).map((id) => renamed.get(id) || id) }))];
  }

  isAcceptStep(step) {
    return /^accept-\d+$/.test(step.id);
  }

  acceptanceRequired(task) {
    // A direct edit is reviewed by its owner through the existing patch preview/apply flow.
    if (task.mode === 'edit') return false;
    if (readOnlyMode(task.mode)) return false;
    if (task.mode === 'duo') return true;
    if (!this.acceptance.enabled) return false;
    return this.acceptance.mode === 'always' || task.steps.some((step) => step.write) || task.steps.length >= 2;
  }

  // Runs after the execution steps and before overlaps are checked. A rework adds steps and sends the
  // task back through the execution loop; acceptance therefore sees the final tree, not the first draft.
  async finalize(task, repo, root, signal) {
    if (task.acceptance?.verdict === 'rework' && !task.acceptance.reworkDone) {
      return this.appendRework(task, task.acceptance);
    }
    // A plan may already contain an accept step. Its verdict is the acceptance; adding accept-1 after it
    // would ask the lead the same question over the same tree for no new evidence.
    const planned = [...task.steps].reverse().find((step) => step.capability === 'accept' &&
      !this.isAcceptStep(step) && step.state === 'completed' && step.verdict);
    if (planned && task.acceptance?.stepId !== planned.id) return this.handleAcceptance(task, planned);
    const acceptSteps = task.steps.filter((step) => this.isAcceptStep(step));
    const pending = acceptSteps.find((step) => ['queued', 'running'].includes(step.state));
    if (pending) {
      pending.state = 'queued';
      return this.runAcceptance(task, pending, repo, root, signal);
    }
    const latest = acceptSteps.at(-1);
    if (latest?.state === 'completed' && latest.verdict && task.acceptance?.stepId !== latest.id) {
      return this.handleAcceptance(task, latest);
    }
    if (task.acceptance) {
      if (['accept', 'pass', 'accept_with_risk'].includes(task.acceptance.verdict)) return 'accept';
      if (['reject', 'blocked'].includes(task.acceptance.verdict)) return 'reject';
      if (task.acceptance.verdict === 'unknown') return 'unknown';
      if (task.acceptance.verdict === 'limit') return 'limit';
      // A rework that already ran falls through to a fresh acceptance round.
    }
    if (!this.acceptanceRequired(task)) {
      this.save(task, task.state, 'acceptance_skipped');
      return 'accept';
    }
    const lead = this.pickForTask(task, 'accept');
    if (!lead) {
      const configured = (this.router.routes.accept || []).filter((role) => this.router.configured(role));
      throw new Error(configured.length ? 'executor_waiting:accept' : 'no_executor:accept');
    }
    const round = acceptSteps.length + 1;
    const step = {
      id: 'accept-' + round, role: lead, capability: 'accept', write: false, usesBrief: true, model: this.leadModelFor(task),
      state: 'queued', attempts: 0,
      dependsOn: task.steps.filter((item) => !this.isAcceptStep(item) && item.state === 'completed').map((item) => item.id),
      prompt: 'You are the lead accepting this task. Decide whether the work satisfies the request and the plan.',
      brief: buildAcceptanceBrief(task),
    };
    task.steps.push(step);
    task.stage = 'awaiting_acceptance';
    return this.runAcceptance(task, step, repo, root, signal);
  }

  async runAcceptance(task, step, repo, root, signal) {
    task.stage = 'awaiting_acceptance';
    this.save(task, 'awaiting_acceptance', 'acceptance_started');
    delete step.verdict;
    await this.runStep(task, step, repo, root, signal);
    signal.throwIfAborted();
    return this.handleAcceptance(task, step);
  }

  handleAcceptance(task, step) {
    const verdict = step.verdict || parseReviewVerdict(step.output);
    step.verdict ||= verdict;
    const findings = (verdict.findings || []).slice(0, 20).map((finding) => ({
      severity: finding.severity,
      ...(finding.file && { file: clip(finding.file, 200) }),
      ...(finding.line && { line: finding.line }),
      issue: clip(finding.issue, 400),
      ...(finding.suggestion && { suggestion: clip(finding.suggestion, 400) }),
    }));
    const acceptanceSteps = task.steps.filter((item) => this.isAcceptStep(item) || item.capability === 'accept');
    const round = acceptanceSteps.indexOf(step) + 1;
    task.acceptance = {
      verdict: verdict.verdict, round, stepId: step.id, summary: clip(verdict.summary, 600), findings,
      at: new Date(this.now()).toISOString(), reworkDone: false,
    };
    this.save(task, task.state, 'acceptance_verdict:' + verdict.verdict);
    if (['accept', 'pass'].includes(verdict.verdict)) {
      task.stage = 'accepted';
      return 'accept';
    }
    if (verdict.verdict === 'rework') {
      if ((task.reworkRounds || 0) >= this.acceptance.maxRework) {
        task.acceptance.verdict = 'limit';
        this.save(task, 'needs_review', 'acceptance_limit');
        return 'limit';
      }
      task.stage = 'reworking';
      return this.appendRework(task, task.acceptance);
    }
    if (['reject', 'blocked'].includes(verdict.verdict)) {
      this.save(task, 'failed', 'rejected_by_lead');
      return 'reject';
    }
    this.save(task, 'needs_review', 'acceptance_unparseable');
    return 'unknown';
  }

  // One implementation step per rework round. When there is a writer to build on, the rework runs in
  // that writer's worktree and its cumulative patch supersedes the writer's earlier patch.
  appendRework(task, acceptance) {
    const role = this.pickForTask(task, 'implement');
    if (!role) {
      const configured = (this.router.routes.implement || []).filter((candidate) => this.router.configured(candidate));
      throw new Error(configured.length ? 'executor_waiting:implement' : 'no_executor:implement');
    }
    const parent = [...task.steps].reverse()
      .find((step) => step.write && step.paths?.length && !step.supersededBy);
    const findings = (acceptance.findings || []).map((finding) =>
      [finding.severity, finding.file, finding.line, finding.issue, finding.suggestion].filter(Boolean).join(': ')).join('\n');
    const step = {
      id: 'rework-' + ((task.reworkRounds || 0) + 1), role, capability: 'implement', write: true,
      state: 'queued', attempts: 0, dependsOn: [],
      prompt: 'Address the acceptance findings and finish the task.' +
        (acceptance.summary ? '\nAcceptance summary: ' + acceptance.summary : '') +
        (findings ? '\nFindings:\n' + findings : ''),
      ...(parent && { reworkOf: parent.id }),
    };
    task.steps.push(step);
    task.reworkRounds = (task.reworkRounds || 0) + 1;
    acceptance.reworkDone = true;
    this.save(task, 'queued', 'acceptance_rework');
    return 'rework';
  }

  async ensureWorktree(repo, folder, task, step, signal) {
    if (await readFile(path.join(folder, '.git'), 'utf8').then(() => true, () => false)) return;
    await worktree(repo, folder, 'agentdesk/' + task.id + '/' + step.id, task.base, signal);
  }

  // Records one conflict event per set of competing review verdicts. Two negative reviews are not a
  // conflict: their findings are merged for whoever reworks the change.
  trackReviewConflict(task) {
    const reviews = task.steps.filter((step) => step.capability === 'review' && step.verdict);
    if (reviews.length > 1) task.mergedFindings = mergeFindings(reviews.map((step) => step.verdict));
    if (!reviewConflicts(reviews.map((step) => step.verdict))) return;
    const key = reviews.map((step) => step.id).sort().join(',');
    if (task.reviewConflictKey === key) return;
    task.reviewConflictKey = key;
    task.reviewConflicts = (task.reviewConflicts || 0) + 1;
    // One escalation request per stage; a second conflicting review while triage is pending is the same
    // problem, not a new one.
    if (!task.escalation?.active) task.pendingTriage ||= { reason: 'review_conflict', applied: Boolean(task.applied) };
    this.save(task, task.state, 'review_conflict');
  }

  async runStep(task, step, repo, root, signal) {
    // A review of a writer's work must look at that writer's uncommitted changes, so it shares the
    // writer's worktree. Any change made while the reviewer runs is detected and rejected below.
    let sharedWriter;
    if (step.capability === 'review') {
      const writers = task.steps.filter((dep) => dep.write && step.dependsOn.includes(dep.id));
      if (writers.length > 1) throw new Error('ambiguous_review_target');
      [sharedWriter] = writers;
    } else if (step.reworkOf) {
      sharedWriter = task.steps.find((dep) => dep.id === step.reworkOf);
      if (!sharedWriter?.write) throw new Error('invalid_rework_target');
    }
    const reviewOnly = task.mode === 'review_only';
    const readonlyStep = step.capability === 'review' && Boolean(sharedWriter || reviewOnly);
    const folder = path.join(root, sharedWriter?.id || step.id);
    await this.ensureWorktree(repo, folder, task, sharedWriter || step, signal);
    const dependencies = task.steps.filter((dep) => step.dependsOn.includes(dep.id))
      .map((dep) => ({ id: dep.id, output: dep.output?.slice(0, 4000), paths: dep.paths?.slice(0, 50),
        patch: dep.paths?.length ? path.join(root, dep.id + '.patch') : undefined,
      }));
    if (reviewOnly) {
      const patch = path.join(root, 'review-input.patch');
      await git(folder, ['reset', '--hard', task.base], signal);
      await git(folder, ['clean', '-fd'], signal);
      await git(folder, ['apply', '--index', '--binary', patch], signal);
    }
    const before = readonlyStep ? await worktreeState(folder, signal) : undefined;
    const savedState = () => ['awaiting_acceptance', 'triaging'].includes(task.state) ? task.state : 'running';
    const receiptsFile = path.join(this.config.stateDir, 'logs', task.id, step.id + '.receipts.jsonl');
    if (!step.attempts) await writeFile(receiptsFile, '', { mode: 0o600 });
    delete step.writeFailure;
    let continuationNote = '';
    for (;;) {
      const quotaAllowed = step.pinnedReadOnly && task.mode === 'chat' && task.tags?.includes('direct')
        ? this.router.quotaAllowsDirect(step.role) : this.router.quotaAllows(step.role, step.capability);
      if ((step.fixedReview || step.pinnedReadOnly) &&
          (!this.router.available(step.role) || !quotaAllowed || !this.ownerAllows(task, step.role).allowed)) {
        throw new Error('executor_waiting:' + step.capability);
      }
      this.checkBudget(task);
      step.state = 'running';
      step.attempts += 1;
      this.save(task, savedState(), step.id + ':started');
      try {
        let prompt = dependencies.length ? step.prompt + '\nUpstream results: ' + JSON.stringify(dependencies) : step.prompt;
        if (readonlyStep) {
          prompt += '\nReview the uncommitted changes in this working tree. Do not change files.';
        } else if (sharedWriter) {
          prompt += `\nContinue in the existing working tree of ${sharedWriter.id}; your change builds on it.`;
        }
        if (step.usesBrief) {
          const stage = step.capability === 'accept' ? 'acceptance'
            : step.capability === 'triage' ? 'triage' : 'lead';
          const brief = step.brief || (stage === 'acceptance' ? buildAcceptanceBrief(task)
            : stage === 'triage' ? buildTriageBrief(task, step.reason || task.escalation?.reason)
              : buildLeadBrief(task, stage));
          const projectBrief = stage === 'triage' && this.projectBrief(task);
          if (projectBrief) brief.projectBrief = projectBrief;
          task.briefs ||= {};
          task.briefs[stage] = brief;
          // No raw upstream transcripts, logs or patches are sent to the lead.
          prompt = step.prompt + '\n\nBrief (summaries only, not raw logs): ' + JSON.stringify(brief);
        }
        // What the person said to this member in its own conversation, newest last; it takes priority.
        if (step.guidance?.length) prompt += '\n\nThe person gave this guidance in your conversation while you worked; follow it, it takes priority over the plan where they conflict:\n' +
          step.guidance.map((item) => '- ' + item.text).join('\n');
        if (step.capability === 'review') prompt += '\n\n' + REVIEW_INSTRUCTION;
        else if (step.capability === 'accept') prompt += '\n\n' + ACCEPTANCE_INSTRUCTION;
        else if (step.capability === 'triage') prompt += '\n\n' + TRIAGE_INSTRUCTION;
        if (continuationNote) prompt += continuationNote;
        const { output } = await this.execute(task, step, folder, signal, prompt);
        signal.throwIfAborted();
        await this.collectDeliveries(task, step);
        if (step.writeFailure) throw new Error(step.writeFailure);
        step.output = output;
        const verdict = ['review', 'accept'].includes(step.capability) ? parseReviewVerdict(output) : null;
        if (verdict) step.verdict = verdict;
        if (readonlyStep) {
          if (await worktreeState(folder, signal) !== before) throw new Error('readonly_step_changed_files');
          // The writer's patch belongs to the writer step; a review must not claim it.
          step.paths = [];
          if (sharedWriter) step.reviewedStep = sharedWriter.id;
        } else {
          const { paths, patch } = await patchFor(folder, task.base, signal);
          if (!step.write && paths.length) throw new Error('readonly_step_changed_files');
          if (paths.length) await writeFile(path.join(root, step.id + '.patch'), patch, { mode: 0o600 });
          step.paths = paths;
          // A rework patch is cumulative over its parent, so only the newest patch is applied.
          if (sharedWriter) sharedWriter.supersededBy = step.id;
        }
        step.state = 'completed';
        this.save(task, savedState(), step.id + ':completed');
        if (verdict) {
          task.reviews ||= {};
          task.reviews[step.id] = { ...verdict, role: step.role, capability: step.capability };
          this.save(task, savedState(), 'review_verdict:' + step.id + ':' + verdict.verdict);
          this.trackReviewConflict(task);
        }
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error.message.startsWith('executor_waiting:')) {
          step.state = 'queued';
          throw error;
        }
        await this.collectDeliveries(task, step).catch(() => {});
        // The CLI stopped at its own print deadline: the conversation is intact, so continue it instead
        // of paying for the step again. The limit keeps a model that never finishes from running forever.
        if (error.message.startsWith('cli_print_timeout') && step.session) {
          const limit = Math.max(0, Math.min(3, this.config.maxContinuations ?? 1));
          const used = step.continuations || 0;
          if (used < limit) {
            step.continuations = used + 1;
            delete step.error;
            continuationNote = '\n\nYour previous turn was cut off by the CLI print deadline (continuation ' +
              step.continuations + '/' + limit + '). Continue the same session. Do not repeat changes that already ' +
              'succeeded; re-check each file version before writing. Finish the remaining work and report exactly ' +
              'which files you changed and which checks passed.';
            this.save(task, savedState(), step.id + ':continuing:' + step.continuations + '/' + limit);
            continue;
          }
        }
        if (step.attempts < 2 && step.session && error.message.startsWith('cli_exit_')) continue;
        // A stalled step first tries another model of the same member (at most twice) before it goes to the lead.
        // The person steered the step: it continues in the same session with their guidance.
        if (error.message === 'steered') continue;
        // The lead took this step out after the person changed direction.
        if (step.revisedOut) {
          step.state = 'skipped';
          this.save(task, task.state, step.id + ':revised_out');
          return;
        }
        if (error.message.startsWith('cli_stalled') && this.switchModel(task, step)) continue;
        step.state = 'failed';
        step.error = error.message;
        this.save(task, savedState(), step.id + ':failed');
        throw error;
      }
    }
  }

  async test(task, signal) {
    task.pendingRequest = messageId();
    task.pendingKind = 'test';
    this.save(task, 'testing', 'windows_test_started');
    task.testResult = await this.files.endpoint.request(this.bridgeRoute(task.workspace), task.id, 'command.execute', {
      operation: 'run', workspace: task.workspace, command: task.command, permission: 'development',
      timeout_ms: 300000,
    }, 310000, task.pendingRequest, signal);
    delete task.pendingRequest;
    delete task.pendingKind;
    if (task.testResult.code !== 0) throw new Error('windows_test_failed');
  }

  // Runs the task command with one immediate retry. A success clears the consecutive-failure count; two
  // failures in a row request a lead triage instead of failing silently or looping forever.
  async runTests(task, signal) {
    task.testFailures ||= 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.test(task, signal);
        task.testFailures = 0;
        delete task.lastTestFailure;
        return true;
      } catch (error) {
        if (error.message !== 'windows_test_failed') throw error;
        task.testFailures += 1;
        task.lastTestFailure = 'windows_test_failed';
        this.save(task, task.state, 'test_failed:' + task.testFailures);
      }
    }
    task.pendingTriage ||= { reason: 'test_failures', applied: Boolean(task.applied) };
    return false;
  }

  // A planned step failed. Unless the task was cancelled, is waiting for an executor, or has used its
  // reassignments, the failure goes to the lead, who reassigns the step or replans it (MAX_REASSIGN times).
  requestReassign(task, error, signal) {
    if (signal.aborted || !error || error.message?.startsWith('executor_waiting:') || error.message?.startsWith('budget_exceeded:')) return false;
    const failed = task.steps.filter((step) => step.state === 'failed' && step.capability &&
      !['triage', 'accept', 'plan'].includes(step.capability));
    if (!failed.length || task.escalation?.active) return false;
    const spent = failed.find((step) => (step.reassigns || 0) >= MAX_REASSIGN);
    if (spent) {
      this.save(task, task.state, 'reassign_limit:' + spent.id);
      return false;
    }
    for (const step of failed) {
      step.reassigns = (step.reassigns || 0) + 1;
      step.failedRoles = [...new Set([...(step.failedRoles || []), step.role])];
      step.history = [...(step.history || []), { role: step.role, model: step.model, error: clip(step.error || error.message, 200) }];
      this.save(task, task.state, `step_failed:${step.id}:${step.role}`);
    }
    task.lastStepFailure = failed.map((step) => ({ step: step.id, role: step.role, model: step.model, capability: step.capability,
      error: clip(step.error || error.message, 600), tried: step.history, round: step.reassigns, limit: MAX_REASSIGN }));
    // The lead may switch to another member or another model of the same member; these are the choices.
    task.reassignOptions = plannerProfiles(this.availableRoles().filter((role) => role !== LEAD_ROLE), this.config.adapters);
    task.pendingTriage ||= { reason: 'step_failed', applied: Boolean(task.applied) };
    return true;
  }

  // The executor the lead named, when it can take this capability now; otherwise undefined.
  namedExecutor(task, capability, executor) {
    if (typeof executor !== 'string' || executor === LEAD_ROLE) return undefined;
    return this.router.candidates(capability, []).includes(executor) && this.ownerAllows(task, executor).allowed
      ? executor : undefined;
  }

  // Retry after a failure: the lead's choice, else the next executor for the capability that has not failed
  // this step, else the same one again.
  // A model named without a member stays with the same member (switching model is a reassignment too).
  reassignStep(task, step, decision = {}) {
    const named = this.namedExecutor(task, step.capability, decision.executor);
    const sameRoleModel = !named && decision.model && Object.hasOwn(this.config.adapters[step.role]?.profiles?.models || {}, decision.model);
    let next = named || (sameRoleModel ? step.role : this.pickForTask(task, step.capability, step.failedRoles || [])) || step.role;
    if (step.write && !this.router.canWrite(next)) next = step.role;
    const before = step.role + (step.model ? '/' + step.model : '');
    if (next !== step.role) {
      step.role = next;
      delete step.session;
      delete step.model;
      delete step.effort;
    }
    this.chooseModel(step, decision);
    const after = step.role + (step.model ? '/' + step.model : '');
    if (after !== before) this.save(task, task.state, `${step.id}:reassigned_by_lead:${before}->${after}`);
  }

  // A plan can outlive the model list it was made from (an operator removes or renames a model). Replace a
// model no longer configured with the role's default, so stale planned steps do not fail one by one.
  refreshModels(task) {
    const fix = (step) => {
      if (!step || typeof step !== 'object') return;
      const profiles = this.config.adapters[step.role]?.profiles;
      if (step.model && !Object.hasOwn(profiles?.models || {}, step.model)) {
        const fallback = preferredModel(profiles);
        if (fallback) step.model = fallback;
        else delete step.model;
        delete step.session;
      }
      if (step.effort && !effortsFor(step.role, this.config.adapters[step.role], step.model).includes(step.effort)) delete step.effort;
    };
    for (const step of task.steps || []) fix(step);
    for (const round of task.groupPlan?.rounds || []) for (const step of round.steps || []) fix(step);
  }

  // The lead's model and effort for a step, when the step's member has them; otherwise its defaults.
  chooseModel(step, choice = {}) {
    const config = this.config.adapters[step.role];
    if (typeof choice.model === 'string' && Object.hasOwn(config?.profiles?.models || {}, choice.model)) {
      if (choice.model !== step.model) delete step.session;
      step.model = choice.model;
    }
    if (!step.model) {
      const fallback = preferredModel(config?.profiles);
      if (fallback) step.model = fallback;
    }
    if (typeof choice.effort === 'string' && effortsFor(step.role, config, step.model).includes(choice.effort)) step.effort = choice.effort;
  }

  // Rework after a failure: the new steps take the failed step's place, with its inputs and its dependents.
  // The new steps are placed right after the failed one, so the plan board shows them in its place.
  replaceFailedSteps(task, steps) {
    const failedSteps = task.steps.filter((step) => step.state === 'failed');
    if (!steps.length || !failedSteps.length) return false;
    const last = steps.at(-1).id;
    for (const failed of failedSteps) {
      failed.state = 'replaced';
      failed.replacedBy = last;
      steps[0].dependsOn = [...new Set([...steps[0].dependsOn, ...failed.dependsOn])];
      for (const step of task.steps) step.dependsOn = step.dependsOn.map((id) => id === failed.id ? last : id);
    }
    // The replacement keeps the step's count, so one stage is handed back at most MAX_REASSIGN times in all.
    const inherited = Math.max(...failedSteps.map((step) => step.reassigns || 0));
    const history = failedSteps.flatMap((step) => step.history || []);
    for (const step of steps) {
      step.reassigns = inherited;
      step.history = history;
      step.failedRoles = [...new Set(failedSteps.flatMap((failed) => failed.failedRoles || []))];
      step.replaces = failedSteps.map((failed) => failed.id);
    }
    task.steps.splice(task.steps.indexOf(failedSteps.at(-1)) + 1, 0, ...steps);
    return true;
  }

  // Only one escalation is pending at a time. beginTriage decides whether the task is allowed to start
  // another triage round at all.
  beginTriage(task, reason, { applied = false } = {}) {
    if (task.escalation?.active) return false;
    if (reason === 'step_failed') {
      task.reassignRounds = (task.reassignRounds || 0) + 1;   // a total for the metrics; the limit is per step
      task.escalation = { reason, applied: Boolean(applied), active: true, requestedAt: new Date(this.now()).toISOString() };
      task.stage = 'triaging';
      const first = task.lastStepFailure?.[0];
      this.save(task, 'triaging', `reassign_started:${first?.step || 'step'}:${first?.round || 1}/${MAX_REASSIGN}`);
      return true;
    }
    if ((task.triageRounds || 0) >= MAX_TRIAGE) {
      this.save(task, 'needs_review', 'triage_limit');
      return false;
    }
    task.escalation = { reason, applied: Boolean(applied), active: true, requestedAt: new Date(this.now()).toISOString() };
    task.stage = 'triaging';
    this.save(task, 'triaging', 'triage_started');
    return true;
  }

  async consumePendingTriage(task, repo, root, signal) {
    const pending = task.pendingTriage;
    if (!pending) return false;
    delete task.pendingTriage;
    if (task.escalation?.active) {
      // The pending request is the same escalation arriving twice; keep the running one.
      await this.runTriage(task, repo, root, signal);
      return true;
    }
    if (!this.beginTriage(task, pending.reason, { applied: pending.applied })) return false;
    await this.runTriage(task, repo, root, signal);
    return true;
  }

  // The lead's model: the one the person picked for this group, else the configured leadModel, else the newest
  // Opus, else the lead's default. It is always passed to the CLI, so the lead never falls back to whatever model
  // the CLI's own sign-in defaults to (which can be a small one).
  leadModelFor(task) {
    const profiles = this.config.adapters[LEAD_ROLE]?.profiles;
    const models = Object.keys(profiles?.models || {});
    if (task?.leadModel && models.includes(task.leadModel)) return task.leadModel;
    const configured = this.config.adapters[LEAD_ROLE]?.leadModel;
    if (configured && models.includes(configured)) return configured;
    const version = (id) => (/(\d+)[-.](\d+)/.exec(id) || [0, 0, 0]).slice(1).map(Number);
    const opus = models.filter((id) => /opus/i.test(id))
      .sort((a, b) => { const [x1, y1] = version(a), [x2, y2] = version(b); return x2 - x1 || y2 - y1; })[0];
    return opus || profiles?.defaultModel || undefined;
  }

  async runTriage(task, repo, root, signal) {
    const escalation = task.escalation;
    if (!escalation?.active) return;
    const lead = this.pickForTask(task, 'triage');
    if (!lead) {
      if (task.ownerCapBlocked) {
        this.waitForExecutor(task, 'triage');
        return;
      }
      const configured = (this.router.routes.triage || []).filter((role) => this.router.configured(role));
      if (!configured.length) {
        escalation.active = false;
        this.save(task, 'needs_review', 'triage_unavailable');
        return;
      }
      // Claude is the only triage role. Wait for it; never hand the decision to Codex.
      // Record why, so the app can say「额度已满，等恢复」instead of a vague「暂时不可用」.
      const waitingOn = configured.find((role) => this.router.unavailableReason(role, 'triage') !== 'busy') || configured[0];
      task.waitingFor = 'triage';
      task.waitingOn = waitingOn;
      task.waitingReason = this.router.unavailableReason(waitingOn, 'triage');
      task.notBefore = this.now() + 60_000;
      this.save(task, 'triaging', 'triage_unavailable:' + task.waitingReason);
      return;
    }
    // The brief was captured when the step failed; refresh the model choices in case the config changed since.
    if (escalation.reason === 'step_failed') {
      task.reassignOptions = plannerProfiles(this.availableRoles().filter((role) => role !== LEAD_ROLE), this.config.adapters);
    }
    let step = escalation.stepId && task.steps.find((item) => item.id === escalation.stepId);
    if (!step) {
      const reassign = escalation.reason === 'step_failed';
      const round = reassign ? task.reassignRounds + '-' + (task.lastStepFailure?.[0]?.step || 'step') : (task.triageRounds || 0) + 1;
      step = {
        id: (reassign ? 'reassign-' : 'triage-') + round, role: lead, capability: 'triage', write: false, usesBrief: true, model: this.leadModelFor(task),
        state: 'queued', attempts: 0, dependsOn: [], reason: escalation.reason,
        prompt: 'Diagnose this escalation and choose exactly one next action.',
        brief: buildTriageBrief(task, escalation.reason),
      };
      escalation.stepId = step.id;
      task.steps.push(step);
    }
    if (step.state !== 'completed') {
      try {
        await this.runStep(task, step, repo, root, signal);
      } catch (error) {
        if (error.message.startsWith('executor_waiting:')) {
          if (task.ownerCapBlocked) {
            this.waitForExecutor(task, 'triage');
            return;
          }
          task.waitingFor = 'triage';
          task.waitingOn = step.role;
          task.waitingReason = this.router.unavailableReason(step.role, 'triage');
          task.notBefore = this.now() + 60_000;
          this.save(task, 'triaging', 'triage_unavailable:' + task.waitingReason);
          return;
        }
        throw error;
      }
    }
    signal.throwIfAborted();
    const fresh = !escalation.decision;
    const decision = escalation.decision || parseTriageDecision(step.output);
    if (fresh) {
      escalation.decision = decision;
      if (escalation.reason !== 'step_failed') task.triageRounds = (task.triageRounds || 0) + 1;
    }
    this.save(task, 'triaging', 'triage_decision:' + decision.decision);
    await this.applyTriageDecision(task, decision, signal);
  }

  async applyTriageDecision(task, decision, signal) {
    const escalation = task.escalation || (task.escalation = {});
    if (decision.decision === 'retry') {
      escalation.active = false;
      task.stage = 'executing';
      if (escalation.reason !== 'test_failures') {
        const failed = task.steps.filter((step) => step.state === 'failed');
        const retryable = failed.length ? failed : task.steps.filter((step) => step.capability === 'review' && step.verdict);
        if (!retryable.length) {
          this.save(task, 'needs_review', 'triage_retry_required');
          return 'retry';
        }
        for (const step of retryable) {
          if (escalation.reason === 'step_failed') this.reassignStep(task, step, decision);
          step.state = 'queued';
          step.attempts = 0;
          delete step.error;
          delete step.verdict;
          delete step.output;
        }
        delete task.reviewConflictKey;
        this.save(task, 'queued', 'triage_retry');
        return 'retry';
      }
      if (!task.command) {
        this.save(task, 'completed', 'completed');
        return 'retry';
      }
      task.testFailures = 0;
      try {
        await this.test(task, signal);
        this.save(task, 'completed', 'completed');
      } catch (error) {
        if (error.message !== 'windows_test_failed') throw error;
        task.testFailures = 1;
        task.lastTestFailure = 'windows_test_failed';
        this.save(task, 'needs_review', 'triage_retry_failed');
      }
      return 'retry';
    }
    if (decision.decision === 'rework') {
      if (escalation.applied) {
        escalation.active = false;
        this.save(task, 'needs_review', 'rework_after_apply');
        return 'rework';
      }
      let steps;
      try {
        steps = this.buildTriageSteps(task, decision);
      } catch (error) {
        if (error.message.startsWith('executor_waiting:')) {
          if (task.ownerCapBlocked) {
            this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
            return 'rework';
          }
          task.waitingFor = error.message.slice('executor_waiting:'.length);
          task.waitingOn = task.waitingFor;
          task.waitingReason = this.router.unavailableReason(task.waitingFor, 'triage');
          task.notBefore = this.now() + 60_000;
          this.save(task, 'triaging', 'triage_unavailable:' + task.waitingReason);
          return 'rework';
        }
        throw error;
      }
      if (escalation.reason !== 'step_failed' || !this.replaceFailedSteps(task, steps)) task.steps.push(...steps);
      task.reworkRounds = (task.reworkRounds || 0) + 1;
      delete task.acceptance;
      escalation.active = false;
      task.stage = 'reworking';
      this.save(task, 'queued', 'triage_rework');
      return 'rework';
    }
    if (decision.decision === 'accept_with_risk') {
      escalation.active = false;
      task.acceptance = {
        verdict: 'accept_with_risk', round: (task.acceptance?.round || 0) + 1, stepId: escalation.stepId,
        summary: clip(decision.reason || decision.instructions, 600), findings: [], at: new Date(this.now()).toISOString(),
      };
      task.stage = 'accepted';
      this.save(task, 'needs_review', 'accepted_with_risk');
      return 'risk';
    }
    if (decision.decision === 'fail') {
      escalation.active = false;
      this.save(task, 'failed', 'rejected_by_lead');
      return 'fail';
    }
    escalation.active = false;
    this.save(task, 'needs_review', 'triage_unparseable');
    return 'unknown';
  }

  // Turns a lead decision into executable steps. Claude never appears here: each step goes through the
  // same capability router as a planned step, and a rework chains onto the active writer's worktree.
  buildTriageSteps(task, decision) {
    const raw = decision.steps.length ? decision.steps : [{
      capability: 'implement',
      prompt: decision.instructions || decision.reason || 'Fix the problems reported by the tests and reviews.',
    }];
    const used = new Set(task.steps.map((step) => step.id));
    const steps = [];
    let parent = [...task.steps].reverse().find((step) => step.write && step.paths?.length && !step.supersededBy);
    for (const item of raw.slice(0, 4)) {
      const capability = item.capability || 'implement';
      const role = this.namedExecutor(task, capability, item.executor) || this.pickForTask(task, capability, item.exclude || []) ||
        this.pickForTask(task, capability);
      if (!role) {
        const configured = (this.router.routes[capability] || []).filter((candidate) => this.router.configured(candidate));
        throw new Error(configured.length ? 'executor_waiting:' + capability : 'no_executor:' + capability);
      }
      let next = 1;
      while (used.has('fix-' + next)) next += 1;
      const id = 'fix-' + next;
      used.add(id);
      const dependsOn = steps.length ? [steps.at(-1).id] : [];
      if (capability === 'review' && parent && !dependsOn.includes(parent.id)) dependsOn.push(parent.id);
      const step = {
        id, role, capability, write: CAPABILITIES[capability].write && this.router.canWrite(role),
        state: 'queued', attempts: 0, dependsOn,
        prompt: item.prompt,
      };
      this.chooseModel(step, item);
      if (capability === 'implement' && parent) step.reworkOf = parent.id;
      if (step.write) parent = step;
      steps.push(step);
    }
    return steps;
  }

  async apply(task, force = false) {
    if (!task || task.state !== 'needs_review' || task.pendingRequest || this.running.has(task.id) ||
      !['patches_ready', 'accepted_with_risk'].includes(task.detail)) {
      throw new Error('patch_not_applicable');
    }
    // A patch is only applicable once the lead accepted it. Turning acceptance off in configuration
    // removes the gate, and an administrator can force a recovery apply explicitly.
    if (!force && this.acceptanceRequired(task) && !['accept', 'pass', 'accept_with_risk'].includes(task.acceptance?.verdict) &&
        task.detail !== 'accepted') {
      throw new Error('acceptance_required');
    }
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const patches = await Promise.all(task.steps.filter((step) => step.write && step.paths?.length && !step.supersededBy)
        .map((step) => readFile(path.join(this.config.stateDir, 'worktrees', task.id, step.id + '.patch'))));
      task.pendingRequest = messageId();
      task.pendingKind = 'patch';
      this.save(task, 'applying', 'patch_started');
      task.applied = await this.files.patch(this.bridgeRoute(task.workspace), task.id, task.workspace, task.base,
        Buffer.concat(patches), task.pendingRequest, controller.signal);
      delete task.pendingRequest;
      delete task.pendingKind;
      if (task.command && !controller.signal.aborted) {
        const passed = await this.runTests(task, controller.signal);
        if (!passed) {
          // The patches are already applied. Diagnose the failure before changing anything else; a
          // triage rework is deliberately not auto-applied on top of applied changes.
          this.save(task, 'queued', 'triage_pending');
          return this.status(task.id);
        }
      }
      if (!controller.signal.aborted) this.save(task, 'completed', 'completed');
    } catch (error) {
      if (error.remoteConfirmed) {
        delete task.pendingRequest;
        delete task.pendingKind;
      }
      if (task.state !== 'cancelled') this.save(task, 'needs_review', error.message);
      throw error;
    } finally {
      this.running.delete(task.id);
      this.pump();
    }
    return this.status(task.id);
  }

  async reconcile(task) {
    if (!task?.pendingRequest || this.running.has(task.id)) throw new Error('no_pending_operation');
    const outcome = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'task.status', {
      operation: 'operation_status', request_id: task.pendingRequest,
    });
    if (outcome.state !== 'finished') return outcome;
    const isTest = task.pendingKind === 'test';
    delete task.pendingRequest;
    delete task.pendingKind;
    if (outcome.kind === 'error') {
      const reason = outcome.outcome.error;
      this.save(task, reason === 'command_cancelled' ? 'cancelled' : 'failed', reason);
    }
    else if (isTest && outcome.outcome.value.code !== 0) {
      task.testResult = outcome.outcome.value;
      this.save(task, 'failed', 'windows_test_failed');
    } else {
      if (isTest) task.testResult = outcome.outcome.value;
      else task.applied = outcome.outcome.value;
      this.save(task, 'completed', isTest || !task.command ? 'confirmed_complete' : 'patch_confirmed_test_not_run');
    }
    return this.status(task.id);
  }

  control(frame, route) {
    const { task_id: id, body } = frame;
    if (!taskIdPattern.test(id)) throw new Error('invalid_task_id');
    const named = /^(?:ssh|relay):([a-z0-9]+)$/.exec(route)?.[1];
    const bridge = route === 'admin' ? frame.bridge : named;
    if (frame.kind === 'task.status' && route === 'admin' && ['report', 'benchmark'].includes(body.operation)) {
      if (body.format !== undefined && !['json', 'table', 'csv'].includes(body.format)) throw new Error('invalid_report_format');
      let value;
      if (body.operation === 'report') {
        value = summarize([...this.tasks.values()], body);
        value.owners = ownerUsageReport([...this.tasks.values()], this.ownerCaps, new Date(this.now()));
      } else {
        value = benchmark([...this.tasks.values()], { benchmarkId: body.benchmarkId });
      }
      if (body.format === 'table') return { format: 'table', output: toTable(value), summary: value };
      if (body.format === 'csv') return { format: 'csv', output: toCsv(value), summary: value };
      return value;
    }
    const startPlan = frame.kind === 'task.status' && body.operation === 'start_plan';
    const broadcast = frame.kind === 'task.status' && body.operation === 'broadcast';
    if (frame.kind === 'task.request' || startPlan || broadcast) {
      if (named && this.config.workspaces[body.workspace]?.sshBridge !== named) throw new Error('workspace_not_authorized');
      if (named && body.project !== undefined && !this.isProjectMember(body.project, named)) throw new Error('project_access_denied');
      if (broadcast) return this.broadcast(id, body);
      const existing = this.tasks.get(id);
      const groupPlan = startPlan || Boolean(named && (!existing || existing.groupPlan));
      return this.status(this.submit(id, body, groupPlan).id);
    }
    if (frame.kind !== 'task.status') throw new Error('unsupported_operation');
    if (body.operation === 'list' && route === 'admin') return this.list();
    if (body.operation === 'doctor' && route === 'admin') return this.doctor();
    if (body.operation === 'model_catalog' && route === 'admin') return this.refreshModelCatalog();
    if (body.operation === 'cleanup' && route === 'admin') return this.cleanupNow();
    if (body.operation === 'maintenance' && route === 'admin') return this.setMaintenance(body.action || 'status', body.reason, body.source);
    if (body.operation === 'diagnostics' && (route === 'admin' || named)) return this.diagnosticStatus({ named, admin: route === 'admin' });
    if (body.operation === 'onboarding_check' && (route === 'admin' || named)) {
      return this.diagnosticStatus({ named, admin: route === 'admin' }).then(({ clis }) => clis);
    }
    if (body.operation === 'resource_status' && (route === 'admin' || named)) return hostResources();
    if (body.operation === 'quota_status') {
      if (route === 'admin') {
        return this.refreshQuota().then(() => quotaStatus(this.config.adapters, { liveOnly: body.liveOnly === true }))
          .then((list) => this.decorateQuota(list));
      }
      if (named && Array.isArray(this.config.quotaBridges) && this.config.quotaBridges.includes(named)) {
        // Snapshots are included by default: Claude's is rewritten by every turn's rate_limit_event, so it is
        // as current as a live reading, and the desktop needs its windows to draw the quota rings.
        return this.refreshQuota().then(() => quotaStatus(this.config.adapters, { liveOnly: body.liveOnly === true }))
          .then((list) => this.decorateQuota(list));
      }
      throw new Error('quota_access_denied');
    }
    if (body.operation === 'route_status' && (route === 'admin' || named)) {
      const channel = bridge ? this.namedBridgeRoute(bridge) : this.route;
      const port = this.files.endpoint;
      const relay = port[bridge ? 'relay:' + bridge : 'relay'];
      return { route: channel, ssh: Boolean(port[bridge ? 'ssh:' + bridge : 'ssh']?.ready), relay: Boolean(relay?.ready && relay.online),
        providers: this.availableRoles(), writeProviders: (this.config.writeProviders || []).filter((role) => this.router.configured(role)),
        modelProfiles: Object.fromEntries(this.router.roles().map(role => [role, this.config.adapters[role].profiles])),
        directAttachments: true,
        // How work is handed out right now, so the desktop can show who takes what and why others are skipped.
        team: { ...this.router.status(), configured: this.router.roles(),
          authRequired: this.router.roles().filter((role) => this.config.adapters[role]?.authRequired) },
        projects: named ? this.projectsFor(named) : Object.keys(this.config.projects || {}) };
    }
    if (body.operation === 'select_route' && (route === 'admin' || named)) return this.setRoute(body.route, bridge);
    if (body.operation === 'compact_project' && (route === 'admin' || named)) return this.compact(body.project, named, body.workspace);
    if (body.operation === 'project_tasks' && (route === 'admin' || named)) {
      const projects = named ? this.projectsFor(named) : null;
      if (named && body.project !== undefined && !projects.includes(body.project)) throw new Error('project_access_denied');
      const selected = body.project !== undefined ? [body.project] : projects;
      const workspace = body.workspace;
      if (workspace !== undefined && !Object.hasOwn(this.config.workspaces, workspace)) throw new Error('workspace_not_authorized');
      if (named && workspace !== undefined && this.ownerOf(workspace) !== named) throw new Error('workspace_not_authorized');
      return [...this.tasks.values()]
        .filter((candidate) => workspace !== undefined && candidate.project === undefined
          ? candidate.workspace === workspace
          : selected ? selected.includes(candidate.project) : true)
        .slice(-30).reverse().map((candidate) => named && candidate.owner !== named ? publicTask(candidate)
          : { ...publicTask(candidate), redacted: false, workspace: candidate.workspace, prompt: clip(candidate.prompt, 240), live: this.liveState(candidate) });
    }
    const task = this.tasks.get(id);
    const sameProject = named && this.isProjectMember(task?.project, named);
    if (named && this.config.workspaces[task?.workspace]?.sshBridge !== named && !sameProject) throw new Error('unknown_task');
    const owner = route === 'admin' || (named && task?.owner === named);
    if (['task_diff', 'task_log', 'task_artifacts', 'task_activity'].includes(body.operation)) {
      if (!task || !owner) throw new Error('task_access_denied');
      if (body.operation === 'task_activity') return stepActivity(this.config.stateDir, task, body.stepId);
      return taskOutput(this.config.stateDir, task, body);
    }
    if (body.operation === 'status') return owner || route === 'admin' ? this.status(id, body.after) : publicTask(task);
    if (body.operation === 'plan_reply' || body.operation === 'plan_approve') {
      if (!owner) throw new Error('task_access_denied');
      return this.updatePlan(task, body);
    }
    if (body.operation === 'approve_addition') {
      if (!owner) throw new Error('task_access_denied');
      return this.approveAddition(task);
    }
    if (body.operation === 'revise_plan') {
      if (!owner) throw new Error('task_access_denied');
      return this.revisePlan(task, body.reply);
    }
    if (body.operation === 'steer_step') {
      if (!owner) throw new Error('task_access_denied');
      if (typeof body.stepId !== 'string' || !/^[\w-]{1,64}$/.test(body.stepId)) throw new Error('invalid_step');
      return this.steerStep(task, body.stepId, body.reply);
    }
    if (body.operation === 'stop_step') {
      if (!owner) throw new Error('task_access_denied');
      if (typeof body.stepId !== 'string' || !/^[\w-]{1,64}$/.test(body.stepId)) throw new Error('invalid_step');
      return this.stopStep(task, body.stepId);
    }
    if (body.operation === 'reconcile') {
      if (!owner) throw new Error('task_access_denied');
      return this.reconcile(task);
    }
    if (body.operation === 'cancel') {
      if (!owner) throw new Error('task_access_denied');
      return this.cancel(task);
    }
    if (body.operation === 'apply') {
      if (!owner) throw new Error('task_access_denied');
      return this.apply(task, route === 'admin' && body.force === true);
    }
    throw new Error('unsupported_operation');
  }
}

module.exports = { Scheduler, parsePlan, publicTask };
