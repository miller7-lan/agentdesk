// 单聊连接：每个 AI 一条独立 SSH 连接，跑 VPS 上的 chat-server。
// 协议是 Codex app-server 的兼容子集，空闲 10 分钟休眠，下次输入自动唤醒。
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./remote');
const { SSH, buildSshInvocation, classifySshFailure, normalizeJump } = require('./orchestrator/ssh-options');
const { routeFor } = require('./orchestrator/ssh-route');

const DIR = path.join(os.homedir(), '.agentdesk');
const AGENTS = new Set(['claude', 'grok', 'antigravity']);
const DEFAULTS = {
  chatUser: 'agentdesk',
  chatScript: '/opt/agentdesk-orchestrator/agent-chat.sh',
  claudeKey: path.join(DIR, 'keys', 'claude_ed25519'),
  grokKey: path.join(DIR, 'keys', 'grok_ed25519'),
  antigravityKey: path.join(DIR, 'keys', 'antigravity_ed25519'),
};

class ChatLink extends EventEmitter {
  constructor({ agent, config, spawnProcess = spawn, timing = {} } = {}) {
    super();
    if (!AGENTS.has(agent)) throw new Error('unknown_chat_agent');
    this.agent = agent;
    this.cfg = { ...DEFAULTS, ...loadConfig(), ...(config || {}) };
    this.cfg.jump = normalizeJump(this.cfg.jump, { checkFiles: true });
    this.key = this.cfg[agent + 'Key'];
    this.user = this.cfg[agent + 'User'] || this.cfg.chatUser;
    this.route = config?.route || routeFor(this.cfg.jump, { host: this.cfg.host, port: this.cfg.port || 22 });
    this.spawnProcess = spawnProcess;
    this.timing = {
      handshake: 30_000,
      request: 60_000,
      retry: [1000, 3000, 5000, 10_000, 20_000, 30_000],
      ...timing,
    };
    this.idleMinutes = Number(process.env.AGENTDESK_CHAT_IDLE_MIN || this.cfg.idleMinutes || 10);
    this.state = 'idle';
    this.detail = '';
    this.info = null;
    this.child = null;
    this.ready = false;
    this.auto = false;
    this.stopping = false;
    this.retryDelay = 0;
    this.retryTimer = null;
    this.idleTimer = null;
    this.exitPending = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverIds = new Set();
    this.activeTurns = new Set();
    this.readyWaiters = new Set();
  }

  status() {
    return { agent: this.agent, state: this.state, detail: this.detail, route: this.route.snapshot() };
  }

  set(state, detail = '') {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('status', this.status());
  }

  clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  scheduleRetry(reason, fast = false) {
    if (this.stopping || !this.auto || this.retryTimer) return;
    const suspended = this.route?.retryDelay?.();
    const delay = fast
      ? 50 + Math.round(Math.random() * 200)
      : suspended || this.timing.retry[Math.min(this.retryDelay, this.timing.retry.length - 1)];
    this.retryDelay += 1;
    this.set('retry', `${reason}，${Math.ceil(delay / 1000)} 秒后重连`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  configError() {
    if (this.cfg.configError) return this.cfg.configError;
    if (!this.cfg.host) return '请先配置 VPS 地址（~/.agentdesk/mac-remote.json）';
    if (!this.key) return '缺少单聊密钥配置';
    if (!this.user) return '缺少单聊 SSH 用户';
    return null;
  }

  start() {
    if (this.stopping || this.child || this.ready) return;
    const problem = this.configError();
    if (problem) {
      this.set('error', problem);
      for (const resolve of [...this.readyWaiters]) resolve(false);
      return;
    }
    if (this.exitPending) {
      const pending = this.exitPending;
      pending.then(() => { if (!this.child && this.auto) this.start(); });
      return;
    }
    this.clearRetry();
    this.set('connecting');
    this.detail = '';
    const command = `${this.cfg.chatScript} ${this.agent}`;
    const choice = this.route.routeForAttempt();
    let invocation;
    try {
      invocation = buildSshInvocation({
        cfg: this.cfg, key: this.key, port: this.cfg.port || 22,
        target: `${this.user}@${this.cfg.host}`, targetHost: this.cfg.host,
        route: choice.route, afterTarget: [command], jump: this.cfg.jump,
      });
    } catch (error) {
      this.stderr = error.message;
      this.route.noteFailure(choice.route, classifySshFailure({ stderr: error.message, route: choice.route }));
      this.drop(null, '无法准备 SSH：' + error.message);
      return;
    }
    let child;
    try {
      child = this.spawnProcess(SSH, invocation.args, {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...invocation.env },
      });
    } catch (error) {
      this.stderr = error.message;
      this.route.noteFailure(choice.route, classifySshFailure({ stderr: error.message, route: choice.route }));
      this.drop(null, '无法启动 SSH：' + error.message);
      return;
    }
    this.child = child;
    child.__route = choice.route;
    child.__routeGeneration = choice.generation;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    this.buffer = '';
    this.stderr = '';
    child.stdout.once('data', () => this.route.noteSuccess(choice.route));
    child.stdout.on('data', (data) => this.onData(child, data));
    child.stderr.on('data', (data) => {
      if (this.child !== child) return;
      this.stderr = (this.stderr + data).slice(-8000);
    });
    const routeFailure = (code) => this.noteRouteFailure(child, choice, code);
    child.stdin.on('error', (error) => this.drop(child, '单聊输入流已断开：' + error.message));
    child.on('error', (error) => {
      this.stderr = (this.stderr + '\n' + error.message).slice(-8000);
      routeFailure(null);
      this.drop(child, 'SSH 启动失败：' + error.message);
    });
    child.on('close', (code) => {
      routeFailure(code);
      this.drop(child, this.exitReason(code));
    });
    child.on('exit', (code) => {
      // close follows; keep the reason from stderr but do not wait for it indefinitely.
      if (this.child === child && !child.__exitSeen) {
        child.__exitSeen = true;
        routeFailure(code);
        this.drop(child, this.exitReason(code));
      }
    });

    this.request('initialize', {
      clientInfo: { name: 'agentdesk', title: 'AgentDesk', version: require('./package.json').version },
      capabilities: {},
    }, { internal: true, timeoutMs: this.timing.handshake }).then((info) => {
      if (this.child !== child) return;
      this.ready = true;
      this.info = info;
      this.retryDelay = 0;
      this.set('ready');
      this.touch();
      for (const resolve of [...this.readyWaiters]) resolve(true);
      this.readyWaiters.clear();
      this.emit('ready', info);
    }).catch((error) => {
      if (this.child === child) this.drop(child, '单聊握手失败：' + error.message);
    });
  }

  exitReason(code) {
    const lines = String(this.stderr || '').split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^debug\d:/.test(line));
    const detail = lines.slice(-1)[0];
    return detail || `单聊连接已断开（退出码 ${code ?? '—'}）`;
  }

  noteRouteFailure(child, choice, code) {
    if (!child || child.__routeNoted) return;
    child.__routeNoted = true;
    const info = classifySshFailure({ stderr: this.stderr, code, route: choice.route });
    if (info.kind === 'unknown' && !String(this.stderr || '').trim()) return;
    this.route.noteFailure(choice.route, info);
  }

