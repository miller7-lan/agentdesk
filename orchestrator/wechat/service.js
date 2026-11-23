'use strict';
// 微信办公助手服务：个人微信 ClawBot（iLink 长轮询，默认）或企业微信智能机器人长连接 → 路由 → 排队执行 → 回文件和说明。
// 用法：node service.js [wechat.json] [orchestrator config.json]；通道见 createChannel。
// 与主控是两个独立进程：共用 CLI 登录目录（stateDir/homes/<cli>），不走主控的调度器。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const router = require('./router');
const runner = require('./runner');
const { TaskStore } = require('./store');
const { QuotaGate, describeBlocked } = require('./quota');
const { deliverFiles, validateFile } = require('./deliver');

const STATUS_ICON = { queued: '⏳', planning: '🧭', running: '▶️', succeeded: '✅', failed: '❌', timeout: '⌛', cancelled: '⏹', quota_limited: '🪫', quota_low: '🪫', auth_expired: '🔑' };
const STATUS_TEXT = { queued: '排队中', planning: '组长规划中', running: '执行中', succeeded: '完成', failed: '失败', timeout: '超时', cancelled: '已停止', quota_limited: '额度用尽', quota_low: '额度不够', auth_expired: 'AI 需要重新登录' };
const DAY = 24 * 3600 * 1000;
const DEFAULT_LIMITS = { messagesPerMinute: 30, activeTasksPerUser: 2, tasksPerDay: 20, asksPerHour: 30 };
const DEFAULT_ASK = { provider: 'antigravity', model: 'gemini-3.8-flash-medium', fallback: { provider: 'grok', model: 'grok-4.7' }, timeoutMs: 3 * 60 * 1000 };

function log(...parts) { console.log(new Date().toISOString(), ...parts); }

