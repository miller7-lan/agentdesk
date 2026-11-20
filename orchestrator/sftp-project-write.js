const fs = require('node:fs/promises');
const { constants: C } = require('node:fs');
const path = require('node:path').win32;
const { randomUUID } = require('node:crypto');
const { Reader, packet, u32, u64, str, T, S } = require('./sftp-readonly');
const { startGuard } = require('./windows-path-guard');

const FLAGS = { READ: 1, WRITE: 2, APPEND: 4, CREATE: 8, TRUNCATE: 16, EXCLUSIVE: 32 };
const META = { SIZE: 1, MODE: 4, TIMES: 8 };
const MAX_CHUNK = 64 * 1024;
const MAX_HANDLES = 256;
const badName = /[\\:\x00-\x1f<>|"?*]|[. ]$|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
const fail = (code, message) => Object.assign(new Error(message), { code });

class Fields {
  constructor(data) { this.data = data; this.offset = 0; }
  take(length) {
    const end = this.offset + length;
    if (end > this.data.length) throw fail('EBADMSG', 'invalid_sftp_packet');
    const slice = this.data.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }
  u32() { return this.take(4).readUInt32BE(); }
  offset64() {
    const offset = this.take(8).readBigUInt64BE();
    if (offset > BigInt(Number.MAX_SAFE_INTEGER - MAX_CHUNK)) throw fail('EBADMSG', 'invalid_sftp_offset');
    return Number(offset);
  }
  bytes() { return this.take(this.u32()); }
  text() {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes()); }
    catch { throw fail('EBADMSG', 'invalid_sftp_string'); }
  }
  metadata() {
    const flags = this.u32();
    if (flags & ~(META.SIZE | META.MODE | META.TIMES)) throw fail('ENOTSUP', 'unsupported_sftp_attributes');
    return {
      ...(flags & META.SIZE && { size: this.offset64() }),
      ...(flags & META.MODE && { mode: this.u32() & 0o777 }),
      ...(flags & META.TIMES && { times: [this.u32(), this.u32()] }),
    };
  }
}

const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
async function statPath(filename) {
  const stat = await fs.lstat(filename, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) {
    throw fail('EACCES', 'project_path_denied');
  }
  return stat;
}
function attrs(stat) {
  return Buffer.concat([u32(META.SIZE | META.MODE | META.TIMES), u64(stat.isDirectory() ? 0 : stat.size),
    u32(Number(stat.mode)), u32(Math.floor(Number(stat.atimeMs) / 1000)), u32(Math.floor(Number(stat.mtimeMs) / 1000))]);
}

