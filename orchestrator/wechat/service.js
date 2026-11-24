'use strict';
// 微信办公助手服务：个人微信 ClawBot（iLink 长轮询）→ 引导式路由 → 出方案 / 排队执行 → 回文件和说明。
// 用法：node service.js [wechat.json] [orchestrator config.json]
// 多个 ClawBot：每个一份 wechat-<名>.json（dataDir 各自独立），用 agentdesk-wechat@<名>.service 跑，数据互不相通。
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
const { Devices, changeText, statusText, since: sinceText } = require('./devices');

const STATUS_ICON = { review: '📋', queued: '⏳', planning: '🧭', running: '▶️', succeeded: '✅', failed: '❌', timeout: '⌛', cancelled: '⏹', quota_limited: '🪫', quota_low: '🪫', auth_expired: '🔑' };
const STATUS_TEXT = { review: '方案待确认', queued: '排队中', planning: '组长出方案中', running: '执行中', succeeded: '完成', failed: '失败', timeout: '超时', cancelled: '已停止', quota_limited: '额度用尽', quota_low: '额度不够', auth_expired: 'AI 需要重新登录' };
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
  if (task.status === 'quota_low') return `额度不够，稍后再试（发 /重试${task.id}）。${task.blocked ? describeBlocked(task.blocked) + '。' : ''}`;
  if (task.status === 'timeout') return `超时了，可以把需求拆小一点，或发 /重试${task.id}。`;
  if (task.status === 'quota_limited') return `${executorLabel(task.executor)} 额度用完了，稍后发 /重试${task.id}。`;
  if (task.status === 'auth_expired') return `${executorLabel(task.executor) || 'AI'} 登录失效，需要管理员在服务器上重新登录。`;
  if (task.error === 'service_restarted') return `服务重启，任务中断了，发 /重试${task.id} 重做。`;
  if (task.error === 'plan_unparsed') return `组长的方案没写成规定格式，发 /重试${task.id} 再出一次。`;
  return '出错了' + (task.error ? `（${short(task.error, 80)}）` : '') + `。可发 /重试${task.id}。`;
}

// userid 在日志里只记哈希前 8 位，不记明文。
function userTag(userid) { return crypto.createHash('sha256').update(String(userid)).digest('hex').slice(0, 8); }

class WechatService {
  constructor({ config, adapters, channel, planTask = runner.planTask, executeTask = runner.executeTask, runAdapter, quota = null, validate = validateFile, now = Date.now, devices = null, remote = null }) {
    this.config = config;
    this.adapters = adapters;
    this.channel = channel;
    this.planTask = planTask;
    this.executeTask = executeTask;
    this.runAdapter = runAdapter;
    this.quota = quota;
    this.validate = validate;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
    this.store = new TaskStore(config.dataDir || path.join(config.stateDir, 'wechat'));
    this.allowUsers = new Set(config.allowUsers || []);
    // 管理员：扫码登录 ClawBot 的人 + wechat.json 的 admins。管理员能看设备、远程操作电脑。
    this.admins = new Set(config.admins || []);
    for (const admin of this.admins) this.allowUsers.add(admin);
    this.devices = devices;
    this.remote = remote;
    this.chatting = new Map();       // 管理员 → 当前回复的 AbortController
    this.chatBuffer = new Map();     // 回复期间攒下的消息
    this.chatFiles = new Map();      // 还没告诉 AI 的新文件
    this.queue = [];
    this.running = null;
    this.planning = new Map();       // user → { taskId, controller }
    this.asking = new Set();
    this.messageTimes = new Map();
    this.askTimes = new Map();
    // 重启前停在「组长出方案中」的引导：方案进程已经没了，退回看方案或收集阶段。
    for (const [user, draft] of Object.entries(this.store.data.drafts)) {
      if (draft.stage !== 'planning') continue;
      const task = draft.reviewTask && this.store.get(user, draft.reviewTask);
      this.store.data.drafts[user] = { ...draft, stage: task?.plan ? 'review' : 'idle', reviewTask: task?.plan ? task.id : null };
    }
  }

  deps(extra = {}) {
    return { adapters: this.adapters, runAdapter: this.runAdapter, settings: this.config.tiers, quota: this.quota, ...extra };
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

  draft(user) {
    const draft = this.store.draft(user);
    return { stage: 'idle', reviewTask: null, ...draft };
  }

  setDraft(user, change) { return { stage: 'idle', reviewTask: null, ...this.store.updateDraft(user, change, this.now()) }; }

  async onMessage(message) {
    if (this.store.seen(message.dedupeKey)) return log('duplicate ignored');
    const user = message.from;
    const draft = this.draft(user);
    log('message', message.type, message.event || '', message.chatType, 'user', user ? userTag(user) : '-', 'stage', draft.stage);
    const action = router.route(message, { allowUsers: this.allowUsers, stage: draft.stage, admin: this.isAdmin(user) });
    if (action.kind === 'deny') {
      log('denied user (add to allowUsers to enable):', user);
      return this.respond(message, '这个助手目前只对已登记的成员开放，请联系管理员。');
    }
    if (user && !['ignore', 'welcome'].includes(action.kind)
        && !this.allow(this.messageTimes, user, this.limits.messagesPerMinute, 60_000)) {
      return log('rate limited', userTag(user));
    }
    switch (action.kind) {
      case 'ignore': return undefined;
      case 'welcome': return this.channel.welcome(message, this.helpText(user)).catch(() => {});
      case 'greet': return this.respond(message, `你好！\n${this.helpText(user)}${!this.isAdmin(user) && draft.stage !== 'idle' ? '\n\n' + this.stagePrompt(draft) : ''}`);
      case 'help': return this.respond(message, this.helpText(user));
      case 'devices': return this.isAdmin(user) ? this.devicesNow(message) : this.respond(message, '这个命令只有管理员能用。');
      case 'model': return this.respond(message, this.isAdmin(user) ? this.chooseModel(user, action.choice) : '这个命令只有管理员能用。');
      case 'computer': return this.respond(message, this.isAdmin(user) ? this.chooseComputer(user, action.choice) : '这个命令只有管理员能用。');
      case 'chat': return this.chat(message, action.text);
      case 'chat-file': return this.chatFile(message, action.text);
      case 'new': return this.respond(message, this.isAdmin(user) ? this.newChat(user) : this.newTask(user, draft));
      case 'reply': return this.respond(message, action.text);
      case 'remind': return this.respond(message, this.remindText(draft, action.why));
      case 'append': return this.append(message, draft, action.text);
      case 'file': return this.receiveFile(message, draft, action.text);
      case 'tier': return this.chooseTier(message, draft, action.tier);
      case 'start': return this.startPlanning(message, draft);
      case 'wait': return this.respond(message, `组长还在出方案（一般 1～3 分钟），出来后马上发给你。不想等可以发 /2 取消。`);
      case 'revise': return this.revise(message, draft, action.text);
      case 'confirm': return this.confirm(message, draft);
      case 'cancel': return this.respond(message, this.isAdmin(user) ? this.stopChat(user) : this.cancelFlow(user, draft));
      case 'enter': return this.respond(message, this.enter(user, action.id));
      case 'list': return this.respond(message, this.listText(user));
      case 'show': return this.respond(message, this.showText(user, action.id));
      case 'stop': return this.respond(message, this.stop(user, action.id));
      case 'retry': return this.retry(message, action.id);
      case 'resend': return this.resend(message, action.id);
      case 'ask': return this.ask(message, action.text);
      default: return undefined;
    }
  }

  isAdmin(user) { return this.admins.has(user); }

  helpText(user) { return this.isAdmin(user) ? router.ADMIN_HELP : router.HELP; }

  // ---------- 设备（管理员） ----------

  devicesText() {
    if (!this.devices) return '没有配置关联电脑。';
    return statusText(this.devices.snapshot(), this.now());
  }

  // 定时查设备；上线/离线时提醒所有管理员。first：服务刚启动，有离线的设备也提醒一次。
  async watchDevices({ first = false } = {}) {
    if (!this.devices) return;
    const changes = await this.devices.poll();
    for (const change of changes) {
      log('device', change.device.id, change.online ? 'online' : 'offline');
      for (const admin of this.admins) this.send(admin, changeText(change));
    }
    if (first) {
      const offline = this.devices.snapshot().filter((item) => item.online === false);
      if (offline.length) for (const admin of this.admins) this.send(admin, `${this.devicesText()}\n离线的电脑开机并登录后会自动连上（Bridge 开机自启，不用打开 AgentDesk）。`);
    }
  }

  // ---------- 管理员助理 ----------
  // 管理员发的消息交给所选 CLI，在同一个会话里接着聊（/新 才开新会话）。AI 的当前目录是本会话的任务目录：
  // in/ 收到的文件，out/ 里新出现的文件发回微信；通过 remote 工具操作所选电脑。

  chatPref(user) {
    const pref = this.store.pref(user);
    const model = runner.ADMIN_MODELS.find((item) => item.provider === pref.model && this.adapters[item.provider])
      || runner.ADMIN_MODELS.find((item) => this.adapters[item.provider]);
    const device = this.devices?.find(pref.device || '') || this.devices?.list[0] || null;
    return { model, device, chatTask: pref.chatTask || null };
  }

  async devicesNow(message) {
    if (!this.devices) return this.respond(message, '没有配置关联电脑。');
    const results = await this.devices.check();
    const lines = results.map(({ device, online }) => {
      const since = this.devices.state.get(device.id);
      const lasting = since && since.online === online ? `（已${online ? '在线' : '离线'} ${sinceText(this.now() - since.since)}）` : '';
      return `${online ? '🟢' : '🔴'} ${device.label}：${online ? '在线' : '离线'}${lasting}`;
    });
    const tip = results.some((item) => !item.online) ? '\n离线的电脑开机并登录后会自动连上（不用打开 AgentDesk）。' : '';
    return this.respond(message, `【设备 · 刚查的】\n${lines.join('\n')}${tip}`);
  }

  chooseModel(user, choice) {
    const { model } = this.chatPref(user);
    const list = runner.ADMIN_MODELS.filter((item) => this.adapters[item.provider]);
    if (!choice) return '【AI】\n' + list.map((item, index) => `${index + 1} ${item.label}${item === model ? '（当前）' : ''}`).join('\n') + '\n发 /模型2 这样切换。';
    const next = list[choice - 1];
    if (!next) return `没有第 ${choice} 个，发 /模型 查看。`;
    if (next === model) return `已经是 ${next.label}。`;
    if (this.chatting.has(user)) return '当前回复还没结束，等它结束（或 /2 停止）再切换。';
    // 不同 CLI 的会话不能互相接续：换 AI 就开新对话。
    this.store.setPref(user, { model: next.provider, chatTask: null });
    return `已切换到 ${next.label}，下条消息开始新对话。`;
  }

  chooseComputer(user, choice) {
    if (!this.devices) return '没有配置关联电脑。';
    const { device } = this.chatPref(user);
    const snap = this.devices.snapshot();
    if (!choice) {
      return statusText(snap, this.now()).replace('【设备】', '【电脑】').split('\n').map((line, index) => index ? `${index} ${line}${snap[index - 1].device.id === device?.id ? '（当前）' : ''}` : line).join('\n')
        + '\n发 /电脑2 这样切换。离线的电脑开机登录后自动连上（Bridge 开机自启，不用打开 AgentDesk）。';
    }
    const next = this.devices.list[choice - 1];
    if (!next) return `没有第 ${choice} 台，发 /电脑 查看。`;
    this.store.setPref(user, { device: next.id });
    const online = this.devices.state.get(next.id)?.online;
    return `之后操作 ${next.label}${online === false ? '（现在离线）' : ''}。`;
  }

  newChat(user) {
    if (this.chatting.has(user)) return '当前回复还没结束，等它结束（或 /2 停止）再开新对话。';
    const { chatTask } = this.chatPref(user);
    if (chatTask) this.store.update(user, chatTask, { status: 'succeeded', finishedAt: this.now() });
    this.store.setPref(user, { chatTask: null });
    this.chatBuffer.delete(user);
    return '好的，下条消息开始新对话。';
  }

  stopChat(user) {
    const running = this.chatting.get(user);
    if (!running) return '现在没有在进行的回复。发 /新 开新对话。';
    running.abort(new Error('cancelled'));
    this.chatBuffer.delete(user);
    return '正在停止当前回复。';
  }

  // 当前会话的任务；没有就新建。
  chatTask(user, text) {
    const { model, chatTask } = this.chatPref(user);
    const existing = chatTask && this.store.get(user, chatTask);
    if (existing && !existing.archived && existing.executor?.provider === model.provider) return existing;
    const task = this.store.create({ user, kind: 'chat', text, tier: 'admin', status: 'succeeded', executor: { provider: model.provider, model: model.model }, sessions: {} });
    this.store.setPref(user, { chatTask: task.id });
    return task;
  }

  async chatFile(message, caption) {
    const user = message.from;
    const task = this.chatTask(user, caption || '（文件）');
    let saved;
    try {
      saved = await this.channel.download(message, path.join(this.store.taskDir(user, task.id), 'in'));
    } catch (error) {
      log('download failed', userTag(user), error?.message || error);
      return this.respond(message, '文件没收下来，请重发。');
    }
    log('file received', userTag(user), path.extname(saved), fs.statSync(saved).size);
    const pending = this.chatFiles.get(user) || [];
    pending.push(path.basename(saved));
    this.chatFiles.set(user, pending);
    if (caption) return this.chat(message, caption);
    return this.respond(message, `收到「${path.basename(saved)}」。说说要做什么。`);
  }

  async chat(message, text) {
    const user = message.from;
    if (this.chatting.has(user)) {
      // 正在回复：先攒着，这轮结束后一起发给 AI。
      const buffer = this.chatBuffer.get(user) || [];
      buffer.push(text);
      this.chatBuffer.set(user, buffer);
      if (buffer.length === 1) this.respond(message, '收到，等当前这轮做完一起处理（/2 停止当前）。');
      return undefined;
    }
    return this.chatTurn(user, text);
  }

  async chatTurn(user, text) {
    const { model, device } = this.chatPref(user);
    if (!model) return this.send(user, '没有可用的 AI。');
    const task = this.chatTask(user, text);
    const dir = this.store.taskDir(user, task.id);
    const files = this.chatFiles.get(user) || [];
    this.chatFiles.delete(user);
    const controller = new AbortController();
    this.chatting.set(user, controller);
    const capability = this.remote && device ? this.remote.grant({ user, device, dir }) : null;
    const startedAt = this.now();
    const slow = setTimeout(() => this.send(user, `⏳ ${model.label} 还在处理（已 ${duration(this.now() - startedAt)}），/2 可以停止。`), 3 * 60_000);
    slow.unref?.();
    try {
      if (this.quota) await this.quota.require([model.provider]);
      const result = await runner.chatTurn({
        task, dir, signal: controller.signal, text, files, model,
        device: device && { label: device.label, online: this.devices?.state.get(device.id)?.online !== false },
        mcp: capability && this.remote.mcp(capability),
        deps: this.deps(),
      });
      this.store.update(user, task.id, { sessions: result.sessions, turns: (task.turns || 0) + 1, finishedAt: this.now(), lastText: short(text, 200) });
      // 先发文字再发文件：大文件上传微信 CDN 可能要几分钟，别让回复跟着干等。
      const reply = plainSummary(result.summary) || (result.outputs.length ? '' : '（没有回复内容）');
      if (reply) await this.send(user, reply.length > 1800 ? reply.slice(0, 1800) + '…' : reply);
      const results = result.outputs.length ? await this.sendFiles(user, result.outputs) : [];
      if (results.length) this.store.update(user, task.id, { outputs: [...new Set([...(task.outputs || []), ...results.map((item) => item.name)])], deliveries: mergeDeliveries(task.deliveries, results) });
      const failed = deliverySummary(results, task.id);
      if (failed) await this.send(user, failed);
      log('chat', task.id, model.provider, duration(this.now() - startedAt), `outputs=${result.outputs.length}`);
    } catch (error) {
      const status = runner.statusFor(error, controller.signal);
      log('chat failed', task.id, model.provider, status, String(error?.message || error).slice(0, 120));
      if (status === 'cancelled') await this.send(user, '已停止。');
      else if (status === 'quota_low') await this.send(user, `🪫 ${model.label} 额度不够。${error.blocked ? describeBlocked(error.blocked) + '。' : ''}可以 /模型 换一个。`);
      else if (status === 'auth_expired') await this.send(user, `🔑 ${model.label} 登录失效，需要在服务器上重新登录；先 /模型 换一个。`);
      else if (status === 'quota_limited') await this.send(user, `🪫 ${model.label} 额度用完了，/模型 换一个。`);
      else if (status === 'timeout') await this.send(user, '超时了，可以把事情拆小一点再发。');
      else await this.send(user, `出错了（${short(error?.message || error, 80)}）。可以再发一次，或 /新 重新开始。`);
      if (error?.sessions) this.store.update(user, task.id, { sessions: error.sessions });
    } finally {
      clearTimeout(slow);
      if (capability) this.remote.revoke(capability);
      this.chatting.delete(user);
    }
    const buffered = this.chatBuffer.get(user);
    if (buffered?.length) {
      this.chatBuffer.delete(user);
      return this.chatTurn(user, buffered.join('\n'));
    }
    return undefined;
  }

  // ---------- 普通用户：默认接着上一个任务 ----------

  // 能接着改的最近任务（做过、文件没清理、不是管理员会话）。
  continuable(user) {
    const last = this.store.recent(user, 5).find((task) => task.kind !== 'chat');
    if (!last || last.archived || !last.executor || this.isActive(user, last.id)) return null;
    return ['succeeded', 'failed', 'timeout', 'quota_limited', 'auth_expired'].includes(last.status) ? last : null;
  }

  newTask(user, draft) {
    if (['planning', 'review'].includes(draft.stage)) return `方案 #${draft.reviewTask} 还没处理完：发「完成」提交或 /2 取消后再开新任务。`;
    this.store.clearDraft(user, { removeFiles: true });
    this.setDraft(user, { fresh: true });
    return '好的，开新任务：发需求或文件。';
  }

  // ---------- 引导 ----------

  summaryOfDraft(draft) {
    const parts = [];
    if (draft.texts.length) parts.push(`${draft.texts.length} 段文字`);
    if (draft.files.length) parts.push(`${draft.files.length} 个文件`);
    return parts.length ? parts.join('、') : '还没有内容';
  }

  stagePrompt(draft) {
    switch (draft.stage) {
      case 'tier': return router.TIER_MENU;
      case 'collect': return draft.target
        ? `正在接着改 #${draft.target}：发修改要求（可带新文件），发「开始」交给原来的执行 AI。/2 退出。`
        : `当前：${router.TIER_LABEL[draft.tier]}，已收到${this.summaryOfDraft(draft)}。继续发需求或文件，发「开始」让组长出方案。`;
      case 'planning': return '组长正在出方案（一般 1～3 分钟），出来后马上发给你。';
      case 'review': return `方案 #${draft.reviewTask} 等你确认：有要改的直接说；满意就发「完成」提交；/2 取消。`;
      default: return '发需求或文件开始一个新任务；/0 查看全部命令。';
    }
  }

  remindText(draft, why) {
    const head = { tier: '没看懂，请回复数字 1、2 或 3。', start: '现在不需要「开始」。', confirm: '现在没有等确认的方案。', unknown: '没有这个命令（/0 查看全部命令）。' }[why] || '';
    return `${head}\n${this.stagePrompt(draft)}`.trim();
  }

  // 空闲时发的内容默认接着改上一个任务；/新 之后才开新任务。
  autoTarget(user, draft) {
    if (draft.stage !== 'idle' || draft.tier || draft.target || draft.fresh) return null;
    return this.continuable(user);
  }

  async append(message, draft, text) {
    const user = message.from;
    const first = !draft.texts.length && !draft.files.length;
    const auto = this.autoTarget(user, draft);
    if (auto) {
      this.setDraft(user, { target: auto.id, stage: 'collect', texts: [text] });
      return this.respond(message, `接着改 #${auto.id}（${short(auto.text, 20)}）：还要补充就继续发，发「开始」交给 ${executorLabel(auto.executor)}。开新任务发 /新`);
    }
    const next = this.setDraft(user, { texts: [...draft.texts, text], stage: draft.stage === 'idle' ? (draft.tier || draft.target ? 'collect' : 'tier') : draft.stage });
    if (next.stage === 'tier') return this.respond(message, `收到需求。\n${router.TIER_MENU}`);
    if (first) return this.respond(message, `收到。还有要补充的继续发（文字或文件），发完发「开始」让组长出方案。`);
    return undefined;   // 收集阶段后续内容不逐条回复，免得刷屏
  }

  async receiveFile(message, draft, caption) {
    const user = message.from;
    let saved;
    try {
      if (draft.stage === 'review' && draft.reviewTask) {
        // 看方案时补发的文件直接放进该任务的输入，组长下次改方案时会看到。
        const task = this.store.get(user, draft.reviewTask);
        saved = await this.channel.download(message, path.join(this.store.taskDir(user, task.id), 'in'));
        this.store.update(user, task.id, { pendingInputs: [...(task.pendingInputs || []), path.basename(saved)] });
        log('file received', userTag(user), path.extname(saved), fs.statSync(saved).size);
        if (caption) return this.revise(message, this.draft(user), caption);
        return this.respond(message, `已收到「${path.basename(saved)}」，加进 #${task.id} 的输入。说说要怎么用它（组长会改方案），或发「完成」直接提交。`);
      }
      saved = await this.channel.download(message, this.store.pendingDir(user));
    } catch (error) {
      log('download failed', userTag(user), error?.message || error);
      return this.respond(message, '文件没收下来，请重发。');
    }
    log('file received', userTag(user), path.extname(saved), fs.statSync(saved).size);
    const auto = this.autoTarget(user, draft);
    const stage = auto ? 'collect' : draft.stage === 'idle' ? (draft.tier || draft.target ? 'collect' : 'tier') : draft.stage;
    const next = this.setDraft(user, { files: [...draft.files, saved], texts: caption ? [...draft.texts, caption] : draft.texts, stage, ...(auto && { target: auto.id }) });
    const got = `已收到「${path.basename(saved)}」${auto ? `，接着改 #${auto.id}（开新任务发 /新）` : ''}。`;
    if (stage === 'tier') return this.respond(message, `${got}\n${router.TIER_MENU}`);
    if (stage === 'planning') return this.respond(message, `${got}组长正在出方案，这个文件会留到下一步。`);
    return this.respond(message, `${got}（已收到${this.summaryOfDraft(next)}）${next.texts.length ? '发「开始」让组长出方案，或继续补充。' : '说说要做什么，再发「开始」。'}`);
  }

  chooseTier(message, draft, tier) {
    const user = message.from;
    const label = router.TIER_LABEL[tier];
    const estimate = runner.estimateText({ tier });
    if (draft.stage === 'review' && draft.reviewTask) {
      this.store.update(user, draft.reviewTask, { tier, estimateMinutes: null });
      return this.respond(message, `已改为${label}（${estimate}）。方案不变；有要改的直接说，满意就发「完成」。`);
    }
    if (draft.stage === 'planning') return this.respond(message, '组长正在出方案，方案出来后可以回数字 1、2、3 改档位。');
    if (draft.target) return this.respond(message, `接着改 #${draft.target} 时沿用原来的执行 AI，不能换档；要换档请 /2 退出后重新开始。`);
    const next = this.setDraft(user, { tier, stage: 'collect' });
    const has = next.texts.length || next.files.length;
    return this.respond(message, `已选${label}（${estimate}）。${has ? `已收到${this.summaryOfDraft(next)}，还要补充就继续发，发「开始」让组长出方案。` : '现在发需求和文件（可分多条），发完发「开始」。'}`);
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

  startPlanning(message, draft) {
    const user = message.from;
    if (!draft.texts.length) return this.respond(message, draft.files.length ? '还没说要做什么。发需求文字后再发「开始」。' : '还没有需求。先发需求或文件，再发「开始」。');
    const text = router.composeDraft(draft.texts);
    // 接着改老任务：不出方案，直接交给原执行者。
    if (draft.target) {
      const target = this.store.get(user, draft.target);
      this.store.clearDraft(user);
      if (!target || target.user !== user || !target.executor || target.archived) return this.respond(message, `#${draft.target} 不能接着改了，请重新开始。`);
      const limited = this.taskLimitReason(user);
      if (limited) return this.respond(message, limited);
      const newInputs = this.moveFiles(draft.files, this.store.taskDir(user, target.id));
      this.store.update(user, target.id, { status: 'queued', turns: (target.turns || 1) + 1, finishedAt: null, error: null, blocked: null, lastText: text });
      return this.enqueue({ id: target.id, user, continuation: { text, newInputs } }, message);
    }
    const today = this.store.data.tasks.filter((task) => task.user === user && this.now() - task.createdAt < DAY).length;
    if (today >= this.limits.tasksPerDay) return this.respond(message, `24 小时内已提交 ${today} 个任务，达到上限，明天再来。`);
    const task = this.store.create({ user, text, tier: draft.tier || 'mid', status: 'planning' });
    this.moveFiles(draft.files, this.store.taskDir(user, task.id));
    this.store.clearDraft(user);
    this.setDraft(user, { stage: 'planning', reviewTask: task.id, tier: task.tier });
    this.respond(message, `收到 #${task.id}（${router.TIER_LABEL[task.tier]}），组长正在出方案，约 1～3 分钟…`);
    return this.runPlanning(user, task.id);
  }

  revise(message, draft, feedback) {
    const user = message.from;
    const task = this.store.get(user, draft.reviewTask);
    if (!task) { this.store.clearDraft(user); return this.respond(message, '方案找不到了，请重新开始。'); }
    const newInputs = task.pendingInputs || [];
    this.store.update(user, task.id, { pendingInputs: [], revisions: (task.revisions || 0) + 1, feedback: [...(task.feedback || []), feedback] });
    this.setDraft(user, { stage: 'planning' });
    this.respond(message, `收到修改意见，组长正在改方案，约 1～2 分钟…`);
    return this.runPlanning(user, task.id, { feedback, newInputs });
  }

  async runPlanning(user, taskId, revision) {
    const controller = new AbortController();
    this.planning.set(user, { taskId, controller });
    const task = this.store.get(user, taskId);
    const result = await this.planTask({ task, dir: this.store.taskDir(user, taskId), signal: controller.signal, deps: this.deps(), revision });
    if (this.planning.get(user)?.controller === controller) this.planning.delete(user);
    if (controller.signal.aborted) return undefined;   // 用户取消了，cancelFlow 已经回复
    if (result.status !== 'planned') {
      log('plan', taskId, result.status, String(result.error || '').slice(0, 80));
      // 改方案失败：保留上一版方案继续看；第一次出方案就失败：任务结束，可 /重试。
      if (revision && task.plan) {
        this.setDraft(user, { stage: 'review' });
        return this.send(user, `改方案没成功（${friendlyError({ ...task, status: result.status, error: result.error, blocked: result.blocked }).replace(/[。]?可发.*$/, '')}）。上一版方案还在：可以换个说法再提，或发「完成」按上一版提交。`);
      }
      this.store.update(user, taskId, { status: result.status, error: result.error || null, blocked: result.blocked || null, sessions: result.sessions, finishedAt: this.now() });
      this.store.clearDraft(user);
      return this.send(user, `${STATUS_ICON[result.status] || '❌'} #${taskId} 组长没出成方案：${friendlyError(this.store.get(user, taskId))}`);
    }
    this.store.update(user, taskId, { status: 'review', plan: result.plan, brief: result.brief, estimateMinutes: result.estimateMinutes, sessions: result.sessions });
    this.setDraft(user, { stage: 'review', reviewTask: taskId });
    const fresh = this.store.get(user, taskId);
    log('plan', taskId, 'ready', `revisions=${fresh.revisions || 0}`);
    return this.send(user, [
      `📋 #${taskId} ${revision ? '修改后的' : ''}方案（${router.TIER_LABEL[fresh.tier]} · 执行预计${runner.estimateText(fresh)}）`,
      plainSummary(result.plan) || '（组长没写方案摘要）',
      '',
      '有要改的直接说；满意就发「完成」提交；/2 取消。',
    ].join('\n'));
  }

  confirm(message, draft) {
    const user = message.from;
    const task = this.store.get(user, draft.reviewTask);
    if (!task || !task.plan) { this.store.clearDraft(user); return this.respond(message, '没有等确认的方案，请重新开始。'); }
    const limited = this.taskLimitReason(user);
    if (limited) return this.respond(message, `${limited}方案先留着，稍后再发「完成」。`);
    this.store.clearDraft(user);
    this.store.update(user, task.id, { status: 'queued', confirmedAt: this.now() });
    return this.enqueue({ id: task.id, user }, message);
  }

  cancelFlow(user, draft) {
    const planning = this.planning.get(user);
    if (planning) { planning.controller.abort(new Error('cancelled')); this.planning.delete(user); }
    const taskId = draft.reviewTask;
    if (taskId && ['planning', 'review'].includes(this.store.get(user, taskId)?.status)) this.store.update(user, taskId, { status: 'cancelled', finishedAt: this.now() });
    this.store.clearDraft(user, { removeFiles: true });
    if (draft.stage === 'idle' && !draft.target) return '现在没有进行中的步骤。发需求或文件开始新任务；/0 查看全部命令。';
    return `已取消${taskId ? ` #${taskId}` : draft.target ? `（退出 #${draft.target}）` : ''}。发需求或文件重新开始。`;
  }

  enter(user, id) {
    const task = this.store.get(user, id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。发 /1 查看历史任务。`;
    if (task.archived) return `#${id} 的文件已过保留期清理，不能接着改了。`;
    if (!task.executor) return `#${id} 当时没执行（${STATUS_TEXT[task.status] || task.status}），发 /重试${id} 重做。`;
    if (this.isActive(user, id)) return `#${id} 还在执行，等它完成再接着改。`;
    const draft = this.draft(user);
    if (['planning', 'review'].includes(draft.stage)) return `你还有方案 #${draft.reviewTask} 没处理完：发「完成」提交或 /2 取消后再进入别的任务。`;
    this.store.clearDraft(user);
    this.setDraft(user, { target: id, stage: 'collect' });
    const lines = [`已进入 #${id}（${router.TIER_LABEL[task.tier] || ''} · ${executorLabel(task.executor)}）：${short(task.text, 40)}`];
    if (task.outputs?.length) lines.push(`成品：${task.outputs.join('、')}`);
    lines.push('发修改要求（可带新文件），发「开始」交给原来的执行 AI。/2 退出。');
    return lines.join('\n');
  }

  isActive(user, id) { const same = (job) => job.user === user && job.id === id; return Boolean(this.running && same(this.running.job)) || this.queue.some(same); }

  retry(message, id) {
    const user = message.from;
    const task = this.store.get(user, id);
    if (!task || task.user !== user) return this.respond(message, `没有 #${id} 这个任务。`);
    if (task.archived) return this.respond(message, `#${id} 的文件已过保留期清理，不能重试。`);
    if (task.status === 'succeeded') return this.respond(message, `#${id} 已经完成了。要修改发 /进${id}；没收到文件发 /重发${id}。`);
    if (this.isActive(user, id) || this.planning.get(user)?.taskId === id) return this.respond(message, `#${id} 还在进行中。`);
    if (task.status === 'review') return this.respond(message, `#${id} 的方案在等你确认：发「完成」提交。`);
    // 没出成方案的：重新出方案；有方案的：重新执行。
    if (!task.plan) {
      const draft = this.draft(user);
      if (['planning', 'review'].includes(draft.stage)) return this.respond(message, `你还有方案 #${draft.reviewTask} 没处理完，先发「完成」或 /2 取消。`);
      this.store.update(user, id, { status: 'planning', error: null, blocked: null, finishedAt: null, sessions: {} });
      this.setDraft(user, { stage: 'planning', reviewTask: id, tier: task.tier });
      this.respond(message, `#${id} 重新出方案，约 1～3 分钟…`);
      return this.runPlanning(user, id);
    }
    const limited = this.taskLimitReason(user);
    if (limited) return this.respond(message, limited);
    this.store.update(user, id, { status: 'queued', finishedAt: null, error: null, blocked: null, executor: null });
    return this.enqueue({ id, user }, message);
  }

  // 把任务 out/ 里的成品再发一次（只发给任务所有者）。
  async resend(message, id) {
    const user = message.from;
    const task = this.store.get(user, id);
    if (!task || task.user !== user) return this.respond(message, `没有 #${id} 这个任务。`);
    if (task.archived) return this.respond(message, `#${id} 的文件已过保留期清理。`);
    const outDir = path.join(this.store.taskDir(user, id), 'out');
    const files = runner.listFiles(outDir).map((name) => path.join(outDir, name));
    if (!files.length) return this.respond(message, `#${id} 没有成品文件。`);
    await this.respond(message, `正在重发 #${id} 的 ${files.length} 个文件…`);
    const results = await this.sendFiles(task.user, files);
    this.store.update(user, id, { deliveries: mergeDeliveries(task.deliveries, results) });
    return this.send(user, deliverySummary(results, id) || `#${id} 的文件已重发。`);
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
    const dir = path.join(this.store.userDir(user), 'ask');
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
      return this.respond(message, answer || '这个问题暂时没回答出来，稍后再试，或作为任务提交。');
    } finally {
      this.asking.delete(user);
      fs.rmSync(path.join(dir, 'last.log'), { force: true });
    }
  }

  // ---------- 执行 ----------

  enqueue(job, message) {
    const { user } = job;
    const task = this.store.get(user, job.id);
    const ahead = this.queue.length + (this.running ? 1 : 0);
    const what = job.continuation ? `接着改 #${task.id}（${executorLabel(task.executor)}）` : `已提交 #${task.id}（${router.TIER_LABEL[task.tier]}）`;
    const estimate = job.continuation ? '' : `，执行预计${runner.estimateText(task)}`;
    const text = ahead
      ? `${what}，前面还有 ${ahead} 个任务在执行，排队中${estimate}。做完主动通知你；现在可以发新任务。`
      : `${what}${estimate}。做完主动通知你；现在可以发新任务。`;
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
    const { user } = job;
    const task = this.store.get(user, job.id);
    const dir = this.store.taskDir(user, task.id);
    const startedAt = this.now();
    this.store.update(user, task.id, { status: 'running', startedAt });
    // 明显超出预估时提醒一次（不求准，只是让用户知道还在做）。
    const overdue = setTimeout(() => {
      this.send(job.user, `⏳ #${task.id} 比预估慢一些，还在做（已 ${duration(this.now() - startedAt)}）。不想等可以发 /停${task.id}。`);
    }, runner.overdueAfterMs(task));
    overdue.unref?.();
    let result;
    try {
      result = await this.executeTask({
        task, dir, signal, continuation: job.continuation,
        deps: this.deps({
          onStage: (stage, info) => {
            this.store.update(user, task.id, { status: stage, ...(info.executor && { executor: info.executor }) });
            if (info.switched) this.send(job.user, `#${task.id} ${executorLabel(info.executor)} 接手继续做…`);
          },
        }),
      });
    } finally {
      clearTimeout(overdue);
    }
    const finishedAt = this.now();
    const outputs = result.outputs.map((file) => path.basename(file));
    this.store.update(user, task.id, {
      status: result.status, executor: result.executor || task.executor, sessions: result.sessions,
      finishedAt, error: result.error || null, blocked: result.blocked || null,
      outputs: [...new Set([...(task.outputs || []), ...outputs])], summary: short(result.summary, 300),
    });
    log('task', task.id, result.status, result.executor?.provider || '', duration(finishedAt - startedAt), `outputs=${outputs.length}`);
    await this.deliver(this.store.get(user, task.id), result, finishedAt - startedAt);
  }

  sendFiles(user, files) {
    return deliverFiles({
      files, validate: this.validate, log: (...parts) => log('deliver', ...parts), now: this.now,
      send: (file) => this.channel.sendFile(user, file), retry: this.config.deliveryRetry,
    });
  }

  async deliver(task, result, elapsed) {
    const { user } = task;
    // 文件只发给任务所有者（task.user）。
    const results = await this.sendFiles(task.user, result.outputs);
    this.store.update(user, task.id, { deliveries: mergeDeliveries(task.deliveries, results) });
    for (const item of results) log('delivery', task.id, path.extname(item.name), item.status, `attempts=${item.attempts}`);
    if (result.status === 'succeeded' && this.config.sendPreview !== false) {
      const deck = result.outputs.find((file) => /\.pptx$/i.test(file) && results.find((r) => r.name === path.basename(file))?.status === 'sent');
      if (deck) await this.sendPreview(task.user, deck, task.id).catch((error) => log('preview failed', error?.message || error));
    }
    const meta = [router.TIER_LABEL[task.tier], executorLabel(task.executor), `用时 ${duration(elapsed)}`].filter(Boolean).join(' · ');
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
    if (task.status === 'succeeded') lines.push('要修改直接接着发；开新任务发 /新');
    await this.send(task.user, lines.join('\n'));
  }

  sendPreview(user, file, id) {
    const out = path.join(this.store.taskDir(user, id), 'work', 'preview');
    const env = { ...process.env, PATH: `/opt/agentdesk-office/bin:/opt/agentdesk-office/venv/bin:${process.env.PATH}`, HOME: path.join(this.store.taskDir(user, id), 'work') };
    return new Promise((resolve, reject) => {
      execFile('office-preview', [file, '1', out], { env, timeout: 120_000 }, (error, stdout) => {
        if (error) return reject(error);
        const image = stdout.trim().split('\n').pop();
        this.channel.sendImage(user, image).then(resolve, reject);
      });
    });
  }

  stop(user, id) {
    const task = this.store.get(user, id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。`;
    if (this.running?.job.id === id && this.running.job.user === user) {
      this.running.controller.abort(new Error('cancelled'));
      return `正在停止 #${id}…`;
    }
    const index = this.queue.findIndex((job) => job.id === id && job.user === user);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.store.update(user, id, { status: 'cancelled', finishedAt: this.now() });
      return `#${id} 已从队列移除。`;
    }
    const planning = this.planning.get(user);
    if (planning?.taskId === id || ['planning', 'review'].includes(task.status)) return this.cancelFlow(user, this.draft(user));
    return `#${id} 已经结束（${STATUS_TEXT[task.status] || task.status}）。`;
  }

  listText(user) {
    const tasks = this.store.recent(user, 10);
    if (!tasks.length) return '还没有任务。发需求或文件开始；/0 查看全部命令。';
    return '【最近任务】\n' + tasks.map((task) => {
      const took = task.finishedAt && task.startedAt ? ' ' + duration(task.finishedAt - task.startedAt) : '';
      const who = task.executor ? `${router.TIER_LABEL[task.tier] || ''}·${executorLabel(task.executor)}` : (router.TIER_LABEL[task.tier] || '');
      return `#${task.id} ${STATUS_ICON[task.status] || ''}${STATUS_TEXT[task.status] || ''} ${who}${took} ${short(task.text)}${task.archived ? '（已清理）' : ''}`;
    }).join('\n') + '\n\n/看编号 → 详情（例 /看12）\n/进编号 → 接着改（例 /进12）\n/重发编号 → 再发文件（例 /重发12）';
  }

  showText(user, id) {
    const task = this.store.get(user, id);
    if (!task || task.user !== user) return `没有 #${id} 这个任务。`;
    const lines = [
      `#${task.id} ${STATUS_ICON[task.status] || ''} ${STATUS_TEXT[task.status] || task.status}`,
      `需求：${short(task.text, 200)}`,
      `档位：${router.TIER_LABEL[task.tier] || '-'}　执行：${executorLabel(task.executor) || '-'}　预计：${runner.estimateText(task)}`,
      `轮次：${task.turns || 1}　方案修改：${task.revisions || 0} 次　开始：${task.startedAt ? new Date(task.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-'}`,
    ];
    if (task.plan) lines.push(`方案：${short(plainSummary(task.plan), 300)}`);
    if (task.outputs?.length) lines.push(`成品：${task.outputs.join('、')}`);
    const failed = (task.deliveries || []).filter((item) => item.status !== 'sent');
    if (failed.length) lines.push(`没发出去：${failed.map((item) => item.name).join('、')}（发 /重发${task.id}）`);
    if (task.summary) lines.push(`说明：${plainSummary(task.summary)}`);
    if (task.error && task.status !== 'succeeded') lines.push(friendlyError(task));
    if (task.archived) lines.push('（文件已按保留期清理）');
    return lines.join('\n');
  }

  gc() {
    // 任务文件和记录保留 30 天；没「开始」的草稿和没确认的方案 3 天后丢掉。
    const keep = this.config.retention || {};
    const days = keep.days ?? 30;
    const draftMs = (keep.draftDays ?? 3) * DAY;
    for (const task of this.store.data.tasks) {
      if (task.status === 'review' && this.now() - task.createdAt > draftMs) this.store.update(task.user, task.id, { status: 'cancelled', finishedAt: this.now() });
    }
    const removed = this.store.gc({ keepSucceededMs: days * DAY, keepFailedMs: days * DAY, keepPendingMs: draftMs, keepRecordsMs: days * DAY }, this.now());
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
    (failed.some((item) => item.status === 'failed') ? `。稍后发 /重发${id} 再试。` : '。');
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

// 个人微信 ClawBot 通道；还没扫码登录时返回 null。
function createChannel(config, onMessage) {
  const { IlinkChannel } = require('./ilink');
  const dir = config.dataDir;
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
  config.dataDir ||= path.join(config.stateDir, 'wechat');
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let service = null;
  const transport = createChannel(config, (message) => service?.onMessage(message));
  if (!transport) {
    // 个人微信还没扫码登录：等登录文件出现再启动（不退出，免得 systemd 反复重启）。
    log(`个人微信 ClawBot 尚未登录：运行 sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js --dir ${config.dataDir} 扫码，然后重启本服务`);
    setInterval(() => {}, 3600_000);
    return;
  }
  // 扫码登录 ClawBot 的人自动是管理员。
  if (transport.owner && !(config.allowUsers || []).includes(transport.owner)) config.allowUsers = [...(config.allowUsers || []), transport.owner];
  if (!config.allowUsers?.length) log('提示：allowUsers 为空，所有人都会被拒绝；日志里会打印被拒绝的 userid，登记后重启服务');
  const adapters = loadAdapters(orchestratorConfig);
  const quota = new QuotaGate({ adapters, quotaStatus: require('../quotas').quotaStatus, minRemaining: config.minQuotaPercent ?? 8 });
  // 扫码人是管理员；admins 里登记的也是。
  // ownerIsAdmin: false（给别人单独开的 ClawBot）：扫码人只是普通成员，不能选模型、不能操作电脑。
  if (transport.owner && config.ownerIsAdmin !== false) config.admins = [...new Set([...(config.admins || []), transport.owner])];
  const devices = config.devices === false ? null : new Devices({ config, socket: path.join(orchestratorConfig.stateDir, 'admin.sock'), log });
  const { RemoteTools } = require('./remote');
  const remote = devices && new RemoteTools({ socket: path.join(config.dataDir, 'remote.sock'), devices, log });
  remote?.listen();
  service = new WechatService({ config, adapters, channel: transport.channel, runAdapter: require('../adapters').runAdapter, quota, devices, remote });
  service.gc();
  if (devices) {
    // 等 ClawBot 连上再查第一次；之后每分钟查一次。
    setTimeout(() => service.watchDevices({ first: true }).catch((error) => log('device watch failed', error.message)), 15_000).unref();
    setInterval(() => service.watchDevices().catch((error) => log('device watch failed', error.message)), (config.deviceCheckSeconds || 60) * 1000).unref();
  }
  setInterval(() => { try { service.gc(); } catch (error) { log('gc failed', error.message); } }, 3600 * 1000).unref();
  transport.start();
  log(`wechat service started, channel: ilink, adapters: ${Object.keys(adapters).join(',')}, allowUsers: ${service.allowUsers.size}`);
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
