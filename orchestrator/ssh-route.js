// 直连/跳板的线路选择、回退和直连探测。同一进程内按跳板配置和目标复用，
// 让 Codex、单聊和 Bridge 对“现在走哪条线”有一致判断。
const net = require('node:net');
const { classifySshFailure, isJumpConfigured, jumpSignature } = require('./ssh-options');

const PROBE_LEASE_MS = 90_000;
const SUSPENDED_RETRY_MS = 10 * 60_000;
const registry = new Map();

class SshRoute {
  constructor({ jump = null, mode, probeMinutes = 10, now = Date.now, log = () => {}, probe = null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this.jump = jump || null;
    this.mode = mode || this.jump?.mode || 'auto';
    this.jumpAvailable = isJumpConfigured(this.jump);
    this.probeMinutes = probeMinutes || this.jump?.probeMinutes || 10;
    this.now = now;
    this.log = log;
    this.probe = probe;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.active = this.mode === 'jump' && this.jumpAvailable ? 'jump' : 'direct';
    this.generation = 0;
    this.lastFailure = null;
    this.lastSwitchAt = 0;
    this.nextProbeAt = this.active === 'jump' && this.mode === 'auto' ? this.now() + this.probeInterval() : 0;
    this.probing = false;
    this.probeStartedAt = 0;
    this.probeToken = 0;
    this.suspended = false;
    this.timer = null;
    this.stopped = false;
    this.unavailableReason = this.jump?.unavailableReason || null;
    this.scheduleProbe();
  }

  probeInterval() {
    return Math.max(1, Number(this.probeMinutes) || 10) * 60_000;
  }

  setProbe(probe) {
    this.probe = typeof probe === 'function' ? probe : null;
    if (this.active === 'jump' && this.mode === 'auto' && !this.suspended) {
      if (!this.nextProbeAt) this.nextProbeAt = this.now() + this.probeInterval();
      this.scheduleProbe();
    }
    return this;
  }

  routeForAttempt() {
    if (this.stopped) return { route: 'direct', generation: this.generation };
    if (this.mode === 'jump' && this.jumpAvailable) return { route: 'jump', generation: this.generation };
    if (this.mode === 'direct' || !this.jumpAvailable) return { route: 'direct', generation: this.generation };
    // auto：当前在跳板时先继续用跳板；探测由计时器单独进行，不阻塞这次连接。
    if (this.active === 'jump') {
      if (!this.suspended && this.now() >= this.nextProbeAt) this.requestProbe();
      return { route: 'jump', generation: this.generation };
    }
    return { route: 'direct', generation: this.generation };
  }

  noteSuccess(route) {
    if (route !== 'direct' && route !== 'jump') return;
    if (route === 'jump' && !this.jumpAvailable) return;
    if (this.active !== route) {
      this.active = route;
      this.generation += 1;
      this.lastSwitchAt = this.now();
      this.log('ssh_route', { route, reason: 'connected', generation: this.generation });
    }
    this.lastFailure = null;
    if (route === 'direct') {
      this.suspended = false;
      this.nextProbeAt = 0;
      this.cancelProbe();
      return;
    }
    this.suspended = false;
    if (this.mode === 'auto') {
      if (!this.nextProbeAt) this.nextProbeAt = this.now() + this.probeInterval();
      this.scheduleProbe();
    }
  }

  noteFailure(route, failure) {
    const info = typeof failure === 'string' ? { kind: failure } : (failure || {});
    const kind = info.kind || 'unknown';
    this.lastFailure = { route, kind, jumpSide: Boolean(info.jumpSide), at: this.now() };
    if (route === 'direct') {
      if ((kind === 'transport' || kind === 'dns') && this.mode === 'auto' && this.jumpAvailable) {
        this.switchTo('jump', kind);
      }
      return;
    }
    if (route !== 'jump') return;
    if (kind === 'auth' || kind === 'hostkey') {
      this.suspend(kind);
      return;
    }
    if ((kind === 'transport' || kind === 'dns') && this.mode === 'auto') {
      if (!this.nextProbeAt) this.nextProbeAt = this.now() + this.probeInterval();
      this.scheduleProbe();
    }
  }

  switchTo(route, reason) {
    if (route === this.active) {
      if (route === 'jump' && this.mode === 'auto') this.scheduleProbe();
      return;
    }
    this.active = route;
    this.generation += 1;
    this.lastSwitchAt = this.now();
    this.log('ssh_route', { route, reason: reason || 'switch', generation: this.generation });
    if (route === 'jump') {
      this.suspended = false;
      this.nextProbeAt = this.now() + this.probeInterval();
      this.scheduleProbe();
    } else {
      this.suspended = false;
      this.nextProbeAt = 0;
      this.cancelProbe();
    }
  }

  suspend(reason) {
    if (this.suspended) return;
    this.suspended = true;
    this.nextProbeAt = 0;
    this.cancelProbe();
    this.log('ssh_route', { route: this.active, reason: reason || 'suspended' });
  }

  manualReconnect() {
    this.suspended = false;
    if (this.mode === 'auto' && this.active === 'jump' && this.jumpAvailable) {
      this.nextProbeAt = this.now();
      this.scheduleProbe();
    }
  }

  retryDelay() {
    return this.suspended ? SUSPENDED_RETRY_MS : null;
  }

  reset({ keepRoute = false } = {}) {
    this.cancelProbe();
    this.suspended = false;
    this.lastFailure = null;
    this.nextProbeAt = 0;
    if (!keepRoute) this.active = this.mode === 'jump' && this.jumpAvailable ? 'jump' : 'direct';
    this.generation += 1;
    if (this.active === 'jump' && this.mode === 'auto') this.nextProbeAt = this.now() + this.probeInterval();
    this.scheduleProbe();
  }

  stop() {
    this.stopped = true;
    this.cancelProbe();
  }

  cancelProbe() {
    this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.probeToken += 1;
    this.probing = false;
  }

  scheduleProbe() {
    this.clearTimeoutFn(this.timer);
    this.timer = null;
    if (this.stopped || !this.probe || this.mode !== 'auto' || !this.jumpAvailable ||
        this.active !== 'jump' || this.suspended) return false;
    if (!this.nextProbeAt) this.nextProbeAt = this.now() + this.probeInterval();
    const delay = Math.max(0, this.nextProbeAt - this.now());
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.requestProbe();
    }, delay);
    this.timer?.unref?.();
    return true;
  }

  requestProbe() {
    if (this.stopped || this.probing || !this.probe || this.mode !== 'auto' ||
        !this.jumpAvailable || this.active !== 'jump' || this.suspended) return false;
    if (this.now() < this.nextProbeAt) return false;
    const token = ++this.probeToken;
    this.probing = true;
    this.probeStartedAt = this.now();
    Promise.resolve()
      .then(() => this.probe())
      .then((ok) => {
        if (token !== this.probeToken || this.stopped) return;
        this.probing = false;
        this.noteProbeResult(Boolean(ok));
      })
      .catch(() => {
        if (token !== this.probeToken || this.stopped) return;
        this.probing = false;
        this.noteProbeResult(false);
      });
    return true;
  }

  async probeNow() {
    if (this.mode === 'auto' && this.active === 'jump' && !this.suspended) {
      this.nextProbeAt = this.now();
      if (this.requestProbe()) {
        const deadline = this.now() + PROBE_LEASE_MS;
        while (this.probing && this.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    return this.snapshot();
  }

  noteProbeResult(ok) {
    this.probing = false;
    if (ok) {
      this.switchTo('direct', 'probe');
      return;
    }
    this.lastFailure = { route: 'direct', kind: 'transport', jumpSide: false, at: this.now() };
    this.nextProbeAt = this.now() + this.probeInterval();
    this.scheduleProbe();
  }

  snapshot() {
    return {
      route: this.active,
      mode: this.mode,
      jumpAvailable: this.jumpAvailable,
      probing: this.probing,
      suspended: this.suspended,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      lastSwitchAt: this.lastSwitchAt,
      nextProbeAt: this.nextProbeAt,
      generation: this.generation,
      unavailableReason: this.unavailableReason,
    };
  }
}

function routeFor(jump, target = {}) {
  const configured = isJumpConfigured(jump);
  const suffix = `${target.host || ''}:${target.port || 22}`;
  const key = configured ? `${jumpSignature(jump)}|${suffix}` : `direct|${suffix}`;
  const cached = registry.get(key);
  if (cached && !cached.stopped) return cached;
  const route = new SshRoute({
    jump: configured ? jump : null,
    mode: configured ? jump.mode : 'direct',
    probeMinutes: configured ? jump.probeMinutes : 10,
  });
  if (!configured && jump?.unavailableReason) route.unavailableReason = jump.unavailableReason;
  registry.set(key, route);
  return route;
}

function probeTcpBanner(host, port, { timeoutMs = 5000, netModule = net } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      socket = netModule.connect({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.setTimeout?.(timeoutMs);
    socket.once('data', (data) => finish(String(data).startsWith('SSH-')));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function resetRoutes() {
  for (const route of registry.values()) route.stop();
  registry.clear();
}

module.exports = {
  PROBE_LEASE_MS,
  SUSPENDED_RETRY_MS,
  SshRoute,
  classifySshFailure,
  probeTcpBanner,
  resetRoutes,
  routeFor,
};