// Group chat v7, the person's computer (Bridge side). Everything here is reached only when VPS2 asks for it with a
// group switch on (group-features.js); an older VPS2 never sends these operations.
//
//   group_shell     M1/O1/Q3/M4: any command, in the live project (reading, review, diagnosis, acceptance) or, for
//                   a code-changing step, in its local copy (M3). Mac: sandbox-exec (M2 credentials, O3 original
//                   closed for writing in the copy). Windows: no enforcement; the copy is checked for changes of
//                   the original made outside a patch, and the result says so.
//   copy_sync       M3: create the local copy (APFS clone on a Mac, a plain copy on Windows), at most 2 GB and only
//                   with twice that free, and bring it to the snapshot plus the step's current changes.
//   copy_diff       the copy's changes against the snapshot, so changes made by local tools reach the cloud worktree.
//   copy_remove     the task's copies, when the task ends (and old ones at Bridge start).
//   env_fix_apply   P1/R2/R3: an environment fix as a patch in the live project. Credential folders, .git and
//                   AgentDesk's own folders are refused (N2); the previous content of each file is kept so the fix
//                   can be undone; the project's version before and after is returned for VPS2's records.
//   env_fix_revert  undo one fix, only while its files are still as the fix left them.
//   outside_restore R1: put back a file outside the project that a step overwrote, moved or deleted.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { forPlatform, folderSize, freeSpace, COPY_LIMIT } = require('./platform');

const SAFE = /^[A-Za-z0-9_.:-]{1,120}$/;
const SENSITIVE = /(?:^|[\\/])(?:\.env(?:\..*)?|[^\\/]+\.(?:pem|pfx|p12|key))$/i;
// N2 for a path relative to the project (the copy lives in AgentDesk's own folder, so absolute checks would refuse all).
const deniedName = (name) => { try { require('./group-stages').checkEnvNames([name]); return false; } catch { return true; } };
const sha = (data) => createHash('sha256').update(data).digest('hex');
const under = (value, root) => value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

class GroupLocal {
  // helpers from windows.js: git(root,args,signal,env,limit), projectSnapshot(root,signal), allowedPath(abs) -> bool,
  // stream(taskId,id), streamPath(id), saveArtifact(taskId,bytes), commands (CommandRuns)
  constructor(helpers, { stateDir, config = {}, platform = forPlatform() } = {}) {
    this.h = helpers;
    this.stateDir = stateDir;
    this.config = config;
    this.platform = platform;
    this.busyCopies = new Set();
    this.swept = false;
  }

  copiesRoot() { return path.join(this.stateDir, 'group-copies'); }
  copyDir(taskId, stepId) {
    if (!SAFE.test(taskId) || !SAFE.test(stepId)) throw new Error('invalid_copy_id');
    return path.join(this.copiesRoot(), taskId, stepId);
  }

  async call(taskId, requestId, workspace, root, body) {
    const op = body.operation;
    if (op === 'group_shell') return this.shell(taskId, requestId, workspace, root, body);
    if (op === 'copy_sync') return this.withCopy(taskId, body.stepId, () => this.copySync(taskId, root, body));
    if (op === 'copy_diff') return this.withCopy(taskId, body.stepId, () => this.copyDiff(taskId, body));
    if (op === 'copy_remove') return this.copyRemove(taskId);
    if (op === 'env_fix_apply') return this.envFixApply(taskId, root, body);
    if (op === 'env_fix_revert') return this.envFixRevert(taskId, root, body);
    if (op === 'outside_restore') return this.outsideRestore(taskId, body);
    throw new Error('unsupported_operation');
  }

  async withCopy(taskId, stepId, work) {
    const key = taskId + '/' + stepId;
    if (this.busyCopies.has(key)) throw new Error('local_copy_busy');
    this.busyCopies.add(key);
    try { return await work(); } finally { this.busyCopies.delete(key); }
  }

  enforcement(copy) {
    const { platform, enforcement, labels } = this.platform;
    return { platform, credentials: enforcement.credentials, ...(copy && { original: enforcement.original }),
      labels: [labels.credentials, copy && labels.copy].filter(Boolean) };
  }

  async originalTop(root) {
    const result = await this.h.git(root, ['rev-parse', '--show-toplevel'], new AbortController().signal);
    const top = result.code === 0 && result.stdout.trim();
    return top ? fs.realpath(top) : root;
  }