function duration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60 ? (seconds % 60) + '秒' : ''}`;
}

function executorLabel(executor) {
  if (!executor) return '';
  const name = runner.NAMES[executor.provider] || executor.provider;
  return executor.provider === 'claude' && /opus/.test(executor.model || '') ? 'Claude Opus' : name;
}

function short(text, size = 18) {
  const chars = [...String(text || '').replace(/\s+/g, ' ')];
  return chars.length > size ? chars.slice(0, size).join('') + '…' : chars.join('');
}

// 微信里不渲染 Markdown：链接只留文字，绝对路径只留文件名，去掉加粗和行内代码记号。
function plainSummary(text) {
  return String(text || '')
    // Antigravity 会把过程中的“正在……请稍候”也拼进最终输出，去掉这些行。
    .split('\n').filter((line) => !/^\s*正在.{0,60}(请稍候|稍等|请等待)[。.…！!]*\s*$/.test(line)).join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:file:\/\/)?\/(?:[^\s/「」（）()]+\/)+([^\s/「」（）()]+)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function friendlyError(task) {
  if (task.status === 'quota_low') return `额度不够，稍后再试（发 /重试 ${task.id}）。${task.blocked ? describeBlocked(task.blocked) + '。' : ''}`;
  if (task.status === 'timeout') return '超时了，可以把需求拆小一点再试。';
  if (task.status === 'quota_limited') return `${executorLabel(task.executor)} 额度用完了，稍后发 /重试 ${task.id}，或换个档位重新提交。`;
  if (task.status === 'auth_expired') return `${executorLabel(task.executor)} 登录失效，需要管理员在服务器上重新登录。`;
  if (task.error === 'service_restarted') return `服务重启，任务中断了，发 /重试 ${task.id} 重做。`;
  return '执行出错了' + (task.error ? `（${short(task.error, 80)}）` : '') + `。可发 /重试 ${task.id}。`;
}

// userid 在日志里只记哈希前 8 位，不记明文。
function userTag(userid) { return crypto.createHash('sha256').update(String(userid)).digest('hex').slice(0, 8); }

class WechatService {
  constructor({ config, adapters, channel, runTask = runner.runTask, runAdapter, quota = null, validate = validateFile, now = Date.now }) {
    this.config = config;
    this.adapters = adapters;
    this.channel = channel;
    this.runTask = runTask;
    this.runAdapter = runAdapter;
    this.quota = quota;
    this.validate = validate;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
    this.store = new TaskStore(path.join(config.stateDir, 'wechat'));
    this.allowUsers = new Set(config.allowUsers || []);
    this.queue = [];
    this.running = null;
    this.asking = new Set();
    this.messageTimes = new Map();
    this.askTimes = new Map();
  }

  send(user, text) {
    return this.channel.sendText(user, text).catch((error) => log('send failed', userTag(user), error?.message || error));
  }

  respond(message, text) {
    return this.channel.reply(message, text, message.from).catch((error) => log('reply failed', userTag(message.from), error?.message || error));
  }

  // 滑动窗口计数：超过上限返回 false。
  allow(map, user, limit, windowMs) {
    const now = this.now();
    const times = (map.get(user) || []).filter((at) => now - at < windowMs);
    if (times.length >= limit) { map.set(user, times); return false; }
    times.push(now);
    map.set(user, times);
    return true;
  }

  async onMessage(message) {
    if (this.store.seen(message.dedupeKey)) return log('duplicate ignored');
    const user = message.from;
    log('message', message.type, message.event || '', message.chatType, 'user', user ? userTag(user) : '-');
    const action = router.route(message, { allowUsers: this.allowUsers });
    if (action.kind === 'deny') {
      // 管理员把这个 userid 加进 allowUsers 才能用；日志里打印明文，便于登记。
      log('denied user (add to allowUsers to enable):', user);
      return this.respond(message, '这个助手目前只对已登记的成员开放，请联系管理员。');
    }
    if (user && !['ignore', 'kicked', 'welcome'].includes(action.kind)
        && !this.allow(this.messageTimes, user, this.limits.messagesPerMinute, 60_000)) {
      return log('rate limited', userTag(user));
    }
    switch (action.kind) {
      case 'ignore': return undefined;
      case 'kicked': return log('WARNING: 另一个连接用同一个 Bot ID 登录，本连接被踢下线（同一机器人只能有一条长连接）');
      case 'welcome': return this.channel.welcome(message, this.allowUsers.has(user) ? router.HELP : '你好！这个助手目前只对已登记的成员开放。').catch(() => {});
      case 'greet': return this.respond(message, `你好！我是办公助手，可以帮你处理 Word、Excel、PPT。\n\n${router.HELP}`);
      case 'help': return this.respond(message, router.HELP);
      case 'reply': return this.respond(message, action.text);
      case 'file': return this.receiveFile(message, action.text);
      case 'append': return this.append(message, action.text);
      case 'tier': return this.setTier(message, action);
      case 'start': return this.start(message, action.tier);
      case 'enter': return this.respond(message, this.enter(user, action.id));
      case 'fresh': return this.respond(message, this.leave(user));
      case 'clear':
        this.store.clearDraft(user, { keepTarget: true, removeFiles: true });
        return this.respond(message, '草稿已清空。');
      case 'list': return this.respond(message, this.listText(user));
      case 'show': return this.respond(message, this.showText(user, action.id));
      case 'stop': return this.respond(message, this.stop(user, action.id));
      case 'retry': return this.retry(message, action.id);
      case 'resend': return this.resend(message, action.id);
      case 'ask': return this.ask(message, action.text);
      default: return undefined;
    }
  }

  draftEmpty(draft) { return !draft.texts.length && !draft.files.length; }

  // 草稿的第一条内容回一句提示；之后的文字不逐条回复，免得刷屏。
  hint(draft) {
    const into = draft.target ? `（接着改 #${draft.target}）` : '';
    const tier = draft.tier ? `已选${router.TIER_LABEL[draft.tier]}。` : '档位可选 /低 /中 /高，不选由组长判断。';
    return `已记下${into}。可以继续发文字或文件，发「开始」执行。${tier}`;
  }

  append(message, text) {
    const user = message.from;
    const before = this.store.draft(user);
    const draft = this.store.updateDraft(user, { texts: [...before.texts, text] }, this.now());
    if (this.draftEmpty(before)) return this.respond(message, this.hint(draft));
    return undefined;
  }

  setTier(message, action) {
    const user = message.from;
    const before = this.store.draft(user);
    const draft = this.store.updateDraft(user, { tier: action.tier, texts: action.text ? [...before.texts, action.text] : before.texts }, this.now());
    const label = router.TIER_LABEL[action.tier];
    if (draft.target) return this.respond(message, `已选${label}。注意：接着改老任务时沿用原来的执行者，档位不变；要换档请 /新。`);
    return this.respond(message, this.draftEmpty(draft) ? `已选${label}。发需求后再发「开始」。` : `已选${label}。发「开始」执行。`);
  }

  async receiveFile(message, caption) {
    const user = message.from;
    try {
      const saved = await this.channel.download(message, this.store.pendingDir(user));
      const before = this.store.draft(user);
      const texts = caption ? [...before.texts, caption] : before.texts;
      const draft = this.store.updateDraft(user, { files: [...before.files, saved], texts }, this.now());
      log('file received', userTag(user), path.extname(saved), fs.statSync(saved).size);
      const counts = `草稿里有 ${draft.files.length} 个文件${draft.texts.length ? `、${draft.texts.length} 段文字` : ''}`;
      await this.respond(message, `已收到「${path.basename(saved)}」（${counts}）。${draft.texts.length ? '发「开始」执行。' : '说说要做什么，再发「开始」。'}`);
    } catch (error) {
      log('download failed', userTag(user), error?.message || error);
      await this.respond(message, '文件没收下来（下载链接 5 分钟内有效，可能已过期），请重发。');
    }
  }

  // 把草稿里的文件移进任务的 in/，返回新文件名列表。
  moveFiles(files, dir) {
    const names = [];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const ext = path.extname(file);
      let name = path.basename(file);
      for (let n = 2; fs.existsSync(path.join(dir, 'in', name)); n += 1) name = `${path.basename(file, ext)} (${n})${ext}`;
      fs.renameSync(file, path.join(dir, 'in', name));
      names.push(name);
    }
    return names;
  }

  // 每人同时最多 activeTasksPerUser 个排队或执行中的任务，24 小时内最多 tasksPerDay 个。
  taskLimitReason(user) {
    const active = this.queue.filter((job) => job.user === user).length + (this.running?.job.user === user ? 1 : 0);
    if (active >= this.limits.activeTasksPerUser) return `你已经有 ${active} 个任务在排队或执行，等它们完成再提交。`;
    const today = this.store.data.tasks.filter((task) => task.user === user && this.now() - task.createdAt < DAY).length;
    if (today >= this.limits.tasksPerDay) return `24 小时内已提交 ${today} 个任务，达到上限，明天再来。`;
    return null;
  }

  start(message, tierOverride) {
    const user = message.from;
    const draft = this.store.draft(user);
    if (!draft.texts.length) {
      return this.respond(message, draft.files.length ? '还没说要做什么。发需求文字后再发「开始」。' : '草稿是空的。先发需求和文件，再发「开始」。\n\n' + router.HELP);
    }
    const limited = this.taskLimitReason(user);
    if (limited) return this.respond(message, limited);
    const text = router.composeDraft(draft.texts);
    const target = draft.target && this.store.get(draft.target);
    this.store.clearDraft(user);
    // 进入的老任务有执行者：接着改；否则（规划阶段就失败、已清理）当新任务。
    if (target && target.user === user && target.executor && !target.archived) {
      const newInputs = this.moveFiles(draft.files, this.store.taskDir(target.id));
      this.store.update(target.id, { status: 'queued', turns: (target.turns || 1) + 1, finishedAt: null, error: null, blocked: null, lastText: text });
      return this.enqueue({ id: target.id, user, continuation: { text, newInputs } }, message);
    }
    const tier = tierOverride || draft.tier;
    const task = this.store.create({ user, text, tier, tierSource: tier ? 'user' : 'auto' });
    this.moveFiles(draft.files, this.store.taskDir(task.id));
    return this.enqueue({ id: task.id, user }, message);
  }

  enter(user, id) {
    const task = this.store.get(id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。发 /ls 看最近的任务。`;
    if (task.archived) return `#${id} 的文件已过保留期清理，不能接着改了。`;
    if (!task.executor) return `#${id} 当时没开始执行（${STATUS_TEXT[task.status]}），发 /重试 ${id} 重做。`;
    if (this.isActive(id)) return `#${id} 还在执行，等它完成再接着改。`;
    this.store.updateDraft(user, { target: id }, this.now());
    const lines = [`已进入 #${id}（${router.TIER_LABEL[task.tier] || ''} · ${executorLabel(task.executor)}）：${short(task.text, 40)}`];
    if (task.outputs?.length) lines.push(`成品：${task.outputs.join('、')}`);
    lines.push('发修改要求（可带新文件），再发「开始」。/新 退出这个任务。');
    return lines.join('\n');
  }

  leave(user) {
    const draft = this.store.draft(user);
    if (!draft.target) return '现在就是新任务。发需求和文件，再发「开始」。';
    this.store.updateDraft(user, { target: null }, this.now());
    return `已退出 #${draft.target}。之后发的内容是新任务${this.draftEmpty(draft) ? '' : '（草稿内容保留）'}。`;
  }

  isActive(id) { return this.running?.job.id === id || this.queue.some((job) => job.id === id); }

  retry(message, id) {
    const user = message.from;
    const task = this.store.get(id);
    if (!task || task.user !== user) return this.respond(message, `没有 #${id} 这个任务。`);
    if (task.archived) return this.respond(message, `#${id} 的文件已过保留期清理，不能重试。`);
    if (task.status === 'succeeded') return this.respond(message, `#${id} 已经完成了。要修改请发 /进 ${id}；没收到文件请发 /重发 ${id}。`);
    if (this.isActive(id)) return this.respond(message, `#${id} 还在执行。`);
    const limited = this.taskLimitReason(user);
    if (limited) return this.respond(message, limited);
    this.store.update(id, { status: 'queued', finishedAt: null, error: null, blocked: null, sessions: {}, executor: null, tier: task.tierSource === 'user' ? task.tier : null });
    return this.enqueue({ id, user }, message);
  }

  // 把任务 out/ 里的成品再发一次（只发给任务所有者）。
  async resend(message, id) {
    const user = message.from;
    const task = this.store.get(id);
    if (!task || task.user !== user) return this.respond(message, `没有 #${id} 这个任务。`);
    if (task.archived) return this.respond(message, `#${id} 的文件已过保留期清理。`);
    const outDir = path.join(this.store.taskDir(id), 'out');
    const files = runner.listFiles(outDir).map((name) => path.join(outDir, name));
    if (!files.length) return this.respond(message, `#${id} 没有成品文件。`);
    await this.respond(message, `正在重发 #${id} 的 ${files.length} 个文件…`);
    const results = await this.sendFiles(task.user, files);
    this.store.update(id, { deliveries: mergeDeliveries(task.deliveries, results) });
    return this.send(user, deliverySummary(results) || `#${id} 的文件已重发。`);
  }

  // 快问快答：一个便宜的模型只读回答，不进草稿、不建任务。
  async ask(message, question) {
    const user = message.from;
    if (!this.allow(this.askTimes, user, this.limits.asksPerHour, 3600_000)) return this.respond(message, '提问太频繁了，稍后再试。');
    if (this.asking.has(user)) return this.respond(message, '上一个问题还在回答，稍等。');
    const settings = { ...DEFAULT_ASK, ...(this.config.ask || {}) };
    let choices = [settings, settings.fallback].filter((choice) => choice && this.adapters[choice.provider]);
    try {
      if (this.quota) choices = await this.quota.rank(choices);
    } catch (error) {
      return this.respond(message, `额度不够，稍后再试。${error.blocked ? describeBlocked(error.blocked) + '。' : ''}`);
    }
    if (!choices.length) return this.respond(message, '没有可用的 AI。');
    this.asking.add(user);
    const dir = path.join(this.store.root, 'ask', userTag(user));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    try {
      let answer = '';
      for (const choice of choices) {
        try {
          const result = await this.runAdapter({
            name: choice.provider, config: this.adapters[choice.provider], cwd: dir, readonly: true,
            prompt: `用简洁的中文回答用户在微信里的问题（不超过 500 字，不用 Markdown 标题和表格）。不要读写文件，不要运行命令。\n\n问题：${question}`,
            timeout: settings.timeoutMs, printTimeoutMs: Math.max(60_000, settings.timeoutMs - 30_000), signal: controller.signal,
            log: path.join(dir, 'last.log'), onSession: () => {}, model: choice.model,
          });
          answer = plainSummary(result.output);
          if (answer) break;
        } catch (error) {
          log('ask failed', choice.provider, String(error?.code || error?.message || error).slice(0, 80));
          if (String(error?.code || '').startsWith('cli_quota')) this.quota?.invalidate();
        }
      }
      return this.respond(message, answer || '这个问题暂时没回答出来，稍后再试，或把它作为任务提交（发需求后「开始」）。');
    } finally {
      this.asking.delete(user);
      fs.rmSync(path.join(dir, 'last.log'), { force: true });
    }
  }

  enqueue(job, message) {
    const task = this.store.get(job.id);
    const ahead = this.queue.length + (this.running ? 1 : 0);
    const what = job.continuation ? `接着改 #${task.id}` : `收到 #${task.id}`;
    const route = job.continuation ? ` · ${executorLabel(task.executor)}`
      : task.tier === 'high' ? ' · 高档 → Claude Opus' : task.tier ? ` · ${router.TIER_LABEL[task.tier]}，组长先规划` : '，组长规划中';
    const text = ahead ? `${what}，前面还有 ${ahead} 个任务，排队中。完成后会主动通知你。` : `${what}${route}… 完成后会主动通知你。`;
    if (message) this.respond(message, text); else this.send(job.user, text);
    this.queue.push(job);
    this.pump();
  }

  pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    const controller = new AbortController();
    this.running = { job, controller };
    this.execute(job, controller.signal)
      .catch((error) => log('execute crashed', error?.stack || error))
      .finally(() => { this.running = null; this.pump(); });
  }

  async execute(job, signal) {
    const task = this.store.get(job.id);
    const dir = this.store.taskDir(task.id);
    const startedAt = this.now();
    this.store.update(task.id, { status: job.continuation || task.tier === 'high' ? 'running' : 'planning', startedAt });
    let announced = Boolean(job.continuation) || task.tier === 'high';
    const result = await this.runTask({
      task, dir, signal, continuation: job.continuation,
      deps: {
        adapters: this.adapters, runAdapter: this.runAdapter, settings: this.config.tiers, quota: this.quota,
        onStage: (stage, info) => {
          this.store.update(task.id, { status: stage, ...(info.executor && { executor: info.executor }), ...(info.tier && { tier: info.tier }) });
          if (stage === 'running' && info.executor && (!announced || info.switched)) {
            announced = true;
            this.send(job.user, info.switched ? `#${task.id} ${executorLabel(info.executor)} 接手继续做…`
              : `#${task.id} ${info.auto ? '组长判断为' : ''}${router.TIER_LABEL[info.tier]} → ${executorLabel(info.executor)} 开始做…`);
          }
        },
      },
    });
    const finishedAt = this.now();
    const outputs = result.outputs.map((file) => path.basename(file));
    this.store.update(task.id, {
      status: result.status, tier: result.tier, executor: result.executor, sessions: result.sessions, brief: result.brief,
      finishedAt, error: result.error || null, blocked: result.blocked || null,
      outputs: [...new Set([...(task.outputs || []), ...outputs])], summary: short(result.summary, 300),
    });
    log('task', task.id, result.status, result.executor?.provider || '', duration(finishedAt - startedAt), `outputs=${outputs.length}`);
    await this.deliver(this.store.get(task.id), result, finishedAt - startedAt);
  }

  sendFiles(user, files) {
    return deliverFiles({
      files, validate: this.validate, log: (...parts) => log('deliver', ...parts), now: this.now,
      send: (file) => this.channel.sendFile(user, file), retry: this.config.deliveryRetry,
    });
  }

  async deliver(task, result, elapsed) {
    // 文件只发给任务所有者（task.user），主动推送到他的单聊。
    const results = await this.sendFiles(task.user, result.outputs);
    this.store.update(task.id, { deliveries: mergeDeliveries(task.deliveries, results) });
    for (const item of results) log('delivery', task.id, path.extname(item.name), item.status, `attempts=${item.attempts}`);
    if (result.status === 'succeeded' && this.config.sendPreview !== false) {
      const deck = result.outputs.find((file) => /\.pptx$/i.test(file) && results.find((r) => r.name === path.basename(file))?.status === 'sent');
      if (deck) await this.sendPreview(task.user, deck, task.id).catch((error) => log('preview failed', error?.message || error));
    }
    const meta = [router.TIER_LABEL[task.tier], executorLabel(task.executor), duration(elapsed)].filter(Boolean).join(' · ');
    const lines = [`${STATUS_ICON[task.status]} #${task.id} ${STATUS_TEXT[task.status]}（${meta}）`];
    if (result.note) lines.push(result.note);
    if (task.status === 'succeeded') {
      if (result.summary) lines.push(plainSummary(result.summary));
      if (!result.outputs.length) lines.push('（这次没有生成文件）');
    } else {
      lines.push(friendlyError(task));
      if (results.some((item) => item.status === 'sent')) lines.push('已生成的部分文件也发给你了。');
    }
    const problems = deliverySummary(results, task.id);
    if (problems) lines.push(problems);
    if (task.status === 'succeeded') lines.push(`接下来发的内容是新任务；要接着改这个，发 /进 ${task.id}。`);
    await this.send(task.user, lines.join('\n'));
  }

  sendPreview(user, file, id) {
    const out = path.join(this.store.taskDir(id), 'work', 'preview');
    const env = { ...process.env, PATH: `/opt/agentdesk-office/bin:/opt/agentdesk-office/venv/bin:${process.env.PATH}`, HOME: path.join(this.store.taskDir(id), 'work') };
    return new Promise((resolve, reject) => {
      execFile('office-preview', [file, '1', out], { env, timeout: 120_000 }, (error, stdout) => {
        if (error) return reject(error);
        const image = stdout.trim().split('\n').pop();
        this.channel.sendImage(user, image).then(resolve, reject);
      });
    });
  }

  stop(user, id) {
    const task = this.store.get(id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。`;
    if (this.running?.job.id === id) {
      this.running.controller.abort(new Error('cancelled'));
      return `正在停止 #${id}…`;
    }
    const index = this.queue.findIndex((job) => job.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.store.update(id, { status: 'cancelled', finishedAt: this.now() });
      return `#${id} 已从队列移除。`;
    }
    return `#${id} 已经结束（${STATUS_TEXT[task.status]}）。`;
  }

  listText(user) {
    const tasks = this.store.recent(user, 10);
    if (!tasks.length) return '还没有任务。\n\n' + router.HELP;
    return tasks.map((task) => {
      const took = task.finishedAt && task.startedAt ? ' ' + duration(task.finishedAt - task.startedAt) : '';
      const who = task.executor ? `${router.TIER_LABEL[task.tier] || ''}·${executorLabel(task.executor)}` : (task.tier ? router.TIER_LABEL[task.tier] : '');
      return `#${task.id} ${STATUS_ICON[task.status] || ''} ${who}${took} ${short(task.text)}${task.archived ? '（已清理）' : ''}`;
    }).join('\n') + '\n\n发 /进 编号 接着改某个任务，/s 编号 看详情。';
  }

  showText(user, id) {
    const task = this.store.get(id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。`;
    const lines = [
      `#${task.id} ${STATUS_ICON[task.status]} ${STATUS_TEXT[task.status]}`,
      `需求：${short(task.text, 200)}`,
      `档位：${router.TIER_LABEL[task.tier] || '未定'}${task.tierSource === 'auto' ? '（组长判断）' : ''}　执行：${executorLabel(task.executor) || '-'}`,
      `轮次：${task.turns || 1}　开始：${task.startedAt ? new Date(task.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-'}`,
    ];
    if (task.outputs?.length) lines.push(`成品：${task.outputs.join('、')}`);
    const failed = (task.deliveries || []).filter((item) => item.status !== 'sent');
    if (failed.length) lines.push(`没发出去：${failed.map((item) => item.name).join('、')}（发 /重发 ${task.id}）`);
    if (task.summary) lines.push(`说明：${plainSummary(task.summary)}`);
    if (task.error && task.status !== 'succeeded') lines.push(friendlyError(task));
    if (task.archived) lines.push('（文件已按保留期清理）');
    return lines.join('\n');
  }

  gc() {
    // 任务文件和记录都保留 30 天；草稿 3 天没开始就丢掉。
    const keep = this.config.retention || {};
    const days = keep.days ?? 30;
    const removed = this.store.gc({
      keepSucceededMs: days * DAY, keepFailedMs: days * DAY, keepPendingMs: (keep.draftDays ?? 3) * DAY, keepRecordsMs: days * DAY,
    }, this.now());
    if (removed) log('gc removed', removed, 'task folders');
  }
}

