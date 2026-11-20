const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const providers = new Set(['codex', 'claude']);
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

// Authority is issued by the authenticated device and checked again on every local operation.
// A suspended writer retains its slot until its process/command status is reconciled.
class WindowsProjectLeases {
  constructor(journal) {
    this.leases = new Map();
    this.journal = journal;
    if (!journal) return;
    try {
      for (const lease of JSON.parse(disk.readFileSync(journal, 'utf8'))) {
        this.leases.set(lease.id, { ...lease, suspended: true });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save() {
    if (!this.journal) return;
    const temporary = this.journal + '.' + randomBytes(12).toString('hex');
    try {
      disk.writeFileSync(temporary, JSON.stringify([...this.leases.values()]), { flag: 'wx', mode: 0o600 });
      disk.renameSync(temporary, this.journal);
    } finally { try { disk.unlinkSync(temporary); } catch {} }
  }

  async acquire({ device, provider, threadId, root, fullAccess }) {
    if (process.platform !== 'win32') throw new Error('windows_native_chat_required');
    if (!providers.has(provider) || ![device, threadId].every((part) => typeof part === 'string' &&
      part.length > 0 && part.length <= 160 && !/[\x00-\x1f]/.test(part))) throw new Error('invalid_native_chat_binding');
    const directory = await fs.realpath(root);
    if (!/^[A-Za-z]:\\.+/.test(directory) || !(await fs.stat(directory)).isDirectory()) {
      throw new Error('invalid_native_chat_project');
    }
    const key = directory.toLowerCase();
    const scope = JSON.stringify([device, provider, threadId]);
    for (const lease of this.leases.values()) {
      if (lease.scope === scope) {
        if (lease.key !== key || lease.fullAccess !== (fullAccess === true)) throw new Error('native_chat_already_bound');
        return { id: lease.id, directory: lease.directory, suspended: lease.suspended };
      }
      if (fullAccess === true && lease.fullAccess && overlap(key, lease.key)) throw new Error('native_project_writer_busy');
    }
    const id = randomBytes(32).toString('base64url');
    const lease = { id, key, scope, directory, device, provider, threadId, fullAccess: fullAccess === true, suspended: false };
    this.leases.set(id, lease);
    try { this.save(); } catch (error) { this.leases.delete(id); throw error; }
    return { id, directory };
  }

  get(binding, { writable = false, allowSuspended = false } = {}) {
    const lease = this.leases.get(binding?.id);
    if (!lease || ['device', 'provider', 'threadId'].some((key) => binding[key] !== lease[key])) {
      throw new Error('native_chat_lease_denied');
    }
    if (writable && !lease.fullAccess) throw new Error('native_chat_read_only');
    if (lease.suspended && !allowSuspended) throw new Error('native_chat_reconcile_required');
    return lease;
  }

  suspend(binding) {
    this.get(binding, { allowSuspended: true }).suspended = true;
  }

  async settle(binding, reconcile, { release = false } = {}) {
    const lease = this.get(binding, { allowSuspended: true });
    // Prevent a background command from starting while reconciliation is in flight.
    lease.suspended = true;
    const confirmed = await reconcile(lease);
    if (this.leases.get(binding.id) !== lease || confirmed !== true) return false;
    if (release) {
      this.leases.delete(binding.id);
      try { this.save(); } catch (error) { this.leases.set(binding.id, lease); throw error; }
    } else lease.suspended = false;
    return true;
  }
}

module.exports = { WindowsProjectLeases };