function createProjectSftp({ root }) {
  if (process.platform !== 'win32') throw new Error('project_sftp_windows_required');
  const base = path.resolve(root);
  if (!/^[A-Za-z]:\\.+/.test(base)) throw new Error('project_sftp_requires_local_directory');
  const resolve = (input, projectRootAllowed = true) => {
    const names = [];
    for (const name of input.split('/')) {
      if (!name || name === '.') continue;
      if (name === '..') {
        if (!names.length) throw fail('EACCES', 'outside_project');
        names.pop();
      } else {
        if (badName.test(name)) throw fail('EACCES', 'invalid_windows_project_path');
        names.push(name);
      }
    }
    if (!names.length && !projectRootAllowed) throw fail('EACCES', 'project_root_protected');
    return { name: '/' + names.join('/'), file: path.join(base, ...names) };
  };
  const parent = ({ file }) => file === base ? base : path.dirname(file);

  return function serve(input, output) {
    const guard = startGuard();
    const reader = new Reader();
    const handles = new Map();
    const observed = new Map();
    let closed = false;
    const send = (type, ...parts) => {
      if (!closed && !output.destroyed) output.write(packet(type, parts));
    };
    const status = (id, code, description = '') => send(T.STATUS, u32(id), u32(code), str(description), str(''));
    const remember = (target, stat) => {
      const key = target.file.toLowerCase();
      observed.delete(key);
      observed.set(key, signature(stat));
      if (observed.size > 4096) observed.delete(observed.keys().next().value);
    };
    const verify = (target, stat, expected = observed.get(target.file.toLowerCase())) => {
      if (expected !== undefined && (!stat || signature(stat) !== expected)) {
        throw fail('ECONFLICT', 'project_file_changed: ' + target.name);
      }
    };
    const pin = (target, optional, action) =>
      guard.withPaths([parent(target)], { path: target.file, directory: false, optional }, action);
    const handle = (fields, kind) => {
      const entry = handles.get(fields.text());
      if (!entry || (kind && entry.kind !== kind)) throw fail('EBADMSG', 'invalid_sftp_handle');
      return entry;
    };
    const newHandle = (id, entry) => {
      const key = randomUUID();
      handles.set(key, entry);
      send(T.HANDLE, u32(id), str(key));
    };
    const update = async (entry, action) => {
      if (!entry.writable) throw fail('EACCES', 'handle_is_read_only');
      if (entry.failed) throw fail('ECONFLICT', 'project_write_outcome_unknown: ' + entry.target.name);
      await pin(entry.target, false, async () => {
        verify(entry.target, await statPath(entry.target.file), entry.revision);
        verify(entry.target, await entry.file.stat({ bigint: true }), entry.revision);
        entry.failed = true;
        await action();
        await entry.file.sync();
        const stat = await entry.file.stat({ bigint: true });
        entry.revision = signature(stat);
        remember(entry.target, stat);
        entry.failed = false;
      });
    };
    const setFile = async (file, metadata) => {
      if (metadata.size !== undefined) await file.truncate(metadata.size);
      if (metadata.mode !== undefined) await file.chmod(metadata.mode);
      if (metadata.times) await file.utimes(...metadata.times);
    };
    const nameReply = (id, items) => send(T.NAME, u32(id), u32(items.length),
      ...items.flatMap(({ name, metadata }) => [str(name), str(name), metadata]));

    async function open(id, fields) {
      if (handles.size >= MAX_HANDLES) throw fail('EMFILE', 'too_many_project_handles');
      const target = resolve(fields.text(), false);
      const flags = fields.u32();
      const metadata = fields.metadata();
      const writable = Boolean(flags & FLAGS.WRITE);
      const create = Boolean(flags & FLAGS.CREATE);
      if (!flags || flags & ~63 || !(flags & (FLAGS.READ | FLAGS.WRITE)) ||
          (!writable && flags & ~(FLAGS.READ)) || ((flags & FLAGS.EXCLUSIVE) && !create)) {
        throw fail('EBADMSG', 'invalid_sftp_open_flags');
      }
      await pin(target, create, async (exists) => {
        if (exists && writable) verify(target, await statPath(target.file));
        if (!exists && !create) throw fail('ENOENT', 'project_path_not_found');
        if (exists && (flags & FLAGS.EXCLUSIVE)) throw fail('EEXIST', 'project_file_exists');
        const mode = writable ? flags & FLAGS.READ ? C.O_RDWR : C.O_WRONLY : C.O_RDONLY;
        const nativeFlags = mode | (!exists ? C.O_CREAT | C.O_EXCL : 0) | (flags & FLAGS.APPEND ? C.O_APPEND : 0);
        const file = await fs.open(target.file, nativeFlags, metadata.mode ?? 0o666);
        try {
          const stat = await file.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n) throw fail('EACCES', 'project_path_denied');
          const entry = { kind: 'file', target, file, writable, revision: signature(stat) };
          if (flags & FLAGS.TRUNCATE) { await file.truncate(0); await file.sync(); }
          const current = await file.stat({ bigint: true });
          entry.revision = signature(current);
          remember(target, current);
          // A disconnected client cannot receive or use this handle.
          if (closed) await file.close();
          else newHandle(id, entry);
        } catch (error) { await file.close(); throw error; }
      });
    }

    async function move(id, fields, replace) {
      const source = resolve(fields.text(), false);
      const target = resolve(fields.text(), false);
      await guard.withPaths([parent(source), parent(target)], null, async () => {
        const before = await statPath(source.file);
        if (!before) throw fail('ENOENT', 'project_path_not_found');
        verify(source, before);
        if (replace) verify(target, await statPath(target.file));
        await guard.move(source.file, target.file, replace);
        observed.delete(source.file.toLowerCase());
        const moved = await statPath(target.file);
        if (moved) remember(target, moved);
      });
      status(id, S.OK);
    }

    async function request(data) {
      const type = data[0];
      const fields = new Fields(data.subarray(1));
      if (type === T.INIT) {
        fields.u32();
        send(T.VERSION, u32(3), str('posix-rename@openssh.com'), str('1'), str('fsync@openssh.com'), str('1'));
        return;
      }
      const id = fields.u32();
      try {
        if (type === T.OPEN) return await open(id, fields);
        if (type === T.RENAME) return await move(id, fields, false);
        if (type === T.EXTENDED) {
          const extension = fields.text();
          if (extension === 'posix-rename@openssh.com') return await move(id, fields, true);
          if (extension !== 'fsync@openssh.com') throw fail('ENOTSUP', 'unsupported_sftp_extension');
          const entry = handle(fields, 'file');
          if (entry.failed) throw fail('ECONFLICT', 'project_write_outcome_unknown: ' + entry.target.name);
          await entry.file.sync();
          return status(id, S.OK);
        }
        if (type === T.CLOSE) {
          const key = fields.text();
          const entry = handles.get(key);
          if (!entry) throw fail('EBADMSG', 'invalid_sftp_handle');
          handles.delete(key);
          if (entry.file) await entry.file.close();
          if (entry.dir) await entry.dir.close();
          return status(id, entry.failed ? S.FAILURE : S.OK, entry.failed ? 'project_write_outcome_unknown' : '');
        }
        if (type === T.READ || type === T.WRITE || type === T.FSTAT || type === T.FSETSTAT) {
          const entry = handle(fields, type === T.FSTAT ? undefined : 'file');
          if (type === T.FSTAT) {
            const stat = entry.file ? await entry.file.stat({ bigint: true }) : entry.stat;
            return send(T.ATTRS, u32(id), attrs(stat));
          }
          if (type === T.FSETSTAT) {
            const metadata = fields.metadata();
            await update(entry, () => setFile(entry.file, metadata));
            return status(id, S.OK);
          }
          const offset = fields.offset64();
          if (type === T.WRITE) {
            const buffer = fields.bytes();
            if (buffer.length > MAX_CHUNK) throw fail('EBADMSG', 'sftp_write_chunk_too_large');
            await update(entry, async () => {
              const { bytesWritten } = await entry.file.write(buffer, 0, buffer.length, offset);
              if (bytesWritten !== buffer.length) throw fail('EIO', 'partial_project_write: ' + entry.target.name);
            });
            return status(id, S.OK);
          }
          const buffer = Buffer.alloc(Math.min(fields.u32(), MAX_CHUNK));
          const { bytesRead } = await entry.file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) return status(id, S.EOF);
          return send(T.DATA, u32(id), str(buffer.subarray(0, bytesRead)));
        }
        if (type === T.READDIR) {
          const entry = handle(fields, 'dir');
          return await guard.withPaths([entry.target.file], null, async () => {
            const current = await statPath(entry.target.file);
            if (entry.stat.ino !== current?.ino || entry.stat.dev !== current?.dev) throw fail('ECONFLICT', 'project_directory_replaced');
            const items = [];
            for (let index = 0; index < 64; index++) {
              const member = await entry.dir.read();
              if (!member) break;
              if (!badName.test(member.name)) {
                const item = await statPath(path.join(entry.target.file, member.name)).catch(() => null);
                if (item) items.push({ name: member.name, metadata: attrs(item) });
              }
              if (index === 63 && !items.length) index = -1;
            }
            return items.length ? nameReply(id, items) : status(id, S.EOF);
          });
        }
        if (![T.REALPATH, T.STAT, T.LSTAT, T.OPENDIR, T.SETSTAT, T.MKDIR, T.REMOVE, T.RMDIR].includes(type)) {
          throw fail('ENOTSUP', 'unsupported_sftp_operation');
        }
        const target = resolve(fields.text(), [T.REALPATH, T.STAT, T.LSTAT, T.OPENDIR].includes(type));
        if (type === T.REALPATH) return nameReply(id, [{ name: target.name, metadata: u32(0) }]);
        if (type === T.OPENDIR) {
          if (handles.size >= MAX_HANDLES) throw fail('EMFILE', 'too_many_project_handles');
          return await guard.withPaths([target.file], null, async () => {
            const dir = await fs.opendir(target.file);
            try {
              const stat = await statPath(target.file);
              if (closed) await dir.close();
              else newHandle(id, { kind: 'dir', target, dir, stat });
            } catch (error) { await dir.close(); throw error; }
          });
        }
        if (type === T.SETSTAT) {
          const metadata = fields.metadata();
          await pin(target, false, async () => {
            verify(target, await statPath(target.file));
            const file = await fs.open(target.file, metadata.size === undefined ? C.O_RDONLY : C.O_RDWR);
            try {
              await setFile(file, metadata);
              await file.sync();
              remember(target, await file.stat({ bigint: true }));
            } finally { await file.close(); }
          });
          return status(id, S.OK);
        }
        await guard.withPaths([parent(target)], null, async () => {
          if (type === T.MKDIR) {
            fields.metadata();
            await fs.mkdir(target.file);
            return status(id, S.OK);
          }
          const stat = await statPath(target.file);
          if (!stat) throw fail('ENOENT', 'project_path_not_found');
          if (type === T.STAT || type === T.LSTAT) return send(T.ATTRS, u32(id), attrs(stat));
          verify(target, stat);
          if (type === T.REMOVE) await fs.unlink(target.file);
          else await fs.rmdir(target.file);
          observed.delete(target.file.toLowerCase());
          return status(id, S.OK);
        });
      } catch (error) {
        const code = ['ENOENT', 'ENOTDIR'].includes(error.code) ? S.NO_SUCH_FILE :
          ['EACCES', 'EPERM'].includes(error.code) ? S.PERMISSION_DENIED :
            error.code === 'ENOTSUP' ? S.OP_UNSUPPORTED : error.code === 'EBADMSG' ? S.BAD_MESSAGE : S.FAILURE;
        // Native errors can contain absolute Windows paths. Report the virtual path only for explicit conflicts.
        status(id, code, error.code === 'ECONFLICT' ? error.message : (error.code || 'project_operation_failed'));
      }
    }

    const close = () => { closed = true; input.destroy(); };
    output.once('error', close);
    output.once('close', close);
    const done = (async () => {
      try {
        for await (const chunk of input) {
          if (closed) break;
          reader.push(chunk);
          for (let message; !closed && (message = reader.next());) await request(message);
        }
      } catch { close(); }
      finally {
        closed = true;
        await Promise.allSettled([...handles.values()].map((entry) => (entry.file || entry.dir).close()));
        guard.close();
        output.off('error', close);
        output.off('close', close);
      }
    })();
    return { close, done };
  };
}

module.exports = { createProjectSftp };
