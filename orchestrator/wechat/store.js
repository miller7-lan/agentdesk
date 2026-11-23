'use strict';
// 微信任务记录：一个 JSON 文件，原子写入。量很小（个人使用），不需要数据库。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KEEP_RECORDS = 2000;          // 安全上限；正常按保留天数删
const ACTIVE = new Set(['queued', 'planning', 'running']);
const FINISHED = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'quota_limited', 'quota_low', 'auth_expired']);   // review 不算结束

class TaskStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'tasks.json');
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'pending'), { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { nextId: 1, tasks: [], drafts: {}, seen: [] };
    }
    this.data.drafts ||= {};
    delete this.data.pending;
    this.data.seen ||= [];
    // 服务重启时还在跑的任务已经没有进程了。
    for (const task of this.data.tasks) {
      if (task.status === 'planning' && task.plan) task.status = 'review';      // 改方案时重启：上一版方案还在
      else if (ACTIVE.has(task.status)) Object.assign(task, { status: 'failed', error: 'service_restarted', finishedAt: Date.now() });
    }
    this.save();
  }

  save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  taskDir(id) { return path.join(this.root, 'tasks', String(id)); }
  pendingDir(user) { return path.join(this.root, 'pending', Buffer.from(user).toString('hex').slice(0, 64)); }

  create(fields) {
    const id = this.data.nextId++;
    const task = { id, status: 'queued', createdAt: Date.now(), turns: 1, ...fields };
    const dir = this.taskDir(id);
    for (const sub of ['in', 'work', 'out']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    // Codex 只在 git 仓库（或受信任目录）里干活；空仓库就够了，不提交任何东西。
    try { execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' }); } catch {}
    this.data.tasks.push(task);
    if (this.data.tasks.length > KEEP_RECORDS) this.data.tasks.splice(0, this.data.tasks.length - KEEP_RECORDS);
    this.save();
    return task;
  }

  get(id) { return this.data.tasks.find((task) => task.id === id) || null; }

  update(id, fields) {
    const task = this.get(id);
    if (!task) return null;
    Object.assign(task, fields);
    this.save();
    return task;
  }

  recent(user, count = 10) {
    return this.data.tasks.filter((task) => task.user === user).slice(-count).reverse();
  }

  last(user) { return this.recent(user, 1)[0] || null; }

  // 去重：企业微信超时会重试同一条消息。保留最近 500 个键。
  seen(key) {
    if (this.data.seen.includes(key)) return true;
    this.data.seen.push(key);
    if (this.data.seen.length > 500) this.data.seen.splice(0, this.data.seen.length - 500);
    this.save();
    return false;
  }

  // 草稿：发「开始」前攒下的文字和文件，以及选的档位和要进入的老任务。
  //   { texts: [], files: [绝对路径], tier, target: 任务编号|null, at }
  draft(user) { return this.data.drafts[user] || { texts: [], files: [], tier: null, target: null, at: 0 }; }
  updateDraft(user, change, now = Date.now()) {
    const draft = { ...this.draft(user), ...change, at: now };
    this.data.drafts[user] = draft;
    this.save();
    return draft;
  }
  // 清掉草稿内容；target 默认也清（开始执行或放弃时）。keepTarget 用于 /清空 只丢内容。
  clearDraft(user, { keepTarget = false, removeFiles = false } = {}) {
    const draft = this.draft(user);
    if (removeFiles) for (const file of draft.files) fs.rmSync(file, { force: true });
    if (keepTarget && draft.target) this.data.drafts[user] = { texts: [], files: [], tier: null, target: draft.target, at: draft.at };
    else delete this.data.drafts[user];
    this.save();
  }

  // 删除过期的任务目录、记录和草稿。返回删了几个目录。
  gc({ keepSucceededMs, keepFailedMs, keepPendingMs, keepRecordsMs }, now = Date.now()) {
    let removed = 0;
    for (const task of this.data.tasks) {
      if (task.archived || !FINISHED.has(task.status) || !task.finishedAt) continue;
      const keep = task.status === 'succeeded' ? keepSucceededMs : keepFailedMs;
      if (now - task.finishedAt < keep) continue;
      fs.rmSync(this.taskDir(task.id), { recursive: true, force: true });
      task.archived = true;
      removed += 1;
    }
    for (const [user, draft] of Object.entries(this.data.drafts)) {
      if (now - draft.at < keepPendingMs) continue;
      fs.rmSync(this.pendingDir(user), { recursive: true, force: true });
      delete this.data.drafts[user];
    }
    if (keepRecordsMs) {
      this.data.tasks = this.data.tasks.filter((task) => !task.archived || now - (task.finishedAt || task.createdAt) < keepRecordsMs);
    }
    this.save();
    return removed;
  }
}

module.exports = { TaskStore, ACTIVE, FINISHED };
