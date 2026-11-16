const { mkdir, writeFile, readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { messageId } = require('./transport');
const { runAdapter } = require('./adapters');
const { git, worktree, patchFor } = require('./git');

const roles = ['codex', 'claude', 'grok'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'needs_review']);

function parsePlan(output) {
  const plan = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 12) throw new Error('invalid_plan');
  const ids = new Set(['planner']);
  return plan.map((step) => {
    if (!step || !/^[a-z0-9_-]{1,32}$/.test(step.id) || ids.has(step.id) || !roles.includes(step.role) ||
      typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 8000 ||
      !Array.isArray(step.dependsOn) || step.dependsOn.some((id) => id === 'planner' || !ids.has(id))) throw new Error('invalid_plan');
    ids.add(step.id);
    return {
      id: step.id, role: step.role, prompt: step.prompt, dependsOn: [...new Set(step.dependsOn)],
      write: step.role === 'codex', state: 'queued', attempts: 0,
    };
  });
}

class Scheduler {
  constructor({ config, store, files, adapter = runAdapter }) {
    this.config = config;
    this.store = store;
    this.files = files;
    this.adapter = adapter;
    this.running = new Map();
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

  save(task, state, detail) {
    task.state = state;
    task.detail = detail;
    this.store.saveTask(task, { state, detail });
  }

  submit(id, body) {
    const existing = this.tasks.get(id);
    if (existing) {
      if (existing.prompt !== body.prompt || existing.workspace !== body.workspace || existing.command !== body.command || existing.provider !== body.provider || existing.model !== body.model) {
        throw new Error('task_id_conflict');
      }
      return existing;
    }
    if (!Object.hasOwn(this.config.workspaces, body.workspace) || typeof body.prompt !== 'string' ||
      !body.prompt.trim() || body.prompt.length > 12000 || (body.command != null && typeof body.command !== 'string')) {
      throw new Error('invalid_task');
    }
    if ((body.provider !== undefined && !roles.includes(body.provider)) ||
        (body.model !== undefined && (!body.provider || typeof body.model !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(body.model)))) throw new Error('invalid_model_selection');
    if (this.tasks.size >= 10000) throw new Error('task_capacity');
    const task = { id, workspace: body.workspace, prompt: body.prompt, command: body.command, provider: body.provider, model: body.model, steps: [] };
    this.tasks.set(id, task);
    this.save(task, 'queued', 'submitted');
    this.pump();
    return task;
  }

  status(id, after) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('unknown_task');
    const { steps, prompt, ...summary } = task;
    return {
      ...summary, route: this.bridgeRoute(task.workspace),
      steps: steps.map(({ prompt, output, ...step }) => ({ ...step, output: output?.slice(0, 1600), paths: step.paths?.slice(0, 20) })),
      events: this.store.events(id, after),
    };
  }

  setRoute(route, bridge) {
    if (!['ssh', 'relay'].includes(route)) throw new Error('invalid_route');
    if (this.running.size) throw new Error('operations_in_progress');
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

  pump() {
    if (this.stopped || this.running.size) return;
    const task = [...this.tasks.values()].find((candidate) => {
      if (candidate.state !== 'queued') return false;
      if (!this.files.endpoint) return true;
      const route = this.bridgeRoute(candidate.workspace);
      const port = this.files.endpoint[route];
      return port?.ready && (!route.startsWith('relay') || port.online);
    });
    if (!task) return;
    const controller = new AbortController();
    this.running.set(task.id, controller);
    this.run(task, controller.signal).catch((error) => {
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
    });
  }

  async invoke(task, step, folder, signal, prompt = step.prompt) {
    const config = this.config.adapters[step.role];
    const mcp = this.config.mcp;
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
    }
  }