function mergeDeliveries(previous = [], results = []) {
  const byName = new Map((previous || []).map((item) => [item.name, item]));
  for (const item of results) byName.set(item.name, item);
  return [...byName.values()];
}

function deliverySummary(results, id = '编号') {
  const failed = results.filter((item) => item.status !== 'sent');
  if (!failed.length) return '';
  return '这些文件没发出去：' + failed.map((item) => `${item.name}（${item.reason || '发送失败'}）`).join('、') +
    (failed.some((item) => item.status === 'failed') ? `。稍后发 /重发 ${id} 再试。` : '。');
}

function loadAdapters(orchestratorConfig) {
  const { providerSettings } = require('../service');
  const stateDir = orchestratorConfig.stateDir;
  const adapters = {};
  for (const name of ['claude', 'codex', 'antigravity', 'grok']) {
    const settings = orchestratorConfig.adapters[name];
    if (settings) adapters[name] = providerSettings({ ...settings, allowWrites: true }, name, path.join(stateDir, 'homes', name));
  }
  return adapters;
}

// 通道：wechat.json 的 channel = "ilink"（个人微信 ClawBot，默认）或 "wecom"（企业微信智能机器人）。
function createChannel(config, onMessage) {
  if ((config.channel || 'ilink') === 'wecom') {
    const botId = process.env.WECOM_BOT_ID;
    const secret = process.env.WECOM_BOT_SECRET;
    if (!botId || !secret) { console.error('缺少环境变量 WECOM_BOT_ID / WECOM_BOT_SECRET（放在 /etc/agentdesk-orchestrator/wechat.env）'); process.exit(2); }
    const { BotChannel, createBotClient } = require('./bot');
    const client = createBotClient({ botId, secret, log, onMessage });
    return { channel: new BotChannel({ client, log }), start: () => client.connect(), stop: () => client.disconnect(), owner: null };
  }
  const { IlinkChannel } = require('./ilink');
  const dir = path.join(config.stateDir, 'wechat');
  const accountFile = path.join(dir, 'ilink-account.json');
  if (!fs.existsSync(accountFile)) return null;
  const account = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  const channel = new IlinkChannel({ account, stateFile: path.join(dir, 'ilink-state.json'), log });
  const controller = new AbortController();
  return {
    channel, owner: account.userId || null,
    start: () => channel.start(onMessage, controller.signal).catch((error) => { log('ilink loop crashed', error?.stack || error); process.exit(1); }),
    stop: () => controller.abort(),
  };
}

