'use strict';
// 微信任务记录：一个 JSON 文件，原子写入。量很小，不需要数据库。
// 按用户隔离：每个用户自己的任务编号（#1 起）、自己的目录 users/<userid 哈希>/{tasks/<编号>,pending,ask,screens}；
// 所有读取都要带 userid，查不到别人的任务。AI 运行时的当前目录只是该用户的一个任务目录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const KEEP_RECORDS = 2000;          // 安全上限；正常按保留天数删
const ACTIVE = new Set(['queued', 'planning', 'running']);
const FINISHED = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'quota_limited', 'quota_low', 'auth_expired']);   // review 不算结束

function userKey(user) { return crypto.createHash('sha256').update(String(user)).digest('hex').slice(0, 24); }

class TaskStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'tasks.json');
    fs.mkdirSync(path.join(root, 'users'), { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 2, nextIds: {}, tasks: [], drafts: {}, prefs: {}, seen: [] };
    }
    this.data.drafts ||= {};
    this.data.seen ||= [];
    this.data.prefs ||= {};
    delete this.data.pending;
    if (this.data.version !== 2) this.migrate();
    // 服务重启时还在跑的任务已经没有进程了。
    for (const task of this.data.tasks) {
      if (task.status === 'planning' && task.plan) task.status = 'review';      // 改方案时重启：上一版方案还在
      else if (ACTIVE.has(task.status)) Object.assign(task, { status: 'failed', error: 'service_restarted', finishedAt: Date.now() });
    }
    this.save();
  }

  // v1：全局编号、tasks/<id>、pending/<hex>。改成每人编号和每人目录；旧编号对本人保持不变。
  migrate() {
    this.data.nextIds = {};
    for (const task of this.data.tasks) {
      const key = userKey(task.user);
      const from = path.join(this.root, 'tasks', String(task.id));
      const to = this.taskDir(task.user, task.id);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.renameSync(from, to); }
      this.data.nextIds[key] = Math.max(this.data.nextIds[key] || 1, task.id + 1);
    }
    for (const user of Object.keys(this.data.drafts)) this.data.drafts[user] = { ...this.data.drafts[user], files: [] };
    fs.rmSync(path.join(this.root, 'pending'), { recursive: true, force: true });
    try { fs.rmdirSync(path.join(this.root, 'tasks')); } catch {}
    delete this.data.nextId;
    this.data.version = 2;
  }

  save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  userDir(user) { return path.join(this.root, 'users', userKey(user)); }
  taskDir(user, id) { return path.join(this.userDir(user), 'tasks', String(id)); }
  pendingDir(user) { return path.join(this.userDir(user), 'pending'); }

  create(fields) {
    const key = userKey(fields.user);
    const id = this.data.nextIds[key] || 1;
    this.data.nextIds[key] = id + 1;
    const task = { id, status: 'queued', createdAt: Date.now(), turns: 1, ...fields };
    const dir = this.taskDir(fields.user, id);
    for (const sub of ['in', 'work', 'out']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    // Codex 只在 git 仓库（或受信任目录）里干活；空仓库就够了，不提交任何东西。
    try { execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' }); } catch {}
    this.data.tasks.push(task);
    if (this.data.tasks.length > KEEP_RECORDS) this.data.tasks.splice(0, this.data.tasks.length - KEEP_RECORDS);
    this.save();
    return task;
  }

  get(user, id) { return this.data.tasks.find((task) => task.user === user && task.id === id) || null; }

  update(user, id, fields) {
    const task = this.get(user, id);
    if (!task) return null;
    Object.assign(task, fields);
    this.save();
    return task;
  }

  recent(user, count = 10) {
    return this.data.tasks.filter((task) => task.user === user).slice(-count).reverse();
  }

  last(user) { return this.recent(user, 1)[0] || null; }

  // 去重：同一条消息可能重复投递（重连、重试）。保留最近 500 个键。
  seen(key) {
    if (this.data.seen.includes(key)) return true;
    this.data.seen.push(key);
    if (this.data.seen.length > 500) this.data.seen.splice(0, this.data.seen.length - 500);
    this.save();
    return false;
  }

  // 用户偏好（管理员选的模型、电脑）。
  pref(user) { return this.data.prefs[user] || {}; }
  setPref(user, change) { this.data.prefs[user] = { ...this.pref(user), ...change }; this.save(); return this.data.prefs[user]; }

  // 草稿：发「开始」前攒下的文字和文件，以及选的档位和要接着改的任务。
  //   { texts: [], files: [绝对路径], tier, target: 任务编号|null, at }
  draft(user) { return this.data.drafts[user] || { texts: [], files: [], tier: null, target: null, at: 0 }; }
  updateDraft(user, change, now = Date.now()) {
    const draft = { ...this.draft(user), ...change, at: now };
    this.data.drafts[user] = draft;
    this.save();
    return draft;
  }
  clearDraft(user, { removeFiles = false } = {}) {
    const draft = this.draft(user);
    if (removeFiles) for (const file of draft.files) fs.rmSync(file, { force: true });
    delete this.data.drafts[user];
    this.save();
  }

  // 删除过期的任务目录、记录和草稿。返回删了几个目录。
  gc({ keepSucceededMs, keepFailedMs, keepPendingMs, keepRecordsMs }, now = Date.now()) {
    let removed = 0;
    for (const task of this.data.tasks) {
      if (task.archived || !FINISHED.has(task.status) || !task.finishedAt) continue;
      const keep = task.status === 'succeeded' ? keepSucceededMs : keepFailedMs;
      if (now - task.finishedAt < keep) continue;
      fs.rmSync(this.taskDir(task.user, task.id), { recursive: true, force: true });
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

module.exports = { TaskStore, ACTIVE, FINISHED, userKey };
