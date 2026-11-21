// Concurrency limit for direct chats (D15, Q6): at most 6 sessions on the whole machine and 4 per device may
// have a CLI process or a project mount running. A session that holds a slot keeps it however many processes
// it runs; a terminal (PTY) on the user's computer does not count.
//
// The state is a directory of small files, so that every process that runs a CLI or a mount (chat-server as
// the service account, the native seat host as root) can take part without a daemon:
//   active/<device>~<session>~<pid>   one file per process holding the session's slot
//   queue/<time>~<rand>               one ticket per waiting request, in arrival order
// A slot whose processes are all gone is freed by whoever looks next.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const GLOBAL_LIMIT = 6;
const DEVICE_LIMIT = 4;
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (code) => Object.assign(new Error(code), { code });

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || fail('aborted')); }, { once: true });
});

function sessionKey(session) {
  return SAFE.test(session) ? session : createHash('sha256').update(String(session)).digest('hex').slice(0, 40);
}

class SeatSlots {
  constructor({ directory, globalLimit = GLOBAL_LIMIT, deviceLimit = DEVICE_LIMIT, pollMs = 500, isAlive = alive, owner } = {}) {
    if (!directory) throw new Error('seat_slots_directory_required');
    this.directory = directory;
    this.globalLimit = globalLimit;
    this.deviceLimit = deviceLimit;
    this.pollMs = pollMs;
    this.isAlive = isAlive;
    this.held = new Map();
    this.active = path.join(directory, 'active');
    this.queue = path.join(directory, 'queue');
    for (const folder of [directory, this.active, this.queue]) fs.mkdirSync(folder, { recursive: true, mode: 0o770 });
    // The native seat host runs as root; hand the folders to the service account so its chat-servers can join.
    if (owner && process.getuid?.() === 0) for (const folder of [directory, this.active, this.queue]) {
      try { fs.chownSync(folder, owner.uid, owner.gid); } catch {}
    }
  }

  async withLock(action) {
    const lock = path.join(this.directory, '.lock');
    for (let attempt = 0; ; attempt++) {
      try { fs.mkdirSync(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmdirSync(lock); } catch {}
        if (attempt > 400) throw fail('seat_slots_lock_timeout');
        await sleep(25);
      }
    }
    try { return action(); }
    finally { try { fs.rmdirSync(lock); } catch {} }
  }

  read() {
    const active = new Map();
    for (const name of fs.readdirSync(this.active)) {
      const [device, session, pid] = name.split('~');
      if (!this.isAlive(Number(pid))) { try { fs.unlinkSync(path.join(this.active, name)); } catch {} continue; }
      active.set(device + '~' + session, { device, session });
    }
    const tickets = [];
    for (const name of fs.readdirSync(this.queue).sort()) {
      try {
        const ticket = JSON.parse(fs.readFileSync(path.join(this.queue, name), 'utf8'));
        if (!this.isAlive(ticket.pid)) { fs.unlinkSync(path.join(this.queue, name)); continue; }
        tickets.push({ ...ticket, name });
      } catch { try { fs.unlinkSync(path.join(this.queue, name)); } catch {} }
    }
    return { active, tickets };
  }

  // Counts as the limits do: one per session, by device and in total.
  status() {
    return this.withLock(() => {
      const { active, tickets } = this.read();
      const devices = {};
      for (const { device } of active.values()) devices[device] = (devices[device] || 0) + 1;
      return { total: active.size, devices, waiting: tickets.length, globalLimit: this.globalLimit, deviceLimit: this.deviceLimit };
    });
  }

  // Resolves with release() once the session has a slot. onQueued(position) reports the place in line while it waits.
  async acquire({ device, session, pid = process.pid, signal, onQueued = () => {} }) {
    if (!SAFE.test(device || '')) throw fail('invalid_seat_device');
    const key = sessionKey(session);
    const ticket = `${String(Date.now()).padStart(15, '0')}~${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(path.join(this.queue, ticket), JSON.stringify({ device, session: key, pid }), { flag: 'wx', mode: 0o660 });
    let reported = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const position = await this.withLock(() => {
          const { active, tickets } = this.read();
          const mine = device + '~' + key;
          const grant = () => {
            fs.writeFileSync(path.join(this.active, `${device}~${key}~${pid}`), '', { mode: 0o660 });
            fs.unlinkSync(path.join(this.queue, ticket));
            return 0;
          };
          if (active.has(mine)) return grant();
          // Walk the line in order and hand out the free slots; a later ticket does not jump an earlier one that fits.
          let total = active.size;
          const perDevice = {};
          for (const { device: owner } of active.values()) perDevice[owner] = (perDevice[owner] || 0) + 1;
          const granted = new Set(active.keys());
          let waiting = 0;
          for (const item of tickets) {
            const itemKey = item.device + '~' + item.session;
            if (granted.has(itemKey)) { if (item.name === ticket) return grant(); continue; }
            const fits = total < this.globalLimit && (perDevice[item.device] || 0) < this.deviceLimit;
            if (fits) {
              if (item.name === ticket) return grant();
              granted.add(itemKey);
              total += 1;
              perDevice[item.device] = (perDevice[item.device] || 0) + 1;
            } else {
              waiting += 1;
              if (item.name === ticket) return waiting;
            }
          }
          return 1;
        });
        if (!position) break;
        if (position !== reported) { reported = position; try { onQueued(position); } catch {} }
        await sleep(this.pollMs, signal);
      }
    } catch (error) {
      try { fs.unlinkSync(path.join(this.queue, ticket)); } catch {}
      throw error;
    }
    const file = `${device}~${key}~${pid}`;
    this.held.set(file, (this.held.get(file) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(file) || 1) - 1;
      if (left > 0) { this.held.set(file, left); return; }
      this.held.delete(file);
      try { fs.unlinkSync(path.join(this.active, file)); } catch {}
    };
  }
}

module.exports = { SeatSlots, GLOBAL_LIMIT, DEVICE_LIMIT };
