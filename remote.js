// 远程连接：Windows sshd + 反向隧道 + VPS 上的 Codex app-server（JSON-RPC over SSH stdio）
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const DIR = path.join(HOME, '.agentdesk');
const DEFAULTS = {
  host: '',
  tunnelUser: 'windows-tunnel',
  codexUser: 'codexdev',
  tunnelKey: path.join(DIR, 'tunnel_ed25519'),
  codexKey: path.join(DIR, 'codex_vps_ed25519'),
  knownHosts: path.join(HOME, '.ssh', 'known_hosts'),
  remoteForward: '127.0.0.1:2222:127.0.0.1:22',
  workspace: '/home/codexdev/.local/share/codex-vps/workspace/windows-dev',
  manageSshd: true,
  idleMinutes: 10,          // 空闲时断开 Codex，输入时自动重连
};
const SSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');

function loadConfig() {
  const f = path.join(DIR, 'remote.json');
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(DEFAULTS, null, 2)); } catch {} return { ...DEFAULTS }; }
}

const sshBase = (cfg, key) => [
  '-F', 'none', '-T',
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${cfg.knownHosts}`, '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
  '-i', key,
];

const sc = (...args) => new Promise((res) => execFile('sc.exe', args, { windowsHide: true, timeout: 8000 }, (err, out) => res({ err, out: String(out || '') })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Remote extends EventEmitter {
  constructor({ config, spawnProcess = spawn, service = sc, timing = {} } = {}) {
    super();
    this.cfg = config || loadConfig();
    if (process.env.AGENTDESK_IDLE_MIN) this.cfg.idleMinutes = +process.env.AGENTDESK_IDLE_MIN;
    this.spawnProcess = spawnProcess;
    this.service = service;
    this.timing = {
      handshake: 30000, request: 60000, heartbeat: 20000, heartbeatReply: 15000,
      tunnel: 30000, retry: [1000, 3000, 5000, 10000, 20000, 30000], ...timing,
    };
    this.state = { sshd: 'unknown', tunnel: 'idle', codex: 'idle', detail: '' };
    this.stopping = false;
    this.tunnelProc = null;
    this.codexProc = null;
    this.tunnelConnection = null;
    this.codexConnection = null;
    this.tunnelRetry = 0;
    this.codexRetry = 0;
    this.retryTimers = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.pendingReqs = new Set();
    this.activeTurns = new Set();
    this.readyWaiters = new Set();
    this.sleeping = false;
    this.lastActivity = Date.now();
    this.startId = 0;
    this.starting = null;
    this.idleTimer = setInterval(() => this.idleCheck(), 30000);
    this.idleTimer.unref?.();
  }

  touch() { this.lastActivity = Date.now(); }
  set(patch) { Object.assign(this.state, patch); this.emit('status', { ...this.state }); }

  cancelRetry(channel) {
    clearTimeout(this.retryTimers.get(channel));
    this.retryTimers.delete(channel);
  }

  scheduleRetry(channel, reason) {
    this.cancelRetry(channel);
    if (this.stopping || (channel === 'codex' && this.sleeping)) return;
    const attempt = channel === 'codex' ? this.codexRetry++ : this.tunnelRetry++;
    const delays = this.timing.retry;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    this.set({ [channel]: 'retry', detail: reason + '，' + Math.ceil(delay / 1000) + ' 秒后自动重连' });
    const timer = setTimeout(() => {
      this.retryTimers.delete(channel);
      if (channel === 'codex') this.startCodex();
      else this.startTunnel();
    }, delay);
    this.retryTimers.set(channel, timer);
    timer.unref?.();
  }

  start() {
    if (this.starting) return this.starting;
    this.stopping = false;
    const id = ++this.startId;
    const task = (async () => {
      if (!this.cfg.host) {
        this.set({ codex: 'error', detail: '请先在 ~/.agentdesk/remote.json 配置 VPS 地址并重启 AgentDesk' });
        return;
      }
      try { await this.ensureSshd(); } catch (error) {
        this.set({ sshd: 'failed', detail: error.message });
      }
      if (this.stopping || id !== this.startId) return;
      this.startTunnel();
      this.startCodex();
    })();
    this.starting = task;
    task.finally(() => { if (this.starting === task) this.starting = null; });
    return task;
  }

  async ensureSshd() {
    if (!this.cfg.manageSshd) return this.set({ sshd: 'external' });
    const q = await this.service('query', 'sshd');
    if (/RUNNING/.test(q.out)) return this.set({ sshd: 'running' });
    if (!/SERVICE_NAME/.test(q.out)) return this.set({ sshd: 'missing', detail: '未找到 sshd 服务' });
    this.set({ sshd: 'starting' });
    const r = await this.service('start', 'sshd');
    if (/拒绝|denied|5:/i.test(r.out) && !/START_PENDING|RUNNING/.test(r.out)) {
      return this.set({ sshd: 'denied', detail: '没有启动 sshd 的权限' });
    }
    for (let i = 0; i < 20 && !this.stopping; i++) {
      await sleep(300);
      if (/RUNNING/.test((await this.service('query', 'sshd')).out)) return this.set({ sshd: 'running' });
    }
    if (!this.stopping) this.set({ sshd: 'failed', detail: 'sshd 启动超时' });
  }

  startTunnel() {
    if (!this.cfg.host || this.stopping || this.tunnelConnection) return;
    this.cancelRetry('tunnel');
    if (!this.cfg.remoteForward) return this.set({ tunnel: 'external' });
    this.set({ tunnel: 'connecting' });
    const c = this.cfg;
    const args = [...sshBase(c, c.tunnelKey), '-v', '-N', '-o', 'ExitOnForwardFailure=yes',
      '-R', c.remoteForward, c.tunnelUser + '@' + c.host];
    let child;
    try { child = this.spawnProcess(SSH, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (error) { this.scheduleRetry('tunnel', error.message); return; }
    const connection = { child, output: '', ready: false };
    this.tunnelConnection = connection;
    this.tunnelProc = child;
    const fail = (reason) => this.dropTunnel(connection, reason);
    connection.timer = setTimeout(() => fail('隧道建立超时'), this.timing.tunnel);
    child.on('error', (error) => fail(error.message));
    child.on('exit', (code) => fail(this.exitReason(connection.output, code, '隧道断开')));
    child.on('close', (code) => fail(this.exitReason(connection.output, code, '隧道已关闭')));
    child.stderr.on('data', (data) => {
      if (this.tunnelConnection !== connection) return;
      connection.output = (connection.output + data).slice(-4096);
      // OpenSSH confirms that the server accepted the remote listening socket.
      if (!connection.ready && /remote forward success for:/i.test(connection.output)) {
        connection.ready = true;
        clearTimeout(connection.timer);
        this.tunnelRetry = 0;
        this.set({ tunnel: 'up', detail: '' });
      }
    });
  }

  exitReason(output, code, fallback) {
    if (/remote port forwarding failed/i.test(output)) return 'VPS 转发端口被占用';
    const message = output.trim().split(/\r?\n/).filter((line) => line && !/^debug\d:/.test(line)).pop();
    return message || fallback + '（退出码 ' + code + '）';
  }

  dropTunnel(connection, reason, retry = true) {
    if (this.tunnelConnection !== connection) return;
    this.tunnelConnection = null;
    this.tunnelProc = null;
    clearTimeout(connection.timer);
    try { connection.child.kill(); } catch {}
    if (retry) this.scheduleRetry('tunnel', reason);
  }

  startCodex() {
    if (!this.cfg.host || this.stopping || this.sleeping || this.codexConnection) return;
    this.cancelRetry('codex');
    this.set({ codex: 'connecting' });
    const c = this.cfg;
    let child;
    try {
      child = this.spawnProcess(SSH, [...sshBase(c, c.codexKey), c.codexUser + '@' + c.host],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { this.scheduleRetry('codex', error.message); return; }
    const connection = { child, output: '', buffer: '', ready: false, heartbeatPending: false };
    this.codexConnection = connection;
    this.codexProc = child;
    const fail = (reason) => this.dropCodex(connection, reason);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => this.onData(data, connection));
    child.stderr.on('data', (data) => { connection.output = (connection.output + data).slice(-2000); });
    child.stdin.on('error', (error) => fail('Codex 输入流已断开：' + error.message));
    child.on('error', (error) => fail(error.message));
    child.on('exit', (code) => fail(this.exitReason(connection.output, code, 'Codex 连接断开')));
    child.on('close', (code) => fail(this.exitReason(connection.output, code, 'Codex 连接已关闭')));
    this.request('initialize', {
      clientInfo: { name: 'agentdesk', title: 'AgentDesk', version: '0.2.7' },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    }, { timeoutMs: this.timing.handshake, connection, internal: true }).then((info) => {
      if (this.codexConnection !== connection) return;
      this.notify('initialized', {});
      connection.ready = true;
      this.info = info;
      this.codexRetry = 0;
      this.touch();
      this.set({ codex: 'ready', detail: '' });
      connection.heartbeat = setInterval(() => this.heartbeat(connection), this.timing.heartbeat);
      connection.heartbeat.unref?.();
      this.emit('codex-ready', info);
      for (const resolve of [...this.readyWaiters]) resolve(true);
    }).catch((error) => fail('Codex 握手失败：' + error.message));
  }

  heartbeat(connection) {
    if (this.codexConnection !== connection || !connection.ready || connection.heartbeatPending) return;
    connection.heartbeatPending = true;
    this.request('thread/list', { limit: 1 }, {
      connection, internal: true, timeoutMs: this.timing.heartbeatReply,
    }).catch(() => {}).finally(() => { connection.heartbeatPending = false; });
  }

  dropCodex(connection, reason, retry = true, sleeping = false) {
    if (this.codexConnection !== connection) return;
    this.codexConnection = null;
    this.codexProc = null;
    this.info = null;
    clearInterval(connection.heartbeat);
    for (const [id, request] of this.pending) {
      if (request.connection !== connection) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new Error(reason));
    }
    this.activeTurns.clear();
    this.pendingReqs.clear();
    try { connection.child.kill(); } catch {}
    if (sleeping) {
      this.set({ codex: 'sleeping', detail: '空闲连接已休眠，输入时自动重连' });
      this.emit('codex-sleep');
    } else {
      this.emit('codex-down');
      if (retry) this.scheduleRetry('codex', reason);
    }
  }

  onData(data, connection = this.codexConnection) {
    if (!connection || this.codexConnection !== connection) return;
    connection.buffer += data;
    let end;
    while ((end = connection.buffer.indexOf('\n')) >= 0) {
      const line = connection.buffer.slice(0, end).trim();
      connection.buffer = connection.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && message.method) {
        this.pendingReqs.add(message.id);
        this.emit('server-request', message);
      } else if (message.id != null) {
        const request = this.pending.get(message.id);
        if (!request || request.connection !== connection) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message || 'RPC 错误'), { data: message.error }));
        else request.resolve(message.result);
      } else if (message.method) {
        if (message.method === 'turn/started') this.activeTurns.add(message.params?.turn?.id);
        if (message.method === 'turn/completed') {
          this.activeTurns.delete(message.params?.turn?.id);
          this.touch();
        }
        if (message.method === 'serverRequest/resolved') this.pendingReqs.delete(message.params?.requestId);
        this.emit('notification', message);
      }
    }
  }

  write(message, connection = this.codexConnection) {
    if (!connection || this.codexConnection !== connection || connection.child.stdin.destroyed) throw new Error('Codex 未连接');
    connection.child.stdin.write(JSON.stringify(message) + '\n');
  }
  notify(method, params) { this.write({ method, params }); }

  request(method, params, { connection = this.codexConnection, internal = false, timeoutMs = this.timing.request } = {}) {
    if (!connection || (!internal && !connection.ready)) return Promise.reject(new Error('Codex 未连接'));
    if (!internal) this.touch();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.get(id)?.connection !== connection) return;
        // Never replay a timed-out mutation: its remote outcome is unknown.
        this.dropCodex(connection, 'Codex 请求超时（' + method + '），请检查上一操作的结果');
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, connection, internal });
      try { this.write({ id, method, params }, connection); } catch (error) {
        this.dropCodex(connection, error.message);
      }
    });
  }

  respond(id, result, error) {
    if (!this.pendingReqs.has(id)) return false;
    this.pendingReqs.delete(id);
    this.touch();
    this.write(error ? { id, error } : { id, result });
    return true;
  }

  idleCheck() {
    const idle = (this.cfg.idleMinutes || 0) * 60000;
    if (!idle || this.state.codex !== 'ready' || !this.codexConnection) return;
    if (this.activeTurns.size || this.pendingReqs.size) return;
    if ([...this.pending.values()].some((request) => !request.internal)) return;
    if (Date.now() - this.lastActivity < idle) return;
    this.sleeping = true;
    this.cancelRetry('codex');
    this.dropCodex(this.codexConnection, 'Codex 已休眠', false, true);
  }

  wake(timeoutMs = 45000) {
    this.touch();
    this.sleeping = false;
    if (this.codexConnection?.ready) return Promise.resolve(true);
    const result = new Promise((resolve) => {
      const finish = (ready) => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.readyWaiters.add(finish);
    });
    if (!this.codexConnection) {
      if (this.stopping) this.start();
      else this.startCodex();
    }
    return result;
  }

  async upload(dir, files) {
    if (!await this.wake()) throw new Error('Codex 连接超时，请重试上传');
    const made = new Set();
    const mk = async (directory) => {
      if (made.has(directory)) return;
      await this.request('fs/createDirectory', { path: directory, recursive: true });
      made.add(directory);
    };
    const out = [];
    for (const file of files) {
      const full = path.posix.join(dir, file.rel);
      await mk(path.posix.dirname(full));
      await this.request('fs/writeFile', { path: full, dataBase64: file.b64 });
      out.push(full);
    }
    return out;
  }

  reconnect() {
    this.cancelRetry('codex');
    this.cancelRetry('tunnel');
    this.codexRetry = 0;
    this.tunnelRetry = 0;
    this.sleeping = false;
    if (this.codexConnection) this.dropCodex(this.codexConnection, '正在重新连接', false);
    if (this.tunnelConnection) this.dropTunnel(this.tunnelConnection, '正在重新连接', false);
    this.set({ codex: 'connecting', tunnel: this.cfg.remoteForward ? 'connecting' : 'external', detail: '正在重新连接' });
    return this.start();
  }

  async stop() {
    this.stopping = true;
    this.startId++;
    this.starting = null;
    this.cancelRetry('codex');
    this.cancelRetry('tunnel');
    if (this.codexConnection) this.dropCodex(this.codexConnection, 'AgentDesk 已关闭', false);
    if (this.tunnelConnection) this.dropTunnel(this.tunnelConnection, 'AgentDesk 已关闭', false);
    for (const resolve of [...this.readyWaiters]) resolve(false);
    this.set({ codex: 'idle', tunnel: 'idle' });
    if (this.cfg.manageSshd && this.cfg.stopSshdOnExit !== false) await this.service('stop', 'sshd');
  }
}

module.exports = new Remote();
module.exports.Remote = Remote;