  drop(child, reason, { sleeping = false, retry = true } = {}) {
    if (child && this.child !== child) return;
    const current = this.child;
    if (!current && !sleeping && this.state !== 'connecting') {
      if (!this.ready) return;
    }
    if (current && !retry) current.__routeNoted = true;
    this.child = null;
    this.ready = false;
    this.info = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.activeTurns.clear();
    this.serverIds.clear();
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new Error(reason));
    }
    for (const resolve of [...this.readyWaiters]) resolve(false);
    this.readyWaiters.clear();
    if (current) {
      const pendingExit = new Promise((resolve) => {
        let done = false;
        const settle = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(settle, 5000);
        timer.unref?.();
        current.once('close', settle);
        current.once('exit', settle);
      });
      this.exitPending = pendingExit;
      // 清掉自己之后再让排队的 start() 继续，否则 start() 会一直看到已完成的 exitPending 并空转。
      pendingExit.then(() => { if (this.exitPending === pendingExit) this.exitPending = null; });
      try { current.stdin.end(); } catch {}
      try { current.kill(); } catch {}
      setTimeout(() => { try { current.kill('SIGKILL'); } catch {} }, 3000).unref?.();
    }
    if (sleeping) {
      this.auto = false;
      this.set('sleeping', '空闲连接已休眠，输入时自动唤醒');
      this.emit('sleep');
      return;
    }
    this.set(retry && this.auto ? 'retry' : 'error', reason);
    this.emit('down', { agent: this.agent, message: reason });
    const switched = current?.__routeGeneration !== undefined && current.__routeGeneration !== this.route.generation;
    if (retry && this.auto) this.scheduleRetry(reason, switched);
  }

  wake(timeoutMs = 45_000) {
    this.auto = true;
    this.stopping = false;
    this.clearRetry();
    if (this.ready) return Promise.resolve(true);
    if (!this.child) this.start();
    if (this.state === 'error' && this.configError()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (ready) => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.readyWaiters.add(finish);
    });
  }

  reconnect() {
    this.auto = true;
    this.stopping = false;
    this.clearRetry();
    this.retryDelay = 0;
    this.route.manualReconnect();
    const child = this.child;
    if (child) this.drop(child, '正在重新连接', { retry: false });
    this.set('connecting', '正在重新连接');
    this.start();
    return true;
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (!this.ready || this.idleMinutes <= 0) return;
    this.idleTimer = setTimeout(() => this.sleep(), this.idleMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  sleep() {
    if (!this.ready) return;
    if (this.activeTurns.size || this.pending.size) { this.touch(); return; }
    const child = this.child;
    if (child) this.drop(child, '空闲连接已休眠', { sleeping: true, retry: false });
  }

  onData(child, data) {
    if (this.child !== child) return;
    this.buffer += data;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      if (message.id != null && message.method) {
        this.serverIds.add(message.id);
        this.emit('server-request', {
          agent: this.agent, id: message.id, method: message.method, params: message.params || {},
        });
        continue;
      }
      if (message.id != null) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message || 'RPC 错误'), { data: message.error }));
        else request.resolve(message.result);
        continue;
      }
      if (typeof message.method !== 'string') continue;
      if (message.method === 'turn/started') this.activeTurns.add(message.params?.turn?.id);
      if (message.method === 'turn/completed') {
        this.activeTurns.delete(message.params?.turn?.id);
        this.touch();
      }
      this.emit('event', { agent: this.agent, method: message.method, params: message.params || {} });
    }
    if (this.buffer.length > 16 * 1024 * 1024) this.drop(child, '单聊输出超过上限');
  }

  write(message) {
    const child = this.child;
    if (!child || !this.ready && message.method !== 'initialize') throw new Error('单聊未连接');
    if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error('单聊连接已关闭');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, { internal = false, timeoutMs = this.timing.request } = {}) {
    const child = this.child;
    if (!child || (!internal && !this.ready)) return Promise.reject(new Error('单聊未连接'));
    if (!internal) this.touch();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.get(id)?.child !== child) return;
        // 结果未知的变更请求不重放：断开连接，让界面明确提示用户。
        this.drop(child, `单聊请求超时（${method}），请检查上一操作的结果`);
      }, timeoutMs);
      // The request's own timeout must keep the loop alive: nothing else may be
      // holding the process while a call is in flight (e.g. in tests).
      this.pending.set(id, { resolve, reject, timer, child });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        this.drop(child, error.message);
      }
    });
  }

  respond(id, result, error) {
    if (!this.serverIds.has(id)) return false;
    this.serverIds.delete(id);
    this.write({ id, ...(error ? { error } : { result }) });
    this.touch();
    return true;
  }

  stop() {
    this.stopping = true;
    this.auto = false;
    this.clearRetry();
    const child = this.child;
    if (child) this.drop(child, 'AgentDesk 已关闭', { sleeping: true, retry: false });
    this.set('idle', '');
  }
}

module.exports = { ChatLink, AGENTS };