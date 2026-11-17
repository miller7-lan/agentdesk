const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { messageId } = require('./transport');
const { runAdapter, addUsage } = require('./adapters');
const { Router, CAPABILITIES, ROLES, LEAD_ROLE, LEAD_CAPABILITIES, usedPercent } = require('./routing');
const { git, worktree, patchFor } = require('./git');
const { modelId, plannerProfiles } = require('./model-profiles');
const { quotaStatus } = require('./quotas');
const { buildAcceptanceBrief, buildTriageBrief, buildLeadBrief } = require('./summary');
const {
  REVIEW_INSTRUCTION, ACCEPTANCE_INSTRUCTION, parseReviewVerdict, reviewConflicts, mergeFindings,
} = require('./review');

const roles = ['codex', 'claude', 'grok', 'gemini'];

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

// Fingerprints the uncommitted state of a worktree: which files are dirty (including untracked ones)
// and the exact tracked diff. A read-only step must leave this unchanged.
async function worktreeState(folder, signal) {
  const status = await git(folder, ['status', '--porcelain=v1', '-z'], signal);
  const diff = await git(folder, ['diff', '--binary', 'HEAD'], signal);
  return createHash('sha256').update(status).update('\0').update(diff).digest('hex');
}

function parseJson(output) {
  try {
    return JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
  } catch {
    throw new Error('invalid_plan');
  }
}

function parsePlan(output, availableRoles = roles, router, pick) {
  return validateSteps(parseJson(output), availableRoles, router, pick);
}

// A step names either a role (a specific CLI) or a capability. A capability is resolved by the router to the
// first available candidate; a role the planner suggests is kept when it is a candidate and available.
// Claude is reserved: a plan that tries to hand Claude implementation, review or scouting is rejected.
function validateSteps(plan, availableRoles, router, pick) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 12) throw new Error('invalid_plan');
  const ids = new Set(['planner', 'group-planner']);
  const choose = pick || ((capability, exclude) => router.pick(capability, exclude));
  return plan.map((step) => {
    if (!step || typeof step !== 'object') throw new Error('invalid_plan');
    const { capability } = step;
    let role = step.role;
    if (capability !== undefined) {
      if (!router || !Object.hasOwn(CAPABILITIES, capability)) throw new Error('invalid_plan');
      if (role === LEAD_ROLE && !LEAD_CAPABILITIES.has(capability)) throw new Error('invalid_plan:lead_capability');
      if (!(router.routes[capability].includes(role) && availableRoles.includes(role) && router.quotaAllows(role, capability))) role = choose(capability);
      if (!role) {
        // Configured candidates exist but are blocked by login, quota or an owner cap: the task waits.
        const configured = (router.routes[capability] || []).filter((candidate) => router.configured(candidate));
        throw new Error(configured.length ? 'executor_waiting:' + capability : 'no_executor:' + capability);
      }
    } else if (role === LEAD_ROLE) {
      throw new Error('invalid_plan:lead_capability');
    }
    if (!/^[a-z0-9_-]{1,32}$/.test(step.id) || ids.has(step.id) || !availableRoles.includes(role) ||
      typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 8000 ||
      !Array.isArray(step.dependsOn) || step.dependsOn.some((id) => id === 'planner' || id === 'group-planner' || !ids.has(id))) throw new Error('invalid_plan');
    ids.add(step.id);
    return {
      id: step.id, role, ...(capability !== undefined && { capability }), prompt: step.prompt, dependsOn: [...new Set(step.dependsOn)],
      write: capability !== undefined ? CAPABILITIES[capability].write && router.canWrite(role) : role === 'codex',
      state: 'queued', attempts: 0,
    };
  });
}

