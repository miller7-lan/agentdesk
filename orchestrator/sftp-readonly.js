// A read-only SFTP (version 3) server over a stream, run by the Bridge on the person's computer. VPS2 mounts it
// with `sshfs -o passive`, so the lead and the members read the person's files with their own native tools, as
// if the files were on VPS2's disk, without a tool call per file.
//
// What it serves: the person's home folder, as "/". Nothing can be changed (every write, create, remove,
// rename and attribute change is refused), nothing outside the home folder is reachable (".." and symbolic
// links that lead outside are refused), and credential folders (SSH keys, keychains, browser profiles, cloud
// and CLI logins, the Bridge's own state and key) are hidden from listings and refused when named. The filter
// runs here, on the person's computer, so no process on VPS2 ever sees those files.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const T = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19,
  SYMLINK: 20, EXTENDED: 200, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105 };
const S = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, OP_UNSUPPORTED: 8 };
const ATTR = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8 };
const OPEN_WRITE = 0x2 | 0x4 | 0x8 | 0x10 | 0x20;   // WRITE, APPEND, CREAT, TRUNC, EXCL
const MAX_PACKET = 256 * 1024;
const MAX_READ = 64 * 1024;
const MAX_HANDLES = 512;
const DIR_BATCH = 100;

// Relative to the home folder; compared case-insensitively (macOS and Windows folders usually are).
const HIDDEN = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials', '.pypirc', '.npmrc',
  '.config/gh', '.config/gcloud', '.config/op', '.password-store',
  '.codex', '.claude', '.claude.json', '.grok', '.gemini', '.antigravity',
  'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Mail', 'Library/Messages',
  'Library/Application Support/Google', 'Library/Application Support/Firefox', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/1Password', 'Library/Group Containers',
  'Library/Containers/com.apple.mail',
  'AppData/Local/Google', 'AppData/Roaming/Mozilla', 'AppData/Local/Microsoft/Edge', 'AppData/Local/BraveSoftware',
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
  'NTUSER.DAT',
];

class Reader {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) { this.buffer = Buffer.concat([this.buffer, chunk]); }
  next() {
    if (this.buffer.length < 4) return null;
    const length = this.buffer.readUInt32BE(0);
    if (length < 1 || length > MAX_PACKET) throw new Error('sftp_packet_too_large');
    if (this.buffer.length < 4 + length) return null;
    const packet = this.buffer.subarray(4, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return packet;
  }
}

