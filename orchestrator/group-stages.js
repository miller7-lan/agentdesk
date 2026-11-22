// Group chat v7, second tranche — the orchestrator half (mixed into Scheduler; each part behind its switch in
// group-features.js, so with a switch off nothing here runs and the scheduler behaves as before).
//
//   G-P1  stageGroups        reading steps run side by side within 6 slots (4 per computer); a code-changing step
//                            holds its project's write token, so one writer per project at a time; after a failed
//                            parallel wave the task continues one step at a time.
//   G-P2a localStages        reading, review, diagnosis and acceptance read the live project and run any command
//                            there (M1, O1, Q3, M4); writeAnywhere: the writer writes anywhere outside the project
//                            without a confirmation (Q2) — N2's three kinds of folder stay closed.
//   G-P2b localCopy          a writer's commands run in a local copy holding its changes (M3); on a Mac the copy
//                            cannot write the original (O3); changes made there come back to the cloud worktree.
//   G-P2c credentialSandbox  on a Mac every group command runs with credential and AgentDesk folders closed (M2).
//   G-P2d envFix             test/verification (an env-check step after a failed local test), diagnosis, review and
//                            acceptance may apply an environment fix to the live project (P1, R1–R3, E1–E12).
//   req.4 leadAdvice         the next member of the lead chain writes the single-chat advice after a failed plan.
const path = require('node:path');
const { mkdir, writeFile, readFile, mkdtemp, rm, stat } = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { messageId } = require('./transport');
const { git, patchFor } = require('./git');
const { LEAD_CAPABILITIES } = require('./routing');
const { clip } = require('./summary');

const READ_SLOTS = 6;
const READ_SLOTS_PER_DEVICE = 4;
const ENV_FIX_MAX = 1024 * 1024;
const ENV_STAGES = new Set(['review', 'triage', 'accept']);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const readOnlyMode = (mode) => mode === 'chat' || mode === 'review_only';
// An older Bridge does not know the group operations: say so plainly instead of a confusing refusal.
const OLD_BRIDGE = /^(command_not_authorized|unsupported_operation|command_not_enabled_for_agents)$/;
const bridgeError = (error) => OLD_BRIDGE.test(error?.message || '') ? Object.assign(new Error('bridge_update_required'), { remoteConfirmed: true }) : error;