  async shell(taskId, requestId, workspace, root, body) {
    if (this.config.groupShell === false || workspace.groupShell === false) throw new Error('group_shell_disabled_on_this_computer');
    const script = body.script;
    if (typeof script !== 'string' || !script.trim() || script.length > 20000 || script.includes('\0')) throw new Error('invalid_group_shell_command');
    const timeout = body.timeout_ms ?? 300000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900000) throw new Error('invalid_group_shell_timeout');
    const inCopy = body.copy === true;
    const base = inCopy ? this.copyDir(taskId, body.stepId) : root;
    if (inCopy && !await fs.stat(path.join(base, '.git')).then(() => true, () => false)) throw new Error('local_copy_missing');
    if (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length > 1000 || body.cwd.includes('\0'))) throw new Error('invalid_group_shell_directory');
    const cwd = path.resolve(base, body.cwd || '.');
    if (!under(cwd, base)) throw new Error('invalid_group_shell_directory');
    const kinds = this.platform.platform === 'windows' ? ['powershell', 'cmd'] : this.platform.platform === 'mac' ? ['zsh', 'bash'] : ['bash', 'zsh'];
    const kind = body.shell ?? kinds[0];
    if (!kinds.includes(kind)) throw new Error('invalid_group_shell');
    const spec = this.platform.shell(script, kind);
    const launch = Array.isArray(spec) ? { argv: spec } : spec;
    const top = inCopy ? await this.originalTop(root) : null;
    const argv = this.platform.platform === 'mac'
      ? this.platform.wrap(launch.argv, { credentials: body.credentialSandbox === true, extra: [this.stateDir].filter(Boolean), denyWrite: top ? [top, root] : [] })
      : launch.argv;
    // Windows (and Linux tests): the original cannot be closed, so a change to it during the copy's command is reported.
    const watch = inCopy && this.platform.enforcement.original !== 'sandbox';
    const before = watch ? await this.h.projectSnapshot(root, new AbortController().signal).then((value) => value.version, () => null) : null;
    const result = await this.h.commands.start({ scope: taskId, key: requestId, name: 'group_shell', argv, cwd, timeout,
      native: { windowsVerbatimArguments: launch.windowsVerbatimArguments } });
    const after = watch ? await this.h.projectSnapshot(root, new AbortController().signal).then((value) => value.version, () => null) : null;
    if (result.code === null) throw new Error(result.error || 'group_shell_failed');
    const { code, stdout, stderr, truncated } = result;
    return { code, stdout, stderr, ...(truncated && { truncated }), location: inCopy ? 'copy' : 'project',
      enforcement: this.enforcement(inCopy), ...(watch && before !== after && { originalChanged: true }) };
  }

  async copySync(taskId, root, body) {
    const directory = this.copyDir(taskId, body.stepId);
    const signal = new AbortController().signal;
    const git = async (args, limit) => {
      const result = await this.h.git(directory, args, signal, undefined, limit);
      if (result.code !== 0) throw new Error('local_copy_git_failed');
      return result;
    };
    const metaFile = path.join(directory, '..', body.stepId + '.json');
    let meta = await fs.readFile(metaFile, 'utf8').then(JSON.parse, () => null);
    let created = false;
    if (!meta) {
      const gitEntry = await fs.lstat(path.join(root, '.git')).catch(() => null);
      if (!gitEntry?.isDirectory()) throw new Error('local_copy_unavailable:needs_git_root');
      const { size, tooLarge } = await folderSize(root, COPY_LIMIT);
      if (tooLarge) throw new Error('local_copy_unavailable:too_large');
      await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      if (await freeSpace(path.dirname(directory)) < size * 2) throw new Error('local_copy_unavailable:disk_space');
      await fs.rm(directory, { recursive: true, force: true });
      await this.platform.copyProject(root, directory);
      await fs.chmod(directory, 0o700).catch(() => {});
      try {
        // The copy must be the project the group planned on (its snapshot), or nothing is done in it.
        const { head, version } = await this.h.projectSnapshot(directory, signal);
        if (head !== body.base || (body.snapshotVersion !== undefined && version !== body.snapshotVersion)) throw new Error('plan_workspace_changed');
        await git(['add', '-A']);
        await git(['-c', 'user.name=AgentDesk', '-c', 'user.email=agentdesk@example.invalid', 'commit', '-q', '--no-verify', '--no-gpg-sign', '--allow-empty', '-m', 'AgentDesk snapshot']);
        const pristine = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        meta = { pristine, size, createdAt: Date.now() };
        await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
        created = true;
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    // Back to the snapshot (ignored files such as node_modules and .env stay), then the step's current changes.
    await git(['reset', '-q', '--hard', meta.pristine]);
    await git(['clean', '-fdq']);
    let applied = null;
    if (body.stream_id) {
      const record = this.h.stream(taskId, body.stream_id);
      if (!record.closed) throw new Error('stream_incomplete');
      const file = this.h.streamPath(body.stream_id);
      applied = sha(await fs.readFile(file));
      if ((await this.h.git(directory, ['apply', '--binary', '--whitespace=nowarn', file], signal)).code !== 0) throw new Error('local_copy_patch_failed');
    }
    meta.applied = applied;
    await fs.writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
    return { copy: true, created, size: meta.size, applied, enforcement: this.enforcement(true) };
  }

  async copyDiff(taskId, body) {
    const directory = this.copyDir(taskId, body.stepId);
    const meta = JSON.parse(await fs.readFile(path.join(directory, '..', body.stepId + '.json'), 'utf8').catch(() => { throw new Error('local_copy_missing'); }));
    const signal = new AbortController().signal;
    const index = await fs.mkdtemp(path.join(this.stateDir, 'copy-index-'));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(index, 'index'), GIT_OPTIONAL_LOCKS: '0' };
      for (const args of [['read-tree', meta.pristine], ['add', '-A']]) {
        if ((await this.h.git(directory, args, signal, env)).code !== 0) throw new Error('local_copy_git_failed');
      }
      // Secrets stay on this computer, as in the project snapshot: .env, keys, certificates, N2 paths.
      const listed = await this.h.git(directory, ['diff', '--cached', '--no-renames', '--name-only', '-z', meta.pristine], signal, env);
      if (listed.code !== 0) throw new Error('local_copy_git_failed');
      const secret = listed.stdout.split('\0').filter(Boolean).filter((name) => SENSITIVE.test(name) || deniedName(name));
      if (secret.length && (await this.h.git(directory, ['reset', '-q', meta.pristine, '--', ...secret.map((name) => ':(literal)' + name)], signal, env)).code !== 0) {
        throw new Error('local_copy_git_failed');
      }
      const result = await this.h.git(directory, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', meta.pristine], signal, env, 3 * 1024 * 1024 + 1);
      if (result.code !== 0) throw new Error('local_copy_git_failed');
      if (result.truncated || Buffer.byteLength(result.stdout) > 3 * 1024 * 1024) throw new Error('patch_too_large');
      const bytes = Buffer.from(result.stdout);
      const digest = sha(bytes);
      if (digest === meta.applied || (!bytes.length && !meta.applied)) return { changed: false, sha256: digest };
      return { changed: true, sha256: digest, artifact: bytes.length ? await this.h.saveArtifact(taskId, bytes) : null,
        ...(secret.length && { kept: secret.slice(0, 50) }) };
    } finally {
      await fs.rm(index, { recursive: true, force: true });
    }
  }

  async copyRemove(taskId) {
    if (!SAFE.test(taskId)) throw new Error('invalid_copy_id');
    await fs.rm(path.join(this.copiesRoot(), taskId), { recursive: true, force: true });
    return { removed: true };
  }

  // Copies left by a Bridge that stopped (at the first sweep), and any older than a day.
  async sweep(now = Date.now()) {
    const first = !this.swept;
    this.swept = true;
    const entries = await fs.readdir(this.copiesRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(this.copiesRoot(), entry.name);
      const info = await fs.stat(folder).catch(() => null);
      if (info && (first || info.mtimeMs < now - 24 * 3600 * 1000) && ![...this.busyCopies].some((key) => key.startsWith(entry.name + '/'))) {
        await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // Paths a patch touches, as git reads them (renames and copies included).
  async patchPaths(root, file) {
    const result = await this.h.git(root, ['apply', '--numstat', '-z', file], new AbortController().signal);
    if (result.code !== 0) throw new Error('env_fix_invalid_patch');
    const names = new Set();
    const records = result.stdout.split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const match = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(records[index]);
      if (!match) continue;
      if (match[1]) names.add(match[1]);
      else { names.add(records[index + 1]); names.add(records[index + 2]); index += 2; }   // a rename: old and new name follow
    }
    return [...names].filter(Boolean);
  }

  // N2: never .git, credential folders and files, AgentDesk's own folders; and never outside the project.
  checkEnvPaths(root, names) {
    if (!names.length) throw new Error('env_fix_empty');
    if (names.length > 200) throw new Error('env_fix_too_many_files');
    return names.map((name) => {
      if (name.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) throw new Error('git_path_denied');
      const target = path.resolve(root, name);
      if (!under(target, root) || target === root) throw new Error('path_escape');
      if (!this.h.allowedPath(target)) throw new Error('credential_path_denied');
      return { name, target };
    });
  }

  fixDir(taskId, fixId) {
    if (!SAFE.test(taskId) || !SAFE.test(fixId)) throw new Error('invalid_env_fix_id');
    return path.join(this.stateDir, 'env-fixes', taskId, fixId);
  }

  async envFixApply(taskId, root, body) {
    const record = this.h.stream(taskId, body.stream_id);
    if (!record.closed) throw new Error('stream_incomplete');
    const file = this.h.streamPath(body.stream_id);
    const signal = new AbortController().signal;
    const directory = this.fixDir(taskId, body.fixId);
    if (await fs.stat(path.join(directory, 'manifest.json')).then(() => true, () => false)) throw new Error('env_fix_exists');
    const files = this.checkEnvPaths(root, await this.patchPaths(root, file));
    let before = null;
    if (body.expectVersion !== undefined && body.expectVersion !== null) {
      before = (await this.h.projectSnapshot(root, signal)).version;
      if (before !== body.expectVersion) throw new Error('plan_workspace_changed');
    }
    if ((await this.h.git(root, ['apply', '--check', '--binary', '--whitespace=nowarn', file], signal)).code !== 0) throw new Error('env_fix_conflict');
    // The previous content of every file, so the fix can be undone (D8-style checkpoint, outside the project's .git).
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = [];
    for (const [index, { name, target }] of files.entries()) {
      const info = await fs.lstat(target).catch(() => null);
      if (info && !info.isFile()) throw new Error('env_fix_unsupported_file');
      if (info) await fs.copyFile(target, path.join(directory, String(index)));
      entries.push({ name, existed: Boolean(info), before: info ? sha(await fs.readFile(target)) : null });
    }
    if ((await this.h.git(root, ['apply', '--binary', '--whitespace=nowarn', file], signal)).code !== 0) {
      await fs.rm(directory, { recursive: true, force: true });
      throw new Error('env_fix_apply_failed');
    }
    for (const [index, entry] of entries.entries()) {
      const target = files[index].target;
      entry.after = await fs.readFile(target).then(sha, () => null);
    }
    const patch = await fs.readFile(file);
    await fs.writeFile(path.join(directory, 'fix.patch'), patch, { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ entries, at: Date.now(), sha256: sha(patch) }), { mode: 0o600 });
    const after = before !== null ? (await this.h.projectSnapshot(root, signal)).version : null;
    return { applied: true, files: entries.map((entry) => entry.name), before, after, sha256: sha(patch) };
  }

  async envFixRevert(taskId, root, body) {
    const directory = this.fixDir(taskId, body.fixId);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8').catch(() => { throw new Error('env_fix_not_found'); }));
    if (manifest.reverted) throw new Error('env_fix_already_reverted');
    const files = this.checkEnvPaths(root, manifest.entries.map((entry) => entry.name));
    for (const [index, entry] of manifest.entries.entries()) {
      const now = await fs.readFile(files[index].target).then(sha, () => null);
      if (now !== entry.after) throw new Error('env_fix_changed_since:' + entry.name);
    }
    for (const [index, entry] of manifest.entries.entries()) {
      const target = files[index].target;
      if (entry.existed) {
        const temporary = target + '.agentdesk-' + randomUUID();
        await fs.copyFile(path.join(directory, String(index)), temporary);
        await fs.rename(temporary, target);
      } else await fs.rm(target, { force: true });
    }
    manifest.reverted = Date.now();
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    const version = body.snapshot ? (await this.h.projectSnapshot(root, new AbortController().signal)).version : null;
    return { reverted: true, files: manifest.entries.map((entry) => entry.name), version };
  }

  // R1: before a step overwrites, moves or deletes a file outside the project, its content is kept here.
  async backupOutside(taskId, target) {
    const info = await fs.lstat(target).catch(() => null);
    if (!info || !info.isFile()) return null;
    if (!SAFE.test(taskId)) throw new Error('invalid_backup_id');
    const id = randomUUID();
    const directory = path.join(this.stateDir, 'outside-backups', taskId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.copyFile(target, path.join(directory, id));
    await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify({ target, before: sha(await fs.readFile(target)), at: Date.now() }), { mode: 0o600 });
    return { id };
  }

  async noteOutside(taskId, backup) {
    if (!backup) return;
    const file = path.join(this.stateDir, 'outside-backups', taskId, backup.id + '.json');
    const meta = JSON.parse(await fs.readFile(file, 'utf8'));
    meta.after = await fs.readFile(meta.target).then(sha, () => null);
    await fs.writeFile(file, JSON.stringify(meta), { mode: 0o600 });
  }

  async outsideRestore(taskId, body) {
    if (!SAFE.test(taskId) || typeof body.backupId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.backupId)) throw new Error('invalid_backup_id');
    const directory = path.join(this.stateDir, 'outside-backups', taskId);
    const meta = JSON.parse(await fs.readFile(path.join(directory, body.backupId + '.json'), 'utf8').catch(() => { throw new Error('backup_not_found'); }));
    if (!this.h.allowedPath(meta.target)) throw new Error('credential_path_denied');
    const current = await fs.readFile(meta.target).then(sha, () => null);
    if (meta.after !== undefined && current !== meta.after) throw new Error('outside_changed_since');
    const temporary = meta.target + '.agentdesk-' + randomUUID();
    await fs.copyFile(path.join(directory, body.backupId), temporary);
    await fs.rename(temporary, meta.target);
    return { restored: true, path: meta.target };
  }
}

module.exports = { GroupLocal };