class Fields {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  byte() { return this.buffer.readUInt8(this.offset++); }
  u32() { const value = this.buffer.readUInt32BE(this.offset); this.offset += 4; return value; }
  u64() { const value = this.buffer.readBigUInt64BE(this.offset); this.offset += 8; return value; }
  bytes() { const length = this.u32(); const value = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  string() { return this.bytes().toString('utf8'); }
}

function packet(type, parts) {
  const body = Buffer.concat([Buffer.from([type]), ...parts]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const str = (value) => { const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return Buffer.concat([u32(data.length), data]); };

function attrs(stat) {
  if (!stat) return u32(0);
  const type = stat.isDirectory() ? 0o040000 : stat.isFile() ? 0o100000 : 0o100000;
  // Read-only to whoever mounts it: write bits are never shown.
  const mode = type | ((stat.isDirectory() ? 0o555 : 0o444) & (stat.mode | 0o444));
  return Buffer.concat([u32(ATTR.SIZE | ATTR.PERMISSIONS | ATTR.ACMODTIME), u64(stat.isDirectory() ? 0 : stat.size), u32(mode),
    u32(Math.floor(stat.atimeMs / 1000)), u32(Math.floor(stat.mtimeMs / 1000))]);
}
function longname(name, stat) {
  const kind = stat?.isDirectory() ? 'd' : '-';
  return `${kind}${stat?.isDirectory() ? 'r-xr-xr-x' : 'r--r--r--'} 1 owner owner ${stat?.size ?? 0} Jan 1 00:00 ${name}`;
}

function createReadOnlySftp({ root = os.homedir(), hidden = [], platform = process.platform } = {}) {
  const fold = platform === 'darwin' || platform === 'win32' ? (text) => text.toLowerCase() : (text) => text;
  const native = platform === 'win32' ? path.win32 : path.posix;
  const base = native.resolve(root);
  const denied = [...HIDDEN, ...hidden].map((entry) => fold(String(entry).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')));
  const extraAbsolute = hidden.filter((entry) => native.isAbsolute(String(entry))).map((entry) => native.resolve(entry));
  const lexicalHidden = extraAbsolute.map(fold);
  const hiddenPath = (value, entries) => entries.some((entry) => value === entry || value.startsWith(entry + native.sep));
  let rootPolicy;
  function resolveRoot() {
    return rootPolicy ||= fs.realpath(base).then(async (realBase) => {
      const absolute = new Set(lexicalHidden);
      for (const entry of extraAbsolute) {
        const relative = native.relative(base, entry);
        if (!native.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + native.sep)) {
          absolute.add(fold(native.resolve(realBase, relative)));
        }
        const real = await fs.realpath(entry).catch(() => null);
        if (real) absolute.add(fold(real));
      }
      return { realBase, absolute: [...absolute] };
    }).catch((error) => { rootPolicy = null; throw error; });
  }

  // "/a/b" (always "/"-separated, as SFTP paths are) → the absolute native path under the home folder, or null
  // when it leaves the home folder or names a hidden folder.
  function virtualToNative(virtual) {
    const parts = [];
    for (const part of String(virtual || '.').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); continue; }
      if (platform === 'win32' && /[\\:]/.test(part)) return null;
      parts.push(part);
    }
    const relative = parts.join('/');
    if (isHidden(relative)) return null;
    const candidate = parts.length ? native.join(base, ...parts) : base;
    return hiddenPath(fold(candidate), lexicalHidden) ? null : { relative, native: candidate };
  }
  function isHidden(relative) {
    const key = fold(relative);
    return denied.some((entry) => entry && (key === entry || key.startsWith(entry + '/')));
  }
  // Symbolic links are followed only when they stay inside the home folder and do not lead into a hidden one.
  async function safeStat(target) {
    const { realBase, absolute } = await resolveRoot();
    const real = await fs.realpath(target.native);
    const inside = native.relative(realBase, real);
    if (inside.startsWith('..') || native.isAbsolute(inside)) throw Object.assign(new Error('outside'), { code: 'EACCES' });
    if (isHidden(inside.split(native.sep).join('/'))) throw Object.assign(new Error('hidden'), { code: 'EACCES' });
    if (hiddenPath(fold(real), absolute)) throw Object.assign(new Error('hidden'), { code: 'EACCES' });
    return { real, stat: await fs.stat(real) };
  }
  const code = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? S.NO_SUCH_FILE
    : error?.code === 'EACCES' || error?.code === 'EPERM' ? S.PERMISSION_DENIED : S.FAILURE;

  return function serve(input, output) {
    const reader = new Reader();
    const handles = new Map();
    let nextHandle = 1;
    let closed = false;
    const send = (data) => { if (!closed && !output.destroyed) output.write(data); };
    const status = (id, value, message = '') => send(packet(T.STATUS, [u32(id), u32(value), str(message), str('')]));
    const open = (entry) => {
      if (handles.size >= MAX_HANDLES) return null;
      const handle = String(nextHandle++);
      handles.set(handle, entry);
      return handle;
    };

    async function handle(data) {
      const fields = new Fields(data);
      const type = fields.byte();
      if (type === T.INIT) { send(packet(T.VERSION, [u32(3)])); return; }
      const id = fields.u32();
      try {
        switch (type) {
          case T.REALPATH: {
            const target = virtualToNative(fields.string());
            if (!target) return status(id, S.PERMISSION_DENIED, 'outside the shared folder');
            const name = '/' + target.relative;
            return send(packet(T.NAME, [u32(id), u32(1), str(name), str(name), u32(0)]));
          }
          case T.STAT: case T.LSTAT: {
            const target = virtualToNative(fields.string());
            if (!target) return status(id, S.PERMISSION_DENIED);
            const { stat } = await safeStat(target);
            return send(packet(T.ATTRS, [u32(id), attrs(stat)]));
          }
          case T.FSTAT: {
            const entry = handles.get(fields.string());
            if (!entry) return status(id, S.FAILURE, 'bad handle');
            return send(packet(T.ATTRS, [u32(id), attrs(entry.stat)]));
          }
          case T.OPENDIR: {
            const target = virtualToNative(fields.string());
            if (!target) return status(id, S.PERMISSION_DENIED);
            const { real, stat } = await safeStat(target);
            if (!stat.isDirectory()) return status(id, S.FAILURE, 'not a directory');
            const names = (await fs.readdir(real)).filter((name) => !isHidden((target.relative ? target.relative + '/' : '') + name));
            const handleId = open({ kind: 'dir', real, relative: target.relative, names, position: 0, stat });
            return handleId ? send(packet(T.HANDLE, [u32(id), str(handleId)])) : status(id, S.FAILURE, 'too many open handles');
          }
          case T.READDIR: {
            const entry = handles.get(fields.string());
            if (!entry || entry.kind !== 'dir') return status(id, S.FAILURE, 'bad handle');
            if (entry.position >= entry.names.length) return status(id, S.EOF);
            const batch = entry.names.slice(entry.position, entry.position + DIR_BATCH);
            entry.position += batch.length;
            const items = [];
            for (const name of batch) {
              let stat = null;
              try { ({ stat } = await safeStat({ native: native.join(entry.real, name) })); } catch { continue; }   // broken or escaping link
              items.push(str(name), str(longname(name, stat)), attrs(stat));
            }
            if (!items.length) return status(id, entry.position >= entry.names.length ? S.EOF : S.OK);
            return send(packet(T.NAME, [u32(id), u32(items.length / 3), ...items]));
          }
          case T.OPEN: {
            const target = virtualToNative(fields.string());
            const flags = fields.u32();
            if (flags & OPEN_WRITE) return status(id, S.PERMISSION_DENIED, 'read-only');
            if (!target) return status(id, S.PERMISSION_DENIED);
            const { real, stat } = await safeStat(target);
            if (!stat.isFile()) return status(id, S.FAILURE, 'not a file');
            const file = await fs.open(real, 'r');
            const handleId = open({ kind: 'file', file, stat });
            if (!handleId) { await file.close(); return status(id, S.FAILURE, 'too many open handles'); }
            return send(packet(T.HANDLE, [u32(id), str(handleId)]));
          }
          case T.READ: {
            const entry = handles.get(fields.string());
            const offset = fields.u64();
            const length = Math.min(fields.u32(), MAX_READ);
            if (!entry || entry.kind !== 'file') return status(id, S.FAILURE, 'bad handle');
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await entry.file.read(buffer, 0, length, Number(offset));
            if (!bytesRead) return status(id, S.EOF);
            return send(packet(T.DATA, [u32(id), str(buffer.subarray(0, bytesRead))]));
          }
          case T.CLOSE: {
            const key = fields.string();
            const entry = handles.get(key);
            handles.delete(key);
            if (entry?.kind === 'file') await entry.file.close().catch(() => {});
            return status(id, entry ? S.OK : S.FAILURE);
          }
          case T.READLINK: case T.SYMLINK: case T.EXTENDED:
            return status(id, S.OP_UNSUPPORTED);
          case T.WRITE: case T.SETSTAT: case T.FSETSTAT: case T.REMOVE: case T.MKDIR: case T.RMDIR: case T.RENAME:
            return status(id, S.PERMISSION_DENIED, 'read-only');
          default:
            return status(id, S.OP_UNSUPPORTED);
        }
      } catch (error) {
        return status(id, code(error));
      }
    }

    // Requests are answered in order, so a slow read never lets a later CLOSE overtake it.
    let queue = Promise.resolve();
    input.on('data', (chunk) => {
      reader.push(chunk);
      try {
        for (let data; (data = reader.next());) {
          const current = data;
          queue = queue.then(() => handle(current)).catch(() => {});
        }
      } catch {
        input.destroy();
      }
    });
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const entry of handles.values()) if (entry.kind === 'file') entry.file.close().catch(() => {});
      handles.clear();
    };
    input.once('close', finish);
    input.once('end', finish);
    return { close: finish };
  };
}

module.exports = { createReadOnlySftp, HIDDEN, Reader, packet, u32, u64, str, T, S };