// Paths named in a unified diff (a/ and b/ sides, renames included).
function diffPaths(patch) {
  const names = new Set();
  for (const line of patch.split('\n')) {
    let match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) { names.add(match[1]); names.add(match[2]); continue; }
    match = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (match && match[1] !== '/dev/null') names.add(match[1]);
    match = /^rename (?:from|to) (.+)$/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

// N2 on VPS2 as well (the Bridge checks again against the real folders): no .git, no absolute or escaping paths,
// no credential files or folders, nothing of AgentDesk's own.
const CREDENTIAL_PARTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.agentdesk', '.password-store',
  '.codex', '.claude', '.gemini', '.grok', '.netrc', '.npmrc', '.git-credentials', '.pgpass', '.pypirc', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
function checkEnvNames(names) {
  if (!names.length) throw new Error('env_fix_empty');
  if (names.length > 200) throw new Error('env_fix_too_many_files');
  for (const name of names) {
    const parts = name.split(/[\\/]/);
    if (path.isAbsolute(name) || /^[a-z]:/i.test(name) || parts.includes('..')) throw new Error('path_escape');
    if (parts.some((part) => part.toLowerCase() === '.git')) throw new Error('git_path_denied');
    if (parts.some((part) => CREDENTIAL_PARTS.has(part.toLowerCase()))) throw new Error('credential_path_denied');
  }
}

const ENV_CHECK_PROMPT = 'The local test of this task failed on the person\'s computer (output below). Decide whether the cause is the ' +
  'computer\'s environment (toolchain, dependencies, paths, line endings, configuration, platform-specific code needed to run here) ' +
  'or the task\'s own code. Investigate with local_shell_run in the person\'s real project. If it is the environment, fix it with ' +
  'local_env_fix (a unified diff against the project), run the check again with local_shell_run, and end your reply with the line ' +
  'ENV_FIXED. If it is the task\'s code, change nothing and end with the line CODE_PROBLEM and what the writer must fix.\n\nTest output:\n';

const stageMethods = {
  // ---- G-P1 ----------------------------------------------------------------------------------------------
  async writeToken(workspace, signal, holder = {}, limitMs = 0) {
    this.writeTokens ||= new Map();
    for (;;) {
      const current = this.writeTokens.get(workspace);
      if (!current) break;
      // A holder that waits for the CLI the asker already holds would never let go: refuse instead of deadlocking.
      if (holder.role && current.holder.role === holder.role && current.holder.taskId !== holder.taskId &&
          (this.config.cliConcurrency?.[holder.role] ?? 1) <= 1 && holder.holdsCli) throw new Error('env_fix_project_busy');
      const stop = new AbortController();   // the timer is cleared as soon as the wait ends, so none lingers
      const outcome = await Promise.race([current.done.then(() => 'free'),
        ...(limitMs ? [delay(limitMs, 'timeout', { signal: stop.signal }).catch(() => 'free')] : []),
        ...(signal ? [new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }))] : [])]);
      stop.abort();
      if (outcome === 'aborted') throw signal.reason || new Error('cancelled');
      if (outcome === 'timeout') throw new Error('env_fix_project_busy');
    }
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    const entry = { holder, done };
    this.writeTokens.set(workspace, entry);
    return () => { if (this.writeTokens.get(workspace) === entry) this.writeTokens.delete(workspace); release(); };
  },

  async readSlot(task, signal) {
    this.readSlots ||= { total: 0, owners: new Map(), waiters: [] };
    const slots = this.readSlots;
    const owner = task.owner || 'default';
    const free = () => slots.total < READ_SLOTS && (slots.owners.get(owner) || 0) < READ_SLOTS_PER_DEVICE;
    while (!free()) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve };
        slots.waiters.push(waiter);
        signal?.addEventListener('abort', () => {
          const at = slots.waiters.indexOf(waiter);
          if (at >= 0) slots.waiters.splice(at, 1);
          reject(signal.reason || new Error('cancelled'));
        }, { once: true });
      });
    }
    slots.total += 1;
    slots.owners.set(owner, (slots.owners.get(owner) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slots.total -= 1;
      slots.owners.set(owner, slots.owners.get(owner) - 1);
      for (const waiter of slots.waiters.splice(0)) waiter.resolve();
    };
  },

  // ---- access per step (G-P2a … G-P2d) ---------------------------------------------------------------------
  stepAccess(task, step, grantedTools) {
    const f = this.features || {};
    const none = {};
    if (!task.snapshot || readOnlyMode(task.mode) || step.localTools === 'desktop' || grantedTools === 'desktop') return none;
    const duty = step.capability || (step.write ? 'implement' : 'scout');
    if (step.write) {
      if (!f.writeAnywhere && !f.localCopy) return none;
      return { localTools: 'local-write', anyCommand: Boolean(f.localCopy), localCopy: Boolean(f.localCopy),
        writeAnywhere: Boolean(f.writeAnywhere), backupOutside: Boolean(f.writeAnywhere), credentialSandbox: Boolean(f.credentialSandbox) };
    }
    const planner = duty === 'plan' || step.id === 'planner' || step.id === 'group-planner';
    const envFix = Boolean(f.envFix) && !planner && (ENV_STAGES.has(duty) || step.envCheck === true);   // E3: planning does not write
    if (!f.localStages && !envFix) return none;
    return { localTools: 'local', anyCommand: Boolean(f.localStages) || envFix, envFix, liveProject: true,
      writeAnywhere: envFix, backupOutside: envFix, credentialSandbox: Boolean(f.credentialSandbox) };   // R1: like the writer
  },

  accessNote(access) {
    if (!access.localTools) return '';
    if (access.localTools === 'local-write') {
      return '\n' + [access.writeAnywhere && 'Outside the project you may write anywhere on the person\'s computer with the windows_* file tools (root "computer", absolute paths); no confirmation is asked. Credential folders, .git and AgentDesk\'s folders are refused.',
        access.localCopy && 'local_shell_run runs commands on the person\'s computer in a local copy of the project that holds your current changes; what those commands change there comes back to this working tree. Project files are still changed here and delivered as a reviewed patch.'].filter(Boolean).join(' ');
    }
    return '\nThe person\'s real project (as it is now, without this task\'s changes) can be read with the windows_* tools (root "project")' +
      (access.anyCommand ? ' and any command can be run there with local_shell_run (reading, checking, testing; do not change the project with it)' : '') + '.' +
      (access.envFix ? ' If a local check fails because of this computer\'s environment (toolchain, dependencies, paths, line endings, configuration, or platform-specific source needed to run here), fix it yourself with local_env_fix and run the check again; report every fix you made. Problems in the task\'s own logic are not environment problems: report them.' : '');
  },

  // ---- G-P2b: the writer's local copy ---------------------------------------------------------------------
  stepFolder(task, step) {
    return path.join(this.config.stateDir, 'worktrees', task.id, step.worktreeStep || step.id);
  },

  async prepareCopy(scope) {
    const task = this.tasks.get(scope.taskId);
    const step = task?.steps?.find((item) => item.id === scope.stepId);
    if (!task || !step) throw new Error('task_not_found');
    const route = this.bridgeRoute(task.workspace);
    const { patch } = await patchFor(this.stepFolder(task, step), task.base, scope.signal);
    const bytes = Buffer.from(patch);
    if (bytes.length > 3 * 1024 * 1024) throw new Error('patch_too_large');
    const stream = bytes.length ? await this.files.upload(route, task.id, bytes, undefined, scope.signal) : undefined;
    const copyId = step.worktreeStep || step.id;
    let value;
    try {
      value = await this.files.call(route, task.id, 'command.execute', { operation: 'copy_sync', workspace: task.workspace, stepId: copyId,
        base: task.snapshot.head, snapshotVersion: task.snapshot.version, ...(stream && { stream_id: stream }) }, 600000, scope.signal);
    } catch (error) {
      const mapped = bridgeError(error);
      if (/^local_copy_unavailable/.test(mapped.message)) this.copyNotice(task, step, 'unavailable', mapped.message.split(':')[1]);
      throw mapped;
    }
    task.localCopies = [...new Set([...(task.localCopies || []), copyId])];
    if (value?.created) this.copyNotice(task, step, 'created', null, value.enforcement);
    return { copyId, sent: sha(bytes) };
  },

  async collectCopy(scope, prepared) {
    const task = this.tasks.get(scope.taskId);
    const step = task?.steps?.find((item) => item.id === scope.stepId);
    const route = this.bridgeRoute(task.workspace);
    const diff = await this.files.call(route, task.id, 'command.execute', { operation: 'copy_diff', workspace: task.workspace, stepId: prepared.copyId }, 120000, scope.signal);
    if (!diff?.changed) return { changed: false };
    const folder = this.stepFolder(task, step);
    // The working tree must still be what the copy started from; otherwise the copy's changes are not taken.
    if (sha(Buffer.from((await patchFor(folder, task.base, scope.signal)).patch)) !== prepared.sent) return { changed: true, taken: false, reason: 'worktree_changed' };
    const bytes = diff.artifact ? await this.files.download(route, task.id, { operation: 'artifact', ...diff.artifact }, scope.signal) : Buffer.alloc(0);
    if (diff.artifact && sha(bytes) !== diff.artifact.sha256) throw new Error('local_copy_transfer_failed');
    const file = path.join(this.config.stateDir, 'worktrees', task.id, 'copy-' + randomUUID() + '.patch');
    await writeFile(file, bytes, { mode: 0o600 });
    // Secret-looking files the Bridge kept on the computer stay as the working tree has them.
    const kept = [];
    for (const name of Array.isArray(diff.kept) ? diff.kept : []) {
      const target = path.join(folder, name);
      if (path.relative(folder, target).startsWith('..')) continue;
      const content = await readFile(target).catch(() => null);
      if (content) kept.push([target, content]);
    }
    try {
      await git(folder, ['reset', '-q', '--hard', task.base], scope.signal);
      await git(folder, ['clean', '-fdq'], scope.signal);
      if (bytes.length) await git(folder, ['apply', '--binary', '--whitespace=nowarn', file], scope.signal);
      for (const [target, content] of kept) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o600 });
      }
    } finally { await rm(file, { force: true }); }
    return { changed: true, taken: true };
  },

  copyNotice(task, step, kind, reason, enforcement) {
    task.copyNotices = [...(task.copyNotices || []), { at: new Date(this.now()).toISOString(), stepId: step.id, kind,
      ...(reason && { reason }), ...(enforcement && { enforcement }) }].slice(-20);
    this.save(task, task.state, task.detail, false);
  },

  removeCopies(task) {
    if (!task.localCopies?.length) return;
    delete task.localCopies;
    this.files?.call?.(this.bridgeRoute(task.workspace), task.id, 'command.execute', { operation: 'copy_remove', workspace: task.workspace }, 120000)?.catch?.(() => {});
  },

  // ---- the shell tool (service.js calls this) --------------------------------------------------------------
  async groupShell(scope, frame, run) {
    const task = this.tasks.get(scope.taskId);
    if (!task) throw new Error('task_not_found');
    const prepared = scope.localCopy ? await this.prepareCopy(scope) : null;
    let value;
    try {
      value = await run({ operation: 'group_shell', stepId: prepared ? prepared.copyId : scope.stepId, workspace: scope.workspace,
        script: frame.script, shell: frame.shell, cwd: frame.cwd, timeout_ms: frame.timeout_ms ?? 300000,
        copy: Boolean(prepared), credentialSandbox: scope.credentialSandbox === true });
    } catch (error) { throw bridgeError(error); }
    if (value?.originalChanged) {
      const step = task.steps?.find((item) => item.id === scope.stepId);
      if (step) this.copyNotice(task, step, 'original_changed', 'the original project changed while a command ran in the copy (Windows: not enforced)');
    }
    if (prepared) value = { ...value, copy: await this.collectCopy(scope, prepared).catch((error) => ({ changed: null, error: error.message })) };
    return value;
  },

  // ---- G-P2d: environment fixes ----------------------------------------------------------------------------
  async waitWriters(task, step, signal, limitMs = 20 * 60_000) {
    const end = this.now() + limitMs;
    for (;;) {
      const writers = (task.steps || []).filter((item) => item.write && item.state === 'running' && item.id !== step?.id);
      if (!writers.length) return;
      // E9: the writer of this task finishes first — unless it is waiting for the CLI this step holds.
      if (step && writers.some((item) => item.role === step.role && (this.config.cliConcurrency?.[step.role] ?? 1) <= 1)) throw new Error('env_fix_wait_writer');
      if (this.now() > end) throw new Error('env_fix_wait_writer');
      await delay(2000, undefined, { signal });
    }
  },

  async envFix(scope, { patch, reason, platformSource }) {
    const task = this.tasks.get(scope.taskId);
    const step = task?.steps?.find((item) => item.id === scope.stepId);
    if (!task || !step) throw new Error('task_not_found');
    if (typeof patch !== 'string' || !patch.trim() || Buffer.byteLength(patch) > ENV_FIX_MAX) throw new Error('invalid_env_fix');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('env_fix_reason_required');
    const bytes = Buffer.from(patch.endsWith('\n') ? patch : patch + '\n');
    const names = diffPaths(bytes.toString());
    checkEnvNames(names);
    await this.waitWriters(task, step, scope.signal);
    const release = await this.writeToken(task.workspace, scope.signal, { taskId: task.id, role: step.role, holdsCli: true }, 20 * 60_000);
    const releaseApply = this.holdApply(task.workspace);
    const fix = { id: randomUUID(), at: new Date(this.now()).toISOString(), stepId: step.id, stage: step.envCheck ? 'test' : (step.capability || 'scout'),
      role: step.role, reason: clip(reason.trim(), 600), platformSource: platformSource === true, files: names.slice(0, 50),
      sha256: sha(bytes), state: 'applying', requestId: messageId(), cloud: task.applied ? 'not_needed' : 'pending', afterApply: Boolean(task.applied) };
    task.envFixes = [...(task.envFixes || []), fix];
    const folder = path.join(this.config.stateDir, 'worktrees', task.id, 'env-fixes');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path.join(folder, fix.id + '.patch'), bytes, { mode: 0o600 });
    this.save(task, task.state, 'env_fix_started:' + fix.id);
    try {
      const route = this.bridgeRoute(task.workspace);
      let value;
      try {
        const stream = await this.files.upload(route, task.id, bytes, undefined, scope.signal);
        value = await this.files.call(route, task.id, 'command.execute', { operation: 'env_fix_apply', workspace: task.workspace,
          stream_id: stream, fixId: fix.id, expectVersion: task.applied ? null : task.snapshot?.version ?? null }, 180000, scope.signal, fix.requestId);
      } catch (error) {
        const mapped = bridgeError(error);
        // E10: the reply was lost (the computer went offline): the outcome is asked for again when it is back.
        if (mapped.remoteConfirmed) Object.assign(fix, { state: 'failed', error: clip(mapped.message, 200) });
        else fix.state = 'unknown';
        this.save(task, task.state, 'env_fix_' + fix.state + ':' + fix.id);
        throw mapped;
      }
      await this.afterEnvFix(task, fix, value, bytes);
      return { applied: true, fixId: fix.id, files: fix.files, cloud: fix.cloud, ...(fix.cloudError && { cloudError: fix.cloudError }) };
    } finally {
      releaseApply();
      release();
    }
  },

  async afterEnvFix(task, fix, value, bytes) {
    Object.assign(fix, { state: 'applied', appliedAt: new Date(this.now()).toISOString(),
      files: Array.isArray(value?.files) ? value.files.slice(0, 50) : fix.files });
    if (!task.applied && task.snapshot && value?.after) task.snapshot.version = value.after;   // apply() checks this version
    task.envFixSeq = (task.envFixSeq || 0) + 1;
    this.save(task, task.state, 'env_fix_applied:' + fix.id);
    if (fix.cloud === 'pending') await this.syncFixToCloud(task, fix, bytes);
  },

  // E8: the same fix in the cloud: a new snapshot commit (the task's base), the fix in every working tree, and the
  // writers' patches rebuilt against the new base, so the next patch does not carry or fight the fix.
  async syncFixToCloud(task, fix, bytes, { reverse = false } = {}) {
    const root = path.join(this.config.stateDir, 'worktrees', task.id);
    const repo = this.config.workspaces[task.workspace].repository;
    const file = path.join(root, 'env-fixes', fix.id + (reverse ? '.revert' : '') + '.patch');
    await writeFile(file, bytes || await readFile(path.join(root, 'env-fixes', fix.id + '.patch')), { mode: 0o600 });
    const snapshot = path.join(root, 'project-snapshot');
    try {
      await this.ensureWorktree(repo, snapshot, task, { id: 'project-snapshot' });
      await git(snapshot, ['reset', '-q', '--hard', task.base]);
      const folders = [];
      for (const id of new Set((task.steps || []).map((item) => item.worktreeStep || item.id))) {
        const folder = path.join(root, id);
        if (id !== 'project-snapshot' && await stat(path.join(folder, '.git')).then(() => true, () => false)) folders.push(folder);
      }
      const args = ['apply', '--binary', '--whitespace=nowarn', ...(reverse ? ['-R'] : [])];
      for (const folder of [snapshot, ...folders]) {
        try { await git(folder, [...args, '--check', file]); }
        catch { Object.assign(fix, { cloud: 'conflict', cloudError: 'conflict in ' + path.basename(folder) }); this.save(task, task.state, 'env_fix_cloud_conflict:' + fix.id); return; }
      }
      await git(snapshot, [...args, '--index', file]);
      await git(snapshot, ['-c', 'user.name=AgentDesk', '-c', 'user.email=agentdesk@example.invalid', 'commit', '-q', '--no-verify', '--no-gpg-sign',
        '-m', (reverse ? 'AgentDesk environment fix undone ' : 'AgentDesk environment fix ') + fix.id]);
      const base = (await git(snapshot, ['rev-parse', 'HEAD'])).trim();
      for (const folder of folders) await git(folder, [...args, file]);
      task.base = base;
      if (task.snapshot) task.snapshot.base = base;
      if (task.groupPlan) task.groupPlan.base = base;
      for (const item of task.steps || []) {
        if (!item.write || !item.paths?.length) continue;
        const { paths, patch } = await patchFor(path.join(root, item.worktreeStep || item.id), base);
        await writeFile(path.join(root, item.id + '.patch'), patch, { mode: 0o600 });
        item.paths = paths;
      }
      Object.assign(fix, reverse ? { cloudReverted: new Date(this.now()).toISOString() } : { cloud: 'synced', syncedAt: new Date(this.now()).toISOString() });
      delete fix.cloudError;
      this.save(task, task.state, (reverse ? 'env_fix_cloud_reverted:' : 'env_fix_cloud_synced:') + fix.id);
    } catch (error) {
      // Not a conflict (a disk or Git error on VPS2): tried again on the next tick.
      Object.assign(fix, { cloud: reverse ? fix.cloud : 'pending', cloudError: clip(error.message, 200) });
      this.save(task, task.state, 'env_fix_cloud_pending:' + fix.id);
    }
  },

  async revertEnvFix(task, fixId) {
    const fix = task.envFixes?.find((item) => item.id === fixId);
    if (!fix || fix.state !== 'applied' || fix.reverted) throw new Error('env_fix_not_revertible');
    if (this.running.has(task.id) && (task.steps || []).some((item) => item.write && item.state === 'running')) throw new Error('env_fix_wait_writer');
    const release = await this.writeToken(task.workspace, undefined, { taskId: task.id }, 60_000);
    const releaseApply = this.holdApply(task.workspace);
    try {
      let value;
      try {
        value = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'command.execute', { operation: 'env_fix_revert', workspace: task.workspace,
          fixId, snapshot: !task.applied }, 120000);
      } catch (error) { throw bridgeError(error); }
      fix.reverted = new Date(this.now()).toISOString();
      if (!task.applied && task.snapshot && value?.version) task.snapshot.version = value.version;
      task.envFixSeq = (task.envFixSeq || 0) + 1;
      this.save(task, task.state, 'env_fix_reverted:' + fix.id);
      if (fix.cloud === 'synced' && !task.applied) await this.syncFixToCloud(task, fix, undefined, { reverse: true });
      return { reverted: true, fixId, cloud: fix.cloudReverted ? 'reverted' : fix.cloud };
    } finally {
      releaseApply();
      release();
    }
  },

  // E10: fixes whose reply was lost are asked for again; fixes not yet in the cloud are carried there again.
  async reconcileEnvFixes() {
    if (this.envReconciling) return;
    this.envReconciling = true;
    try {
      for (const task of this.tasks.values()) {
        for (const fix of task.envFixes || []) {
          if (fix.state === 'unknown') {
            const outcome = await this.files.call(this.bridgeRoute(task.workspace), task.id, 'task.status',
              { operation: 'operation_status', request_id: fix.requestId }, 5000).catch(() => null);
            if (outcome?.state === 'unknown') { Object.assign(fix, { state: 'failed', error: 'env_fix_not_received' }); this.save(task, task.state, 'env_fix_failed:' + fix.id); continue; }
            if (outcome?.state !== 'finished') continue;
            if (outcome.kind === 'error') { Object.assign(fix, { state: 'failed', error: clip(outcome.outcome?.error || 'failed', 200) }); this.save(task, task.state, 'env_fix_failed:' + fix.id); }
            else await this.afterEnvFix(task, fix, outcome.outcome?.value, undefined);
          } else if (fix.state === 'applied' && fix.cloud === 'pending' && !task.applied && !this.running.has(task.id)) {
            await this.syncFixToCloud(task, fix);
          }
        }
      }
    } finally { this.envReconciling = false; }
  },

  // P1 / E1 / E7: a failed local test first goes to an env-check step (the "test stage" fixing its environment);
  // only a code problem — or a second failure — goes back to the writer, as before.
  scheduleEnvCheck(task, evidence, summary) {
    if (!this.features?.envFix || task.applied || evidence.envChecked || (task.envChecks || 0) >= 2) return false;
    const role = this.pickForTask(task, 'scout');
    if (!role) return false;
    evidence.envChecked = true;
    task.envChecks = (task.envChecks || 0) + 1;
    const model = this.orderModels(task, 'scout', role)[0] || this.defaultModelFor(role);
    task.steps.push({ id: 'env-check-' + task.envChecks, role, ...(model && { model }), capability: 'scout', envCheck: true,
      prompt: ENV_CHECK_PROMPT + clip(summary, 3000), dependsOn: [], write: false, state: 'queued', attempts: 0 });
    this.save(task, 'running', 'env_check_scheduled');
    return true;
  },

  // ---- requirement 4: advice written by the next member of the lead chain ----------------------------------
  async adviseByLead(task, detail) {
    if (!this.features?.leadAdvice || !task.directAdvice || task.directAdvice.source === 'lead') return;
    this.advising ||= new Set();
    if (this.advising.has(task.id)) return;
    this.advising.add(task.id);
    let directory;
    try {
      const failed = new Set((task.cliCalls || []).filter((call) => call.capability === 'plan' || /planner/.test(call.stepId || '')).map((call) => call.provider));
      const chain = [...new Set([...[...LEAD_CAPABILITIES].flatMap((capability) => [
        ...this.orderEntries(task, capability).map((entry) => entry.role), ...(this.router.routes?.[capability] || [])]),
      ...(this.router.roles?.() || [])])];
      const role = chain.find((candidate) => !failed.has(candidate) && this.config.adapters?.[candidate] && this.router.configured?.(candidate) !== false &&
        this.router.available?.(candidate) !== false && this.router.quotaAllows?.(candidate, 'plan', undefined) !== false);
      if (!role) return;
      const model = this.orderModels(task, 'plan', role).find(Boolean) || this.defaultModelFor(role);
      const members = (this.router.roles?.() || []).filter((item) => this.router.available?.(item) !== false);
      const prompt = 'A group-chat plan for the request below failed (' + clip(String(detail || ''), 200) + '). As the next member of the lead chain, ' +
        'tell the person, in Chinese, why it most likely failed and give two or three single-chat attempts they can open directly. ' +
        'Return only JSON: {"reason":"…","options":[{"role":"' + members.join('|') + '","access":"readOnly|fullAccess","prompt":"the first message for that chat","why":"…"}]}.' +
        '\nRequest: ' + clip(String(task.prompt || ''), 3000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('advice_timeout')), 240_000);
      const release = await this.acquireCli(task, { id: 'advice', role }, controller.signal);
      try {
        directory = await mkdtemp(path.join(this.config.stateDir, 'advice-'));
        await mkdir(path.join(this.config.stateDir, 'logs', task.id), { recursive: true, mode: 0o700 });
        this.recordCall?.(role);
        const result = await this.adapter({ name: role, config: this.config.adapters[role], cwd: directory, prompt, readonly: true,
          timeout: 180_000, printTimeoutMs: 180_000, signal: controller.signal, log: path.join(this.config.stateDir, 'logs', task.id, 'advice.log'),
          ...(model && { model }) });
        const parsed = parseAdvice(result?.output, members, task);
        if (!parsed) return;
        for (const option of parsed.options) option.model = this.defaultModelFor(option.role) || null;
        task.directAdvice = { ...task.directAdvice, ...parsed, source: 'lead', by: role, ...(model && { byModel: model }), at: new Date(this.now()).toISOString() };
        this.save(task, task.state, task.detail, false);
      } finally {
        clearTimeout(timer);
        release();
      }
    } catch (error) {
      if (task.directAdvice) task.directAdvice.leadError = clip(error.message, 120);
    } finally {
      this.advising.delete(task.id);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  },
};

function parseAdvice(output, members, task) {
  const text = String(output || '');
  let value;
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { value = JSON.parse(candidate.replace(/^```(?:json)?\s*|\s*```$/g, '')); break; } catch { /* next */ }
  }
  if (!value || typeof value.reason !== 'string' || !Array.isArray(value.options)) return null;
  const options = value.options.filter((option) => option && members.includes(option.role) && typeof option.prompt === 'string' && option.prompt.trim())
    .slice(0, 3).map((option) => ({ role: option.role, model: null, access: option.access === 'readOnly' ? 'readOnly' : 'fullAccess',
      project: task.project || null, workspace: task.workspace || null, prompt: clip(option.prompt, 2000), why: clip(String(option.why || ''), 200) }));
  if (!options.length) return null;
  return { reason: clip(value.reason, 300), options };
}

module.exports = { stageMethods, diffPaths, checkEnvNames, parseAdvice, bridgeError, READ_SLOTS, READ_SLOTS_PER_DEVICE };
