// A single chat can work in its own Git worktree, so two conversations on the same project never overwrite each
// other's files (the same idea as Lancer's per-session worktrees and the Codex app's parallel agents).
//
// The worktree is a linked checkout of the project on a new branch "agentdesk/<session>", created from the
// project's current HEAD. It sits next to the project, in "<parent>/.agentdesk-worktrees/<project>/<session>",
// because AgentDesk's file tools refuse to write inside .git. The chat's file tools and its prompt point at the
// worktree; the project folder itself is untouched until the person merges.
//
// - diff: what the conversation changed relative to where it started, including untracked files.
// - merge: commits the worktree's changes on its branch, then merges that branch into the branch the project
//   was on when the worktree was made. The project checkout must be clean and still on that branch; a conflict
//   aborts the merge and leaves the project as it was.
// - discard: removes the worktree and its branch.
//
// The main process keeps its own record of every worktree it made (worktrees.json in the app's data folder);
// merge and discard act only on those records, never on a path the page sends.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ID = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_DIFF = 1024 * 1024;

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    // GIT_DIR and friends from the parent environment must not redirect these commands to another repository.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$/.test(key)) delete env[key];
    execFile('git', ['-C', cwd, ...args], { env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
      if (error && !allowFail) return reject(new Error((stderr || error.message).trim().split('\n').slice(-3).join(' ')));
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

class SessionWorktrees {
  constructor(registryFile) {
    this.file = registryFile;
    this.records = {};
    try { this.records = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { /* none yet */ }
    this.busy = new Set();   // a merge, discard or diff on one worktree at a time
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), { mode: 0o600 });
  }

  get(sessionId) { return this.records[sessionId] || null; }

  // A conversation reopened after a restart is known by its thread, not by the session that made the worktree.
  bindThread(sessionId, threadId) {
    const record = this.records[sessionId];
    if (!record || typeof threadId !== 'string') return;
    record.threadId = threadId;
    this.save();
  }

  forThread(threadId) {
    const entry = Object.entries(this.records).find(([, record]) => record.threadId === threadId);
    return entry ? { key: entry[0], ...entry[1] } : null;
  }

  async exclusive(sessionId, work) {
    if (this.busy.has(sessionId)) throw new Error('这个工作树正在处理另一个操作，请稍后再试');
    this.busy.add(sessionId);
    try { return await work(); } finally { this.busy.delete(sessionId); }
  }

  async create(projectId, projectRoot, sessionId) {
    if (!ID.test(sessionId)) throw new Error('invalid_session');
    if (this.records[sessionId]) return this.records[sessionId];
    const repo = (await git(projectRoot, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!repo) throw new Error('项目目录不是 Git 仓库，不能使用独立工作树');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const baseBranch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
    if (!baseBranch) throw new Error('项目当前不在任何分支上（detached HEAD），请先切换到分支');
    const branch = 'agentdesk/' + sessionId;
    const folder = path.join(path.dirname(repo), '.agentdesk-worktrees', path.basename(repo), sessionId);
    fs.mkdirSync(path.dirname(folder), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, folder, base]);
    this.records[sessionId] = { projectId, repo, path: folder, branch, base, baseBranch, createdAt: Date.now() };
    this.save();
    return this.records[sessionId];
  }

  async diff(sessionId) {
    const record = this.get(sessionId);
    if (!record) throw new Error('这个会话没有独立工作树');
    return this.exclusive(sessionId, async () => {
      // Untracked files show up in the diff once they are marked as intended to add (nothing is committed).
      await git(record.path, ['add', '-A', '-N']);
      const { stdout } = await git(record.path, ['diff', '--stat', '--patch', record.base]);
      const files = (await git(record.path, ['diff', '--name-only', record.base])).stdout.split('\n').filter(Boolean);
      return { files, text: stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) + '\n…（差异超过 1 MiB，已截断）' : stdout };
    });
  }

  async merge(sessionId) {
    const record = this.get(sessionId);
    if (!record) throw new Error('这个会话没有独立工作树');
    return this.exclusive(sessionId, async () => {
      const dirty = (await git(record.repo, ['status', '--porcelain'])).stdout.trim();
      if (dirty) throw new Error('项目目录有未提交的改动，请先提交或暂存后再合回');
      const current = (await git(record.repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
      if (current !== record.baseBranch) throw new Error(`项目目录现在在分支 ${current || '（无）'}，请先切回 ${record.baseBranch} 再合回`);
      const identity = (await git(record.repo, ['config', 'user.email'], { allowFail: true })).stdout.trim()
        ? [] : ['-c', 'user.name=AgentDesk', '-c', 'user.email=agentdesk@localhost'];
      await git(record.path, ['add', '-A']);
      const staged = (await git(record.path, ['diff', '--cached', '--quiet'], { allowFail: true })).ok === false;
      if (staged) await git(record.path, [...identity, 'commit', '-q', '-m', `AgentDesk 单聊改动（${sessionId}）`]);
      const ahead = Number((await git(record.repo, ['rev-list', '--count', `${record.baseBranch}..${record.branch}`])).stdout.trim());
      if (!ahead) return { merged: false, files: [] };
      const files = (await git(record.repo, ['diff', '--name-only', `${record.baseBranch}...${record.branch}`])).stdout.split('\n').filter(Boolean);
      const merged = await git(record.repo, [...identity, 'merge', '--no-ff', '-m', `合并 AgentDesk 单聊（${sessionId}）`, record.branch], { allowFail: true });
      if (!merged.ok) {
        await git(record.repo, ['merge', '--abort'], { allowFail: true });
        throw new Error('合并有冲突，已撤回合并，项目保持原样。可以在工作树里解决后再合回：' + record.path);
      }
      record.mergedAt = Date.now();
      // The next changes continue from the merged state, so a second merge brings only the new work.
      record.base = (await git(record.path, ['rev-parse', 'HEAD'])).stdout.trim();
      this.save();
      return { merged: true, files };
    });
  }

  async discard(sessionId) {
    const record = this.get(sessionId);
    if (!record) return { removed: false };
    return this.exclusive(sessionId, async () => {
      await git(record.repo, ['worktree', 'remove', '--force', record.path], { allowFail: true });
      await git(record.repo, ['worktree', 'prune'], { allowFail: true });
      await git(record.repo, ['branch', '-D', record.branch], { allowFail: true });
      delete this.records[sessionId];
      this.save();
      return { removed: true };
    });
  }
}

module.exports = { SessionWorktrees };