class Scheduler {
  constructor({ config, store, files, adapter = runAdapter }) {
    this.config = config;
    this.store = store;
    this.files = files;
    this.adapter = adapter;
    this.router = new Router(config);
    this.running = new Map();
    // Several people share one VPS: tasks run in parallel up to maxConcurrentTasks, but each CLI runs one
    // process at a time across all tasks, because every task uses the same subscription login for that CLI.
    this.cliBusy = new Map();     // role -> number of processes running
    this.cliWaiters = new Map();  // role -> queue of { resolve } waiting for that CLI
    this.tasks = new Map(store.all('tasks').map((task) => [task.id, task]));
    this.route = store.get('settings', 'route')?.value || 'ssh';
    for (const task of this.tasks.values()) {
      if (task.state === 'applying' || task.state === 'testing') {
        this.save(task, 'needs_review', 'interrupted_windows_operation');
      } else if (task.state === 'planning' || task.state === 'running') {
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
        this.router.block(step.role, reason);
        step.tried = [...new Set([...(step.tried || []), step.role])];
        const next = step.capability && this.pickForTask(task, step.capability, step.tried);
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
    if (this.quotaSnapshot && Date.now() - this.quotaAt < maxAgeMs) return this.quotaSnapshot;
    this.quotaReading ||= quotaStatus(this.config.adapters).then((status) => {
      this.quotaSnapshot = status;
      this.quotaAt = Date.now();
      this.router.setQuota(status);
      return status;
    }).catch(() => this.quotaSnapshot || []).finally(() => { this.quotaReading = null; });
    return this.quotaReading;
  }

  // Adds what routing makes of each CLI's quota: the percent the router uses (live, or the cached snapshot when
  // the live reading has none), its limits, and whether it is working normally, reserved for its main jobs, or stopped.
  decorateQuota(list) {
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
    this.store.saveTask(task, { state: task.state, detail: 'quota_charged', quota: charged });
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
    return Promise.all(this.router.roles().map(version)).then((clis) => ({ clis, ...this.router.status() }));
  }

  list() {
    return [...this.tasks.values()].slice(-50).reverse().map(({ id, owner, workspace, prompt, state, detail, steps, quota, usage }) => ({
      id, owner: owner || 'local', workspace, state, detail, prompt: prompt.slice(0, 80), roles: [...new Set(steps.map((step) => step.role))], quota, usage,
    }));
  }

  save(task, state, detail) {
    task.state = state;
    task.detail = detail;
    this.store.saveTask(task, { state, detail });
  }

  submit(id, body, groupPlan = false) {
    const existing = this.tasks.get(id);
    if (existing) {
      if (Boolean(existing.groupPlan) !== groupPlan || existing.prompt !== body.prompt || existing.workspace !== body.workspace || existing.command !== body.command || existing.provider !== body.provider || existing.model !== body.model) {
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
    if (body.provider === LEAD_ROLE) throw new Error('claude_reserved');
    if ((body.provider !== undefined && !ROLES.includes(body.provider)) ||
        (body.model !== undefined && (!body.provider || typeof body.model !== 'string' ||
          !modelId.test(body.model)))) throw new Error('invalid_model_selection');
    if (this.tasks.size >= 10000) throw new Error('task_capacity');
    const task = { id, workspace: body.workspace, prompt: body.prompt, command: body.command, provider: body.provider, model: body.model, steps: [],
      owner: this.ownerOf(body.workspace) };
    if (groupPlan) task.groupPlan = { rounds: [] };
    this.tasks.set(id, task);
    this.save(task, 'queued', 'submitted');
    this.pump();
    return task;
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
            steps: steps.map(({ role, model, prompt, id, dependsOn, write }) => ({ role, model, prompt, id, dependsOn, write })),
          }),
        })),
        ...(groupPlan.approved && { approved: groupPlan.approved }),
      } }),
      steps: steps.map(({ prompt, output, ...step }) => ({ ...step, output: output?.slice(0, 1600), paths: step.paths?.slice(0, 20) })),
      events: this.store.events(id, after),
    };
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
      this.save(task, 'queued', 'plan_reply_received');
    } else {
      if (plan.approved === revision) return this.status(task.id);
      if (round.revision !== revision || task.state !== 'awaiting_approval' || !round.steps?.length) throw new Error('plan_changed');
      plan.approved = revision;
      task.steps = round.steps.map((step) => ({ ...step }));
      this.save(task, 'queued', 'plan_approved');
    }
    this.pump();
    return this.status(task.id);
  }

  // Whose task this is: the bridge (one per person's machine) its workspace belongs to.
  ownerOf(workspace) {
    return this.config.workspaces?.[workspace]?.sshBridge || 'local';
  }

  // The single place where a step's CLI is chosen. Owner caps are applied here in T1.9.
  pickForTask(task, capability, exclude = []) {
    return this.router.pick(capability, exclude);
  }

  // Codex (or Claude for plan/triage/accept) is configured but temporarily unusable: keep the task
  // queued and retry after a short delay instead of failing it or lending the work to another CLI.
  waitForExecutor(task, capability) {
    task.waitingFor = capability;
    task.notBefore = Date.now() + 60_000;
    this.save(task, 'queued', 'executor_waiting:' + capability);
  }

  // Called by the service timer: refresh cached quota (a Codex read starts an App Server) and retry
  // tasks whose executor may have become available.
  tick() {
    this.refreshQuota().catch(() => {}).finally(() => this.pump());
  }

  slots() {
    const limit = this.config.maxConcurrentTasks ?? 2;
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 8 ? limit : 2;
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
    let released = false;
    return () => {
      if (released) return;
      released = true;
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
    const runningBy = new Map();
    for (const id of this.running.keys()) {
      const owner = this.tasks.get(id)?.owner || 'local';
      runningBy.set(owner, (runningBy.get(owner) || 0) + 1);
    }
    const ready = [...this.tasks.values()].filter((candidate) => {
      if (candidate.state !== 'queued' || this.running.has(candidate.id)) return false;
      if (candidate.notBefore && candidate.notBefore > Date.now()) return false;
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
    return best?.task;
  }

  start(task) {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    this.run(task, controller.signal).catch((error) => {
      if (error.message?.startsWith('executor_waiting:')) {
        this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
        return;
      }
      if (!controller.signal.aborted || task.state !== 'cancelled') {
        const unknown = task.pendingRequest && !error.remoteConfirmed;
        if (!unknown) {
          delete task.pendingRequest;
          delete task.pendingKind;
        }
        this.save(task, unknown ? 'needs_review' : 'failed', error.message);
      }
    }).finally(() => {
      this.running.delete(task.id);
      this.pump();
      this.chargeQuota(task).catch(() => {});   // after releasing the task, so review and apply are not held up
    });
  }

  async invoke(task, step, folder, signal, prompt = step.prompt) {
    const config = this.config.adapters[step.role];
    if (!config) throw new Error(step.role + '_not_configured');
    const mcp = step.id === 'group-planner' || !['codex', 'claude', 'grok'].includes(step.role) || config.template ? undefined : this.config.mcp;
    const release = await this.acquireCli(task, step, signal);
    const capability = mcp && randomBytes(32).toString('base64url');
    if (mcp) mcp.capabilities.set(capability, { taskId: task.id, workspace: task.workspace });
    try {
      return await this.adapter({
        name: step.role, config, cwd: folder, prompt, readonly: !step.write,
        timeout: this.config.cliTimeoutMs || 900000, signal,
        log: path.join(this.config.stateDir, 'logs', task.id, step.id + '.log'),
        session: step.session, model: step.model,
        mcp: mcp && { socket: mcp.socket, capability },
        onSession: (id) => {
          if (step.session === id) return;
          step.session = id;
          this.save(task, task.state, step.id + ':session');
        },
      });
    } finally {
      mcp?.capabilities.delete(capability);
      release();
    }
  }

  async run(task, signal) {
    const status = await this.refreshQuota();
    task.quotaStart ||= Scheduler.quotaWindows(status);
    delete task.notBefore;
    delete task.waitingFor;
    const repo = this.config.workspaces[task.workspace].repository;
    const root = path.join(this.config.stateDir, 'worktrees', task.id);
    await mkdir(path.join(this.config.stateDir, 'logs', task.id), { recursive: true, mode: 0o700 });
    if (task.groupPlan && !task.groupPlan.approved) {
      await this.planGroup(task, repo, root, signal);
      return;
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
    if (!task.steps.length && task.provider) {
      task.steps = [{ id: task.provider, role: task.provider, model: task.model, prompt: task.prompt,
        dependsOn: [], write: task.provider !== 'gemini', state: 'queued', attempts: 0 }];
    }
    if (!task.steps.length) {
      this.save(task, 'planning', 'planning_started');
      if (!task.planRaw) {
        const lead = this.pickForTask(task, 'plan');
        if (!lead) {
          this.waitForExecutor(task, 'plan');
          return;
        }
        const planner = { id: 'planner', role: lead, capability: 'plan', write: false, prompt: PLANNER_PROMPT + task.prompt };
        const folder = path.join(root, 'planner');
        await this.ensureWorktree(repo, folder, task, planner, signal);
        const { output } = await this.execute(task, planner, folder, signal, planner.prompt);
        task.planRaw = output;
      }
      try {
        task.steps = parsePlan(task.planRaw, this.availableRoles(), this.router,
          (capability, exclude) => this.pickForTask(task, capability, exclude));
      } catch (error) {
        if (!error.message.startsWith('executor_waiting:')) throw error;
        // Keep the plan text so the next attempt does not pay for planning again.
        this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
        return;
      }
      delete task.planRaw;
    }
    this.save(task, 'running', 'plan_ready');
    while (task.steps.some((step) => step.state === 'queued')) {
      signal.throwIfAborted();
      const ready = task.steps.filter((step) => step.state === 'queued' &&
        step.dependsOn.every((id) => task.steps.find((dep) => dep.id === id).state === 'completed'));
      const wave = ready.filter((step, i) => ready.findIndex((other) => other.role === step.role) === i);
      if (!wave.length) throw new Error('dependency_failed');
      const results = await Promise.allSettled(wave.map((step) => this.runStep(task, step, repo, root, signal)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    signal.throwIfAborted();
    const writers = task.steps.filter((step) => step.write && step.paths?.length);
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
    if (task.command) await this.test(task, signal);
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
        .map(([name, list]) => [name, list.filter((role) => this.router.available(role))])),
      models: plannerProfiles(this.availableRoles(), this.config.adapters, task.provider, task.model),
      rounds: plan.rounds.slice(-8).map(({ questions, summary, reply }) => ({ questions, summary, reply })),
    };
    const prompt = [
      'You are 组长, the group lead. Stay in read-only planning mode. Inspect the checked-out code when useful.',
      'Ask the requester every material question you cannot resolve from the repository or the discussion. Ask specific questions and offer options when helpful. Do not re-ask answered questions or ask about details you can determine.',
      'If clarification is needed return only JSON {"questions":["question 1","question 2"]}, at most 6 questions, each at most 400 characters. You can ask more in a later round.',
      'When clear return only JSON {"summary":"outline the scope and validation in at most 1800 characters","steps":[{"id":"step","capability":"implement","prompt":"concrete work and checks","dependsOn":[]}]}. User-visible text should match the requester’s language.',
      CAPABILITY_GUIDE,
      'Use at most 12 steps and at most 1000 characters per step prompt. If a preferred executor is selected, return exactly one step and set its role to that executor.',
      'Use each integration’s strengths and model-specific profile to choose the least costly capable model. These are subscriptions: what runs out is quota, shown in quotaUsedPercent (the fullest of the 5-hour and weekly windows). Claude and Codex quota is the scarcest; give reading, research and review to CLIs with quota left. capabilities lists who can take each kind of step right now. Favor fewer calls when they suffice.',
      'When a step should use a particular configured model, include its exact ID in the optional step.model field. Honor an explicitly requested executor and model. Use the configured default when model is omitted. Keep costs internal and do not put prices or cost breakdowns in user-facing text.',
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
      const step = { id: 'group-planner', role: lead, capability: 'plan', write: false, model: this.config.adapters[lead]?.profiles?.defaultModel };
      const folder = path.join(root, step.id);
      await this.ensureWorktree(repo, folder, { ...task, base: plan.base }, step, signal);
      const { output } = await this.execute(task, step, folder, signal, prompt);
      signal.throwIfAborted();
      result = parseJson(output);
      revision = (plan.rounds.at(-1)?.revision || 0) + 1;
    }
    if (Array.isArray(result?.questions) && result.questions.length >= 1 && result.questions.length <= 6 &&
      result.questions.every((question) => typeof question === 'string' && question.trim() && question.length <= 400)) {
      delete plan.pending;
      plan.rounds.push({ revision, questions: result.questions });
      this.save(task, 'awaiting_details', 'plan_questions');
      return;
    }
    if (typeof result?.summary !== 'string' || !result.summary.trim() || result.summary.length > 1800) throw new Error('invalid_plan');
    let steps;
    try {
      steps = validateSteps(result.steps, this.availableRoles(), this.router,
        (capability, exclude) => this.pickForTask(task, capability, exclude));
    } catch (error) {
      if (!error.message.startsWith('executor_waiting:')) throw error;
      plan.pending = { result, revision };
      this.waitForExecutor(task, error.message.slice('executor_waiting:'.length));
      return;
    }
    delete plan.pending;
    if (steps.some(({ prompt }) => prompt.length > 1000) || (task.provider && steps.length !== 1)) throw new Error('invalid_plan');
    if (task.provider) {
      steps[0].role = task.provider;
      steps[0].write = task.provider !== 'gemini';
    }
    for (const [index, step] of steps.entries()) {
      const selected = task.model || result.steps[index].model;
      const { defaultModel, models } = context.models[step.role];
      if (selected !== undefined && (typeof selected !== 'string' || !Object.hasOwn(models, selected))) throw new Error('invalid_plan');
      step.model = selected || defaultModel;
    }
    plan.rounds.push({ revision, summary: result.summary, steps });
    this.save(task, 'awaiting_approval', 'plan_proposed');
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
    }
    const folder = path.join(root, sharedWriter?.id || step.id);
    await this.ensureWorktree(repo, folder, task, sharedWriter || step, signal);
    const dependencies = task.steps.filter((dep) => step.dependsOn.includes(dep.id))
      .map((dep) => ({ id: dep.id, output: dep.output?.slice(0, 4000), paths: dep.paths?.slice(0, 50),
        patch: dep.paths?.length ? path.join(root, dep.id + '.patch') : undefined,
      }));
    const before = sharedWriter ? await worktreeState(folder, signal) : undefined;
    for (;;) {
      step.state = 'running';
      step.attempts += 1;
      this.save(task, 'running', step.id + ':started');
      try {
        let prompt = dependencies.length ? step.prompt + '\nUpstream results: ' + JSON.stringify(dependencies) : step.prompt;
        if (sharedWriter) {
          prompt += `\nReview the uncommitted changes in this working tree (writer step: ${sharedWriter.id}). Do not change files.`;
        }
        if (step.usesBrief) {
          const stage = step.capability === 'accept' ? 'acceptance'
            : step.capability === 'triage' ? 'triage' : 'lead';
          const brief = step.brief || (stage === 'acceptance' ? buildAcceptanceBrief(task)
            : stage === 'triage' ? buildTriageBrief(task, step.reason || task.escalation?.reason)
              : buildLeadBrief(task, stage));
          task.briefs ||= {};
          task.briefs[stage] = brief;
          // No raw upstream transcripts, logs or patches are sent to the lead.
          prompt = step.prompt + '\n\nBrief (summaries only, not raw logs): ' + JSON.stringify(brief);
        }
        if (step.capability === 'review') prompt += '\n\n' + REVIEW_INSTRUCTION;
        else if (step.capability === 'accept') prompt += '\n\n' + ACCEPTANCE_INSTRUCTION;
        const { output } = await this.execute(task, step, folder, signal, prompt);
        signal.throwIfAborted();
        step.output = output;
        const verdict = ['review', 'accept'].includes(step.capability) ? parseReviewVerdict(output) : null;
        if (verdict) step.verdict = verdict;
        if (sharedWriter) {
          if (await worktreeState(folder, signal) !== before) throw new Error('readonly_step_changed_files');
          // The writer's patch belongs to the writer step; a review must not claim it.
          step.paths = [];
          step.reviewedStep = sharedWriter.id;
        } else {
          const { paths, patch } = await patchFor(folder, task.base, signal);
          if (!step.write && paths.length) throw new Error('readonly_step_changed_files');
          if (paths.length) await writeFile(path.join(root, step.id + '.patch'), patch, { mode: 0o600 });
          step.paths = paths;
        }
        step.state = 'completed';
        this.save(task, 'running', step.id + ':completed');
        if (verdict) {
          task.reviews ||= {};
          task.reviews[step.id] = { ...verdict, role: step.role, capability: step.capability };
          this.save(task, 'running', 'review_verdict:' + step.id + ':' + verdict.verdict);
          this.trackReviewConflict(task);
        }
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error.message.startsWith('executor_waiting:')) {
          step.state = 'queued';
          throw error;
        }
        if (step.attempts < 2 && step.session && error.message.startsWith('cli_exit_')) continue;
        step.state = 'failed';
        step.error = error.message;
        this.save(task, 'running', step.id + ':failed');
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

  async apply(task) {
    if (!task || task.state !== 'needs_review' || task.pendingRequest || this.running.has(task.id) ||
      task.detail !== 'patches_ready') {
      throw new Error('patch_not_applicable');
    }
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const patches = await Promise.all(task.steps.filter((step) => step.write && step.paths?.length)
        .map((step) => readFile(path.join(this.config.stateDir, 'worktrees', task.id, step.id + '.patch'))));
      task.pendingRequest = messageId();
      task.pendingKind = 'patch';
      this.save(task, 'applying', 'patch_started');
      task.applied = await this.files.patch(this.bridgeRoute(task.workspace), task.id, task.workspace, task.base,
        Buffer.concat(patches), task.pendingRequest, controller.signal);
      delete task.pendingRequest;
      delete task.pendingKind;
      if (task.command && !controller.signal.aborted) await this.test(task, controller.signal);
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('invalid_task_id');
    const named = /^(?:ssh|relay):([a-z0-9]+)$/.exec(route)?.[1];
    const bridge = route === 'admin' ? frame.bridge : named;
    const startPlan = frame.kind === 'task.status' && body.operation === 'start_plan';
    if (frame.kind === 'task.request' || startPlan) {
      if (named && this.config.workspaces[body.workspace]?.sshBridge !== named) throw new Error('workspace_not_authorized');
      const existing = this.tasks.get(id);
      const groupPlan = startPlan || Boolean(named && (!existing || existing.groupPlan));
      return this.status(this.submit(id, body, groupPlan).id);
    }
    if (frame.kind !== 'task.status') throw new Error('unsupported_operation');
    if (body.operation === 'list' && route === 'admin') return this.list();
    if (body.operation === 'doctor' && route === 'admin') return this.doctor();
    if (body.operation === 'quota_status') {
      if (route === 'admin') {
        return this.refreshQuota().then(() => quotaStatus(this.config.adapters, { liveOnly: body.liveOnly === true }))
          .then((list) => this.decorateQuota(list));
      }
      if (named && Array.isArray(this.config.quotaBridges) && this.config.quotaBridges.includes(named)) {
        return this.refreshQuota().then(() => quotaStatus(this.config.adapters, { liveOnly: true })).then((list) => this.decorateQuota(list));
      }
      throw new Error('quota_access_denied');
    }
    if (body.operation === 'route_status' && (route === 'admin' || named)) {
      const channel = bridge ? this.namedBridgeRoute(bridge) : this.route;
      const port = this.files.endpoint;
      const relay = port[bridge ? 'relay:' + bridge : 'relay'];
      return { route: channel, ssh: Boolean(port[bridge ? 'ssh:' + bridge : 'ssh']?.ready), relay: Boolean(relay?.ready && relay.online),
        providers: this.availableRoles() };
    }
    if (body.operation === 'select_route' && (route === 'admin' || named)) return this.setRoute(body.route, bridge);
    const task = this.tasks.get(id);
    if (named && this.config.workspaces[task?.workspace]?.sshBridge !== named) throw new Error('unknown_task');
    if (body.operation === 'status') return this.status(id, body.after);
    if (['plan_reply', 'plan_approve'].includes(body.operation) && (route === 'admin' || named)) return this.updatePlan(task, body);
    if (body.operation === 'reconcile' && (route === 'admin' || named)) return this.reconcile(task);
    if (body.operation === 'cancel' && task) return this.cancel(task);
    if (body.operation === 'apply' && (route === 'admin' || named)) return this.apply(task);
    throw new Error('unsupported_operation');
  }
}

module.exports = { Scheduler, parsePlan };
