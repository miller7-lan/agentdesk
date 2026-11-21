const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { NATIVE_PROVIDERS } = require('./native-channel');

const providers = new Set(NATIVE_PROVIDERS);
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

// Authority is issued by the authenticated device and checked again on every local operation.
// A suspended writer retains its slot until its process/command status is reconciled.
class WindowsProjectLeases {
  constructor(journal) {
    this.leases = new Map();
    this.channels = new Map();
    this.reconciling = new Set();
    this.journal = journal;
    if (!journal) return;
    try {
      for (const lease of JSON.parse(disk.readFileSync(journal, 'utf8'))) {
        this.leases.set(lease.id, { ...lease, suspended: true, generation: (lease.generation || 1) + 1,
          ...(lease.fileOperation && { unknownFiles: true }), fileOperation: false });
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

  async acquire({ device, provider, threadId, root, fullAccess, projectId }) {
    if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('native_chat_platform_unsupported');
    if (!providers.has(provider) || ![device, threadId].every((part) => typeof part === 'string' &&
      part.length > 0 && part.length <= 160 && !/[\x00-\x1f]/.test(part))) throw new Error('invalid_native_chat_binding');
    const directory = await fs.realpath(root);
    const local = process.platform === 'win32' ? /^[A-Za-z]:\\.+/.test(directory) : path.isAbsolute(directory) && directory !== '/';
    if (!local || !(await fs.stat(directory)).isDirectory()) throw new Error('invalid_native_chat_project');
    // Windows and macOS folders are usually case-insensitive; Linux (tests) is not.
    const key = process.platform === 'linux' ? directory : directory.toLowerCase();
    const scope = JSON.stringify([device, provider, threadId, ...(projectId ? [projectId] : [])]);
    for (const lease of this.leases.values()) {
      if (lease.scope === scope) {
        if (lease.key !== key || lease.fullAccess !== (fullAccess === true)) throw new Error('native_chat_already_bound');
        return this.view(lease);
      }
      if (fullAccess === true && lease.fullAccess && overlap(key, lease.key)) throw new Error('native_project_writer_busy');
    }
    const id = randomBytes(32).toString('base64url');
    const lease = { id, key, scope, directory, device, provider, threadId, projectId, fullAccess: fullAccess === true,
      suspended: false, generation: 1, createdAt: new Date().toISOString() };
    this.leases.set(id, lease);
    try { this.save(); } catch (error) { this.leases.delete(id); throw error; }
    return this.view(lease);
  }

  view(lease) {
    return { id: lease.id, directory: lease.directory, suspended: lease.suspended, generation: lease.generation || 1,
      createdAt: lease.createdAt, unknownFiles: Boolean(lease.unknownFiles),
      state: this.reconciling.has(lease.id) ? 'reconciling' : lease.suspended ? 'suspended' : 'active' };
  }

  lookup(identity) {
    for (const lease of this.leases.values()) {
      if (['device', 'provider', 'threadId', 'projectId'].every((key) => lease[key] === identity[key]) &&
          lease.key === (process.platform === 'linux' ? identity.root : identity.root?.toLowerCase()) && lease.fullAccess === identity.fullAccess) return this.view(lease);
    }
    return null;
  }

  get(binding, { writable = false, allowSuspended = false, current = false } = {}) {
    const lease = this.leases.get(binding?.id);
    if (!lease || ['device', 'provider', 'threadId', 'projectId'].some((key) => binding[key] !== lease[key])) {
      throw new Error('native_chat_lease_denied');
    }
    if (current && binding.generation !== (lease.generation || 1)) throw new Error('native_chat_lease_expired');
    if (binding.generation !== undefined && binding.generation !== (lease.generation || 1)) throw new Error('native_chat_lease_expired');
    if (writable && !lease.fullAccess) throw new Error('native_chat_read_only');
    if (lease.suspended && !allowSuspended) throw new Error('native_chat_reconcile_required');
    return lease;
  }

  suspend(binding) {
    const lease = this.get(binding, { allowSuspended: true });
    lease.suspended = true;
    this.channels.get(lease.id)?.close();
    this.save();
    return this.view(lease);
  }

  promote(binding, threadId) {
    const lease = this.get(binding, { current: true });
    if (!lease.threadId.startsWith('pending-') || !/^[a-z0-9][a-z0-9-]{15,100}$/i.test(threadId)) {
      throw new Error('invalid_native_chat_binding');
    }
    const scope = JSON.stringify([lease.device, lease.provider, threadId, ...(lease.projectId ? [lease.projectId] : [])]);
    if ([...this.leases.values()].some((other) => other !== lease && other.scope === scope)) throw new Error('native_chat_already_bound');
    const old = { threadId: lease.threadId, scope: lease.scope };
    Object.assign(lease, { threadId, scope });
    try { this.save(); } catch (error) { Object.assign(lease, old); throw error; }
    return this.view(lease);
  }

  async settle(binding, reconcile, { release = false, acknowledgeFiles = false } = {}) {
    const lease = this.get(binding, { allowSuspended: true });
    if (this.reconciling.has(lease.id)) throw new Error('native_chat_reconcile_required');
    this.reconciling.add(lease.id);
    // Prevent a background command from starting while reconciliation is in flight.
    lease.suspended = true;
    try {
      const channel = this.channels.get(lease.id);
      if (channel) { channel.close(); await channel.done; }
      if (lease.unknownFiles && !acknowledgeFiles) return false;
      if (await reconcile(lease) !== true) return false;
      if (release) this.leases.delete(binding.id);
      else {
        lease.unknownFiles = false;
        lease.generation = (lease.generation || 1) + 1;
        lease.suspended = false;
      }
      try { this.save(); }
      catch (error) {
        lease.suspended = true;
        this.leases.set(binding.id, lease);
        throw error;
      }
      return true;
    } finally { this.reconciling.delete(lease.id); }
  }

  serveSftp(binding, input, output) {
    const lease = this.get(binding, { current: true });
    if (this.channels.has(lease.id)) throw new Error('native_project_mount_exists');
    const { createProjectSftp } = require('./sftp-project-write');
    let wrote = false;
    let clean = false;
    const channel = createProjectSftp({
      root: lease.directory,
      authorize: (write) => {
        if (this.leases.get(lease.id) !== lease || lease.generation !== binding.generation || lease.suspended ||
            (write && !lease.fullAccess)) throw Object.assign(new Error('native_chat_lease_denied'), { code: 'EACCES' });
        if (!write) return () => {};
        lease.fileOperation = true;
        this.save();
        return () => {
          wrote = true;
          lease.fileOperation = false;
          this.save();
        };
      },
    })(input, output);
    const done = channel.done.finally(() => {
      this.channels.delete(lease.id);
      if ((wrote && !clean) || lease.fileOperation) lease.unknownFiles = true;
      lease.fileOperation = false;
      lease.suspended = true;
      this.save();
    });
    done.catch(() => {});
    const mounted = { ...channel, done, verifiedClose: () => {
      if (lease.fileOperation) throw new Error('native_chat_reconcile_required');
      clean = true;
      channel.close();
    } };
    this.channels.set(lease.id, mounted);
    return mounted;
  }

  async completeSftp(binding) {
    const lease = this.get(binding, { current: true });
    const channel = this.channels.get(lease.id);
    if (!channel) return false;
    channel.verifiedClose();
    await channel.done;
    return true;
  }
}

module.exports = { WindowsProjectLeases };