  async run(task, signal) {
    const repo = this.config.workspaces[task.workspace].repository;
    const root = path.join(this.config.stateDir, 'worktrees', task.id);
    await mkdir(path.join(this.config.stateDir, 'logs', task.id), { recursive: true, mode: 0o700 });
    if (!task.base) {
      const { head, clean } = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'command.execute', {
        operation: 'git_baseline', workspace: task.workspace,
      });
      if (!clean || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error('windows_workspace_dirty');
      await git(repo, ['cat-file', '-e', head + '^{commit}'], signal);
      task.base = head;
    }
    if (!task.steps.length && task.provider) {
      task.steps = [{ id: task.provider, role: task.provider, model: task.model, prompt: task.prompt,
        dependsOn: [], write: true, state: 'queued', attempts: 0 }];
    }
    if (!task.steps.length) {
      this.save(task, 'planning', 'planning_started');
      const planner = {
        id: 'planner', role: 'codex', write: false,
        prompt: 'Plan this development task. Return only a JSON array of objects with id, role (codex, claude, grok), prompt, and dependsOn (earlier step IDs). Use at most 12 steps. Only Codex can write. Task: ' + task.prompt,
      };
      const folder = path.join(root, 'planner');
      await this.ensureWorktree(repo, folder, task, planner, signal);
      const { output } = await this.invoke(task, planner, folder, signal);
      task.steps = parsePlan(output);
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

  async ensureWorktree(repo, folder, task, step, signal) {
    if (await readFile(path.join(folder, '.git'), 'utf8').then(() => true, () => false)) return;
    await worktree(repo, folder, 'agentdesk/' + task.id + '/' + step.id, task.base, signal);
  }

  async runStep(task, step, repo, root, signal) {
    const folder = path.join(root, step.id);
    await this.ensureWorktree(repo, folder, task, step, signal);
    const dependencies = task.steps.filter((dep) => step.dependsOn.includes(dep.id))
      .map((dep) => ({ id: dep.id, output: dep.output?.slice(0, 4000), paths: dep.paths?.slice(0, 50),
        patch: dep.paths?.length ? path.join(root, dep.id + '.patch') : undefined,
      }));
    for (;;) {
      step.state = 'running';
      step.attempts += 1;
      this.save(task, 'running', step.id + ':started');
      try {
        const prompt = dependencies.length ? step.prompt + '\nUpstream results: ' + JSON.stringify(dependencies) : step.prompt;
        const { output } = await this.invoke(task, step, folder, signal, prompt);
        signal.throwIfAborted();
        step.output = output;
        const { paths, patch } = await patchFor(folder, task.base, signal);
        if (!step.write && paths.length) throw new Error('readonly_step_changed_files');
        if (paths.length) await writeFile(path.join(root, step.id + '.patch'), patch, { mode: 0o600 });
        step.paths = paths;
        step.state = 'completed';
        this.save(task, 'running', step.id + ':completed');
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
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
    if (!task || task.state !== 'needs_review' || task.pendingRequest || this.running.size ||
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
    if (frame.kind === 'task.request') {
      if (named && this.config.workspaces[body.workspace]?.sshBridge !== named) throw new Error('workspace_not_authorized');
      return this.status(this.submit(id, body).id);
    }
    if (frame.kind !== 'task.status') throw new Error('unsupported_operation');
    if (body.operation === 'route_status' && (route === 'admin' || named)) {
      const channel = bridge ? this.namedBridgeRoute(bridge) : this.route;
      const port = this.files.endpoint;
      const relay = port[bridge ? 'relay:' + bridge : 'relay'];
      return { route: channel, ssh: Boolean(port[bridge ? 'ssh:' + bridge : 'ssh']?.ready), relay: Boolean(relay?.ready && relay.online) };
    }
    if (body.operation === 'select_route' && (route === 'admin' || named)) return this.setRoute(body.route, bridge);
    const task = this.tasks.get(id);
    if (named && this.config.workspaces[task?.workspace]?.sshBridge !== named) throw new Error('unknown_task');
    if (body.operation === 'status') return this.status(id, body.after);
    if (body.operation === 'reconcile' && (route === 'admin' || named)) return this.reconcile(task);
    if (body.operation === 'cancel' && task) return this.cancel(task);
    if (body.operation === 'apply' && (route === 'admin' || named)) return this.apply(task);
    throw new Error('unsupported_operation');
  }
}

module.exports = { Scheduler, parsePlan };
