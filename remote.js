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

const sc = (...args) => new Promise((res) => execFile('sc.exe', args, { windowsHide: true }, (err, out) => res({ err, out: String(out || '') })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Remote extends EventEmitter {
  constructor() {
    super();
    this.cfg = loadConfig();
    if (process.env.AGENTDESK_IDLE_MIN) this.cfg.idleMinutes = +process.env.AGENTDESK_IDLE_MIN;   // 测试用
    this.state = { sshd: 'unknown', tunnel: 'idle', codex: 'idle', detail: '' };
    this.stopping = false;
    this.tunnelProc = null; this.codexProc = null;
    this.tunnelRetry = 0; this.codexRetry = 0;
    this.nextId = 1; this.pending = new Map(); this.buf = '';
    this.startedSshd = false;
    this.sleeping = false;
    this.lastActivity = Date.now();
    this.activeTurns = new Set();
    this.pendingReqs = new Set();
    this.readyWaiters = [];
    setInterval(() => this.idleCheck(), 30000).unref?.();
  }

  touch() { this.lastActivity = Date.now(); }

  idleCheck() {
    const idleMs = (this.cfg.idleMinutes || 0) * 60000;
    if (!idleMs || this.state.codex !== 'ready' || !this.codexProc) return;
    if (this.activeTurns.size || this.pendingReqs.size) return;
    if (Date.now() - this.lastActivity < idleMs) return;
    this.sleeping = true;
    this.codexProc.kill();
  }

  // 需要 Codex 时调用：休眠或断开时立即重连，并等待就绪
  wake(timeoutMs = 45000) {
    this.touch();
    if (this.state.codex === 'ready' && this.codexProc) return Promise.resolve(true);
    if (this.sleeping || (!this.codexProc && !this.stopping)) {
      this.sleeping = false; this.codexRetry = 0;
      this.startCodex();
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  set(patch) { Object.assign(this.state, patch); this.emit('status', { ...this.state }); }

  async start() {
    this.stopping = false;
    if (!this.cfg.host) return this.set({ codex: 'error', detail: '请先在 ~/.agentdesk/remote.json 配置 VPS 地址并重启 AgentDesk' });
    await this.ensureSshd();
    this.startTunnel();
    this.startCodex();
  }

  async ensureSshd() {
    if (!this.cfg.manageSshd) return this.set({ sshd: 'external' });
    const q = await sc('query', 'sshd');
    if (/RUNNING/.test(q.out)) return this.set({ sshd: 'running' });
    if (!/SERVICE_NAME/.test(q.out)) return this.set({ sshd: 'missing', detail: '未找到 sshd 服务' });
    this.set({ sshd: 'starting' });
    const r = await sc('start', 'sshd');
    if (/拒绝|denied|5:/i.test(r.out) && !/START_PENDING|RUNNING/.test(r.out)) return this.set({ sshd: 'denied', detail: '没有启动 sshd 的权限' });
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (/RUNNING/.test((await sc('query', 'sshd')).out)) { this.startedSshd = true; return this.set({ sshd: 'running' }); }
    }
    this.set({ sshd: 'failed', detail: 'sshd 启动超时' });
  }

  backoff(n) { return [1000, 3000, 5000, 10000, 20000, 30000][Math.min(n, 5)]; }

  startTunnel() {
    if (!this.cfg.host || this.stopping || this.tunnelProc) return;
    const c = this.cfg;
    if (!c.remoteForward) return this.set({ tunnel: 'external' });
    this.set({ tunnel: 'connecting' });
    const args = [...sshBase(c, c.tunnelKey), '-N', '-o', 'ExitOnForwardFailure=yes', '-R', c.remoteForward, `${c.tunnelUser}@${c.host}`];
    const p = spawn(SSH, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.tunnelProc = p;
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    // ssh -N 没有“已就绪”回显：2.5 秒内未退出即视为转发已建立
    const ok = setTimeout(() => { if (this.tunnelProc === p) { this.tunnelRetry = 0; this.set({ tunnel: 'up' }); } }, 2500);
    p.on('exit', (code) => {
      clearTimeout(ok);
      if (this.tunnelProc === p) this.tunnelProc = null;
      if (this.stopping) return this.set({ tunnel: 'idle' });
      const why = /remote port forwarding failed/i.test(err) ? 'VPS 端口 2222 被占用' : (err.trim().split('\n').pop() || `退出码 ${code}`);
      const wait = this.backoff(this.tunnelRetry++);
      this.set({ tunnel: 'retry', detail: `隧道断开：${why}，${Math.round(wait / 1000)} 秒后重连` });
      setTimeout(() => this.startTunnel(), wait);
    });
  }

  startCodex() {
    if (!this.cfg.host || this.stopping || this.codexProc) return;
    const c = this.cfg;
    this.set({ codex: 'connecting' });
    const p = spawn(SSH, [...sshBase(c, c.codexKey), `${c.codexUser}@${c.host}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.codexProc = p; this.buf = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => this.onData(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('exit', (code) => {
      if (this.codexProc === p) this.codexProc = null;
      for (const [, w] of this.pending) w.reject(new Error('Codex 连接已断开'));
      this.pending.clear();
      this.activeTurns.clear(); this.pendingReqs.clear();
      if (this.stopping) return this.set({ codex: 'idle' });
      if (this.sleeping) {
        this.set({ codex: 'sleeping', detail: `空闲 ${this.cfg.idleMinutes} 分钟，已断开以释放 VPS 内存；输入时自动重连` });
        this.emit('codex-sleep');
        return;
      }
      const wait = this.backoff(this.codexRetry++);
      this.set({ codex: 'retry', detail: `Codex 连接断开（${err.trim().split('\n').pop() || '退出码 ' + code}），${Math.round(wait / 1000)} 秒后重连` });
      this.emit('codex-down');
      setTimeout(() => this.startCodex(), wait);
    });
    // 握手超时（网络抖动时连接可能半开、永远等不到响应）→ 杀掉进程，走上面的自动重连
    const initTimer = setTimeout(() => {
      if (this.codexProc === p && this.state.codex !== 'ready') { err += '\n握手超时'; try { p.kill(); } catch {} }
    }, 30000);
    this.request('initialize', {
      clientInfo: { name: 'agentdesk', title: 'AgentDesk', version: '0.2.4' },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    }).then((r) => {
      clearTimeout(initTimer);
      if (this.codexProc !== p) return;
      this.notify('initialized', {});
      this.codexRetry = 0;
      this.info = r;
      this.set({ codex: 'ready', detail: '' });
      this.emit('codex-ready', r);
      this.readyWaiters.splice(0).forEach((f) => f());
    }).catch((e) => { clearTimeout(initTimer); if (this.codexProc === p) this.set({ codex: 'error', detail: String(e.message || e) }); });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && m.method) { this.pendingReqs.add(m.id); this.emit('server-request', m); }   // 需要用户回应（审批等）
      else if (m.id != null) {                                                // 对我们请求的响应
        const w = this.pending.get(m.id); if (!w) continue;
        this.pending.delete(m.id);
        m.error ? w.reject(Object.assign(new Error(m.error.message || 'RPC 错误'), { data: m.error })) : w.resolve(m.result);
      } else if (m.method) {
        if (m.method === 'turn/started') this.activeTurns.add(m.params?.turn?.id);
        else if (m.method === 'turn/completed') { this.activeTurns.delete(m.params?.turn?.id); this.touch(); }
        this.emit('notification', m);
      }
    }
  }

  write(m) {
    if (!this.codexProc) throw new Error('Codex 未连接');
    this.codexProc.stdin.write(JSON.stringify(m) + '\n');
  }
  notify(method, params) { this.write({ method, params }); }
  request(method, params) {
    this.touch();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  respond(id, result, error) { this.pendingReqs.delete(id); this.touch(); this.write(error ? { id, error } : { id, result }); }

  // 通过 app-server 的 fs 接口把文件写到 VPS（codexdev 用户目录内）
  async upload(dir, files) {
    await this.wake();
    const made = new Set();
    const mk = async (d) => { if (made.has(d)) return; await this.request('fs/createDirectory', { path: d, recursive: true }); made.add(d); };
    const out = [];
    for (const f of files) {
      const full = path.posix.join(dir, f.rel);
      await mk(path.posix.dirname(full));
      await this.request('fs/writeFile', { path: full, dataBase64: f.b64 });
      out.push(full);
    }
    return out;
  }

  reconnect() {
    this.tunnelRetry = 0; this.codexRetry = 0; this.sleeping = false;
    if (this.tunnelProc) this.tunnelProc.kill(); else this.startTunnel();
    if (this.codexProc) this.codexProc.kill(); else this.startCodex();
  }

  async stop() {
    this.stopping = true;
    try { this.codexProc && this.codexProc.kill(); } catch {}
    try { this.tunnelProc && this.tunnelProc.kill(); } catch {}
    // sshd 只服务于这条回环隧道：AgentDesk 退出时一并停止（remote.json 里 stopSshdOnExit=false 可关闭）
    if (this.cfg.manageSshd && this.cfg.stopSshdOnExit !== false) await sc('stop', 'sshd');
  }
}

module.exports = new Remote();
