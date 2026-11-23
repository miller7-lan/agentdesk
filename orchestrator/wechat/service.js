'use strict';
// 微信办公助手服务：企业微信自建应用回调 → 路由 → 排队执行 → 回文件和说明。
// 用法：node service.js [/etc/agentdesk-orchestrator/wechat.json] [/etc/agentdesk-orchestrator/config.json]
// 与主控（service.js 上一级）是两个独立进程：共用 CLI 登录目录（stateDir/homes/<cli>），不走主控的调度器。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const wecom = require('./wecom');
const router = require('./router');
const runner = require('./runner');
const { TaskStore } = require('./store');
const { QuotaGate, describeBlocked } = require('./quota');

const STATUS_ICON = { queued: '⏳', planning: '🧭', running: '▶️', succeeded: '✅', failed: '❌', timeout: '⌛', cancelled: '⏹', quota_limited: '🪫', quota_low: '🪫', auth_expired: '🔑' };
const STATUS_TEXT = { queued: '排队中', planning: '组长规划中', running: '执行中', succeeded: '完成', failed: '失败', timeout: '超时', cancelled: '已停止', quota_limited: '额度用尽', quota_low: '额度不够', auth_expired: 'AI 需要重新登录' };
const DAY = 24 * 3600 * 1000;

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
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:file:\/\/)?\/(?:[^\s/「」（）()]+\/)+([^\s/「」（）()]+)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function friendlyError(task) {
  if (task.status === 'quota_low') return `额度不够，稍后再试（发 /重试 ${task.id}）。${task.blocked ? describeBlocked(task.blocked) + '。' : ''}`;
  if (task.status === 'timeout') return '超时了，可以把需求拆小一点再试。';
  if (task.status === 'quota_limited') return `${executorLabel(task.executor)} 额度用完了，换个档位试试（/低 /中 /高）。`;
  if (task.status === 'auth_expired') return `${executorLabel(task.executor)} 登录失效，需要在服务器上重新登录。`;
  if (task.error === 'service_restarted') return `服务重启，任务中断了，发 /重试 ${task.id} 重做。`;
  return '执行出错了' + (task.error ? `（${short(task.error, 80)}）` : '') + '。';
}

class WechatService {
  constructor({ config, adapters, client, runTask = runner.runTask, runAdapter, quota = null, now = Date.now }) {
    this.config = config;
    this.adapters = adapters;
    this.client = client;
    this.runTask = runTask;
    this.runAdapter = runAdapter;
    this.quota = quota;
    this.now = now;
    this.store = new TaskStore(path.join(config.stateDir, 'wechat'));
    this.allowUsers = new Set(config.allowUsers || []);
    this.queue = [];
    this.running = null;
  }

  send(user, text) {
    return this.client.sendText(user, text).catch((error) => log('send failed', error.message));
  }

  async onMessage(message) {
    if (this.store.seen(message.dedupeKey)) return log('duplicate ignored');
    log('message', message.type, message.event || '', 'from', message.from);
    const user = message.from;
    const action = router.route(message, { allowUsers: this.allowUsers, hasHistory: Boolean(this.store.last(user)) });
    switch (action.kind) {
      case 'ignore': return;
      case 'deny': return this.send(user, '这个助手只为指定成员服务。');
      case 'help': return this.send(user, router.HELP);
      case 'reply': return this.send(user, action.text);
      case 'file': return this.receiveFile(message);
      case 'append': return this.append(user, action.text);
      case 'tier': return this.setTier(user, action);
      case 'start': return this.start(user, action.tier);
      case 'enter': return this.send(user, this.enter(user, action.id));
      case 'fresh': return this.send(user, this.leave(user));
      case 'clear':
        this.store.clearDraft(user, { keepTarget: true, removeFiles: true });
        return this.send(user, '草稿已清空。');
      case 'list': return this.send(user, this.listText(user));
      case 'show': return this.send(user, this.showText(user, action.id));
      case 'stop': return this.send(user, this.stop(user, action.id));
      case 'retry': return this.retry(user, action.id);
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

  append(user, text) {
    const before = this.store.draft(user);
    const draft = this.store.updateDraft(user, { texts: [...before.texts, text] }, this.now());
    if (this.draftEmpty(before)) return this.send(user, this.hint(draft));
    return undefined;
  }

  setTier(user, action) {
    const before = this.store.draft(user);
    const draft = this.store.updateDraft(user, { tier: action.tier, texts: action.text ? [...before.texts, action.text] : before.texts }, this.now());
    if (draft.target) return this.send(user, `已选${router.TIER_LABEL[action.tier]}。注意：接着改老任务时沿用原来的执行者，档位不变；要换档请 /新。`);
    return this.send(user, this.draftEmpty(draft) ? `已选${router.TIER_LABEL[action.tier]}。发需求后再发「开始」。` : `已选${router.TIER_LABEL[action.tier]}。发「开始」执行。`);
  }

  async receiveFile(message) {
    const user = message.from;
    try {
      const saved = await this.client.download(message.mediaId, this.store.pendingDir(user), message.fileName);
      const before = this.store.draft(user);
      const draft = this.store.updateDraft(user, { files: [...before.files, saved] }, this.now());
      const counts = `草稿里有 ${draft.files.length} 个文件${draft.texts.length ? `、${draft.texts.length} 段文字` : ''}`;
      await this.send(user, `已收到「${path.basename(saved)}」（${counts}）。${draft.texts.length ? '发「开始」执行。' : '说说要做什么，再发「开始」。'}`);
    } catch (error) {
      log('download failed', error.message);
      await this.send(user, '文件没收下来（' + short(error.message, 60) + '），请重发。');
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

  start(user, tierOverride) {
    const draft = this.store.draft(user);
    if (!draft.texts.length) {
      return this.send(user, draft.files.length ? '还没说要做什么。发需求文字后再发「开始」。' : '草稿是空的。先发需求和文件，再发「开始」。\n' + router.HELP);
    }
    const text = router.composeDraft(draft.texts);
    const target = draft.target && this.store.get(draft.target);
    this.store.clearDraft(user);
    // 进入的老任务有执行者：接着改；否则（规划阶段就失败、已清理）当新任务。
    if (target && target.user === user && target.executor && !target.archived) {
      const newInputs = this.moveFiles(draft.files, this.store.taskDir(target.id));
      this.store.update(target.id, { status: 'queued', turns: (target.turns || 1) + 1, finishedAt: null, error: null, blocked: null, lastText: text });
      return this.enqueue({ id: target.id, user, continuation: { text, newInputs } });
    }
    const tier = tierOverride || draft.tier;
    const task = this.store.create({ user, text, tier, tierSource: tier ? 'user' : 'auto' });
    this.moveFiles(draft.files, this.store.taskDir(task.id));
    return this.enqueue({ id: task.id, user });
  }

  enter(user, id) {
    const task = this.store.get(id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。发 /ls 看最近的任务。`;
    if (task.archived) return `#${id} 的文件已过保留期清理，不能接着改了。`;
    if (!task.executor) return `#${id} 当时没开始执行（${STATUS_TEXT[task.status]}），发 /重试 ${id} 重做。`;
    if (this.running?.job.id === id || this.queue.some((job) => job.id === id)) return `#${id} 还在执行，等它完成再接着改。`;
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

  retry(user, id) {
    const task = this.store.get(id);
    if (!task || task.user !== user) return this.send(user, `没有 #${id} 这个任务。`);
    if (task.archived) return this.send(user, `#${id} 的文件已过保留期清理，不能重试。`);
    if (task.status === 'succeeded') return this.send(user, `#${id} 已经完成了。要修改请发 /进 ${id}。`);
    if (this.running?.job.id === id || this.queue.some((job) => job.id === id)) return this.send(user, `#${id} 还在执行。`);
    this.store.update(id, { status: 'queued', finishedAt: null, error: null, blocked: null, sessions: {}, executor: null, tier: task.tierSource === 'user' ? task.tier : null });
    return this.enqueue({ id, user });
  }

  enqueue(job) {
    const task = this.store.get(job.id);
    const ahead = this.queue.length + (this.running ? 1 : 0);
    const what = job.continuation ? `接着改 #${task.id}` : `收到 #${task.id}`;
    const route = job.continuation ? ` · ${executorLabel(task.executor)}`
      : task.tier === 'high' ? ' · 高档 → Claude Opus' : task.tier ? ` · ${router.TIER_LABEL[task.tier]}，组长先规划` : '，组长规划中';
    this.send(job.user, ahead ? `${what}，前面还有 ${ahead} 个任务，排队中。` : `${what}${route}…`);
    this.queue.push(job);
    this.pump();
  }

  pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    const controller = new AbortController();
    this.running = { job, controller };
    this.execute(job, controller.signal)
      .catch((error) => log('execute crashed', error.stack || error.message))
      .finally(() => { this.running = null; this.pump(); });
  }

  async execute(job, signal) {
    const task = this.store.get(job.id);
    const dir = this.store.taskDir(task.id);
    const startedAt = this.now();
    this.store.update(task.id, { status: job.continuation ? 'running' : task.tier === 'high' ? 'running' : 'planning', startedAt });
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
      finishedAt, error: result.error || null, blocked: result.blocked || null, outputs: [...new Set([...(task.outputs || []), ...outputs])], summary: short(result.summary, 300),
    });
    log('task', task.id, result.status, result.executor?.provider || '', duration(finishedAt - startedAt), `outputs=${outputs.length}`);
    await this.deliver(job.user, this.store.get(task.id), result, finishedAt - startedAt);
  }

  async deliver(user, task, result, elapsed) {
    const failedFiles = [];
    for (const file of result.outputs) {
      try {
        if (fs.statSync(file).size > wecom.FILE_LIMIT) { failedFiles.push(`${path.basename(file)}（超过 20MB）`); continue; }
        await this.client.sendFile(user, file);
      } catch (error) {
        log('send file failed', error.message);
        failedFiles.push(path.basename(file));
      }
    }
    if (result.status === 'succeeded' && this.config.sendPreview !== false) {
      const deck = result.outputs.find((file) => /\.pptx$/i.test(file));
      if (deck) await this.sendPreview(user, deck, task.id).catch((error) => log('preview failed', error.message));
    }
    const meta = [router.TIER_LABEL[task.tier], executorLabel(task.executor), duration(elapsed)].filter(Boolean).join(' · ');
    const head = `${STATUS_ICON[task.status]} #${task.id} ${STATUS_TEXT[task.status]}（${meta}）`;
    const lines = [head];
    if (result.note) lines.push(result.note);
    if (task.status === 'succeeded') {
      if (result.summary) lines.push(plainSummary(result.summary));
      if (!result.outputs.length) lines.push('（这次没有生成文件）');
    } else {
      lines.push(friendlyError(task));
      if (result.outputs.length) lines.push(`已生成的部分文件也发给你了。`);
    }
    if (failedFiles.length) lines.push(`这些文件没发出去：${failedFiles.join('、')}`);
    if (task.status === 'succeeded') lines.push(`接下来发的内容是新任务；要接着改这个，发 /进 ${task.id}。`);
    await this.send(user, lines.join('\n'));
  }

  sendPreview(user, file, id) {
    const out = path.join(this.store.taskDir(id), 'work', 'preview');
    const env = { ...process.env, PATH: `/opt/agentdesk-office/bin:/opt/agentdesk-office/venv/bin:${process.env.PATH}`, HOME: path.join(this.store.taskDir(id), 'work') };
    return new Promise((resolve, reject) => {
      execFile('office-preview', [file, '1', out], { env, timeout: 120_000 }, (error, stdout) => {
        if (error) return reject(error);
        const image = stdout.trim().split('\n').pop();
        this.client.sendImage(user, image).then(resolve, reject);
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
    if (!tasks.length) return '还没有任务。\n' + router.HELP;
    return tasks.map((task) => {
      const took = task.finishedAt && task.startedAt ? ' ' + duration(task.finishedAt - task.startedAt) : '';
      const who = task.executor ? `${router.TIER_LABEL[task.tier] || ''}·${executorLabel(task.executor)}` : (task.tier ? router.TIER_LABEL[task.tier] : '');
      return `#${task.id} ${STATUS_ICON[task.status] || ''} ${who}${took} ${short(task.text)}${task.archived ? '（已清理）' : ''}`;
    }).join('\n') + '\n发 /进 编号 接着改某个任务，/s 编号 看详情。';
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
    if (task.summary) lines.push(`说明：${task.summary}`);
    if (task.error && task.status !== 'succeeded') lines.push(friendlyError(task));
    if (task.archived) lines.push('（文件已按保留期清理）');
    return lines.join('\n');
  }

  gc() {
    // 任务文件和记录都保留 30 天（用户 2026-11-23 要求）；草稿 3 天没开始就丢掉。
    const keep = this.config.retention || {};
    const days = keep.days ?? 30;
    const removed = this.store.gc({
      keepSucceededMs: days * DAY, keepFailedMs: days * DAY, keepPendingMs: (keep.draftDays ?? 3) * DAY, keepRecordsMs: days * DAY,
    }, this.now());
    if (removed) log('gc removed', removed, 'task folders');
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(config, onMessage) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.endsWith('/callback')) { res.writeHead(404); return res.end(); }
    const query = Object.fromEntries(url.searchParams);
    try {
      if (req.method === 'GET') {
        const echo = wecom.verifyUrl(config, query);
        log('url verified');
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(echo);
      }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const message = wecom.readCallback(config, query, await readBody(req));
      // 5 秒内必须回；空串 = 不做被动回复，企业微信也不重试。
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('');
      Promise.resolve(onMessage(message)).catch((error) => log('message failed', error.stack || error.message));
    } catch (error) {
      log('callback rejected', error.message);
      if (!res.headersSent) { res.writeHead(400); res.end(); }
    }
  });
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

function main() {
  const wechatPath = process.argv[2] || '/etc/agentdesk-orchestrator/wechat.json';
  const orchestratorPath = process.argv[3] || '/etc/agentdesk-orchestrator/config.json';
  const config = JSON.parse(fs.readFileSync(wechatPath, 'utf8'));
  for (const key of ['corpId', 'agentId', 'secret', 'token', 'encodingAesKey']) {
    if (!config[key]) { console.error(`wechat.json 缺少 ${key}`); process.exit(2); }
  }
  if (!config.allowUsers?.length) console.error('警告：allowUsers 为空，任何可见范围内的成员都能使用');
  const orchestratorConfig = JSON.parse(fs.readFileSync(orchestratorPath, 'utf8'));
  config.stateDir ||= orchestratorConfig.stateDir;
  const adapters = loadAdapters(orchestratorConfig);
  const quota = new QuotaGate({ adapters, quotaStatus: require('../quotas').quotaStatus, minRemaining: config.minQuotaPercent ?? 8 });
  const service = new WechatService({ config, adapters, client: new wecom.WecomClient(config), runAdapter: require('../adapters').runAdapter, quota });
  service.gc();
  setInterval(() => { try { service.gc(); } catch (error) { log('gc failed', error.message); } }, 3600 * 1000).unref();
  const listen = config.listen || { host: '127.0.0.1', port: 9460 };
  createServer(config, (message) => service.onMessage(message))
    .listen(listen.port, listen.host, () => log(`wechat service listening on ${listen.host}:${listen.port}, adapters: ${Object.keys(adapters).join(',')}`));
  const shutdown = () => {
    if (service.running) service.running.controller.abort(new Error('cancelled'));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { WechatService, createServer, loadAdapters, duration, short, plainSummary };