function main() {
  const wechatPath = process.argv[2] || '/etc/agentdesk-orchestrator/wechat.json';
  const orchestratorPath = process.argv[3] || '/etc/agentdesk-orchestrator/config.json';
  const config = fs.existsSync(wechatPath) ? JSON.parse(fs.readFileSync(wechatPath, 'utf8')) : {};
  const orchestratorConfig = JSON.parse(fs.readFileSync(orchestratorPath, 'utf8'));
  config.stateDir ||= orchestratorConfig.stateDir;
  let service = null;
  const transport = createChannel(config, (message) => service?.onMessage(message));
  if (!transport) {
    // 个人微信还没扫码登录：等登录文件出现再启动（不退出，免得 systemd 反复重启）。
    log('个人微信 ClawBot 尚未登录：运行 sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js 扫码，然后 systemctl restart agentdesk-wechat');
    setInterval(() => {}, 3600_000);
    return;
  }
  // 扫码登录 ClawBot 的人自动是管理员。
  if (transport.owner && !(config.allowUsers || []).includes(transport.owner)) config.allowUsers = [...(config.allowUsers || []), transport.owner];
  if (!config.allowUsers?.length) log('提示：allowUsers 为空，所有人都会被拒绝；日志里会打印被拒绝的 userid，登记后重启服务');
  const adapters = loadAdapters(orchestratorConfig);
  const quota = new QuotaGate({ adapters, quotaStatus: require('../quotas').quotaStatus, minRemaining: config.minQuotaPercent ?? 8 });
  service = new WechatService({ config, adapters, channel: transport.channel, runAdapter: require('../adapters').runAdapter, quota });
  service.gc();
  setInterval(() => { try { service.gc(); } catch (error) { log('gc failed', error.message); } }, 3600 * 1000).unref();
  transport.start();
  log(`wechat service started, channel: ${config.channel || 'ilink'}, adapters: ${Object.keys(adapters).join(',')}, allowUsers: ${service.allowUsers.size}`);
  const shutdown = () => {
    if (service.running) service.running.controller.abort(new Error('cancelled'));
    try { transport.stop(); } catch {}
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { WechatService, loadAdapters, duration, short, plainSummary, mergeDeliveries, deliverySummary, userTag };
