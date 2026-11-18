// 本机 macOS 文件工具：供 Codex(mac) 与 Claude/Grok/Antigravity 单聊共用。
// 这是“护栏式全盘访问”，不是项目沙箱：允许家目录、外接卷和临时目录，拒绝系统目录、
// 凭据目录和 .git 写入；所有写操作都先解析父目录的真实路径，避免符号链接逃逸。
const { constants, realpath } = require('node:fs');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path').posix;
const os = require('node:os');

const LIMIT = 1024 * 1024;
const nativePath = promisify(realpath.native);
const HOME = os.homedir();

function real(value) {
  try { return require('node:fs').realpathSync.native(value); } catch { return value; }
}

const HOME_ROOTS = [...new Set([HOME, real(HOME)])];
const TEMP_ROOTS = [...new Set([os.tmpdir(), real(os.tmpdir()), '/tmp', '/private/tmp'])];
const ALLOWED_ROOTS = [...HOME_ROOTS, ...TEMP_ROOTS, '/Volumes'];
const SYSTEM_ROOTS = [
  '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc',
  '/var', '/private/var', '/opt', '/Applications', '/dev', '/cores', '/private/cores',
  '/private/auditd', '/private/db', '/private/log', '/private/root', '/private/Network',
];
const HOME_DENY = [
  '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.agentdesk',
  '.codex', '.claude', '.gemini', '.grok', '.config/grok',
  '.config/gh', '.config/gcloud', '.local/share/keyrings', '.password-store',
  'Library',
];
const HOME_DENY_FILES = ['.netrc', '.npmrc', '.git-credentials'];

const within = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith('/') ? root : root + '/');
const hasGit = (value) => value.split('/').some((part) => part.toLowerCase() === '.git');

// 同步的静态校验：绝对路径、允许根、系统/凭据目录、.git 写入。真实路径由 existing/destination 再校验。
function allowedPath(value, mutable = false) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error('Provide an absolute POSIX path, for example /Users/name/project/file.txt');
  }
  const normalized = path.normalize(value);
  if (normalized === '/') throw new Error('The filesystem root is outside AgentDesk file access');
  if (!ALLOWED_ROOTS.some((root) => within(normalized, root))) {
    throw new Error('Path is outside the allowed local roots (home, /Volumes, /tmp)');
  }
  const temp = TEMP_ROOTS.some((root) => within(normalized, root));
  if (!temp && SYSTEM_ROOTS.some((root) => within(normalized, root))) {
    throw new Error('macOS system location is outside AgentDesk file access');
  }
  if (HOME_ROOTS.some((root) => HOME_DENY.some((name) => within(normalized, path.join(root, name))) ||
      HOME_DENY_FILES.some((name) => normalized === path.join(root, name)))) {
    throw new Error('Credential and library locations are outside AgentDesk file access');
  }
  if (mutable && hasGit(normalized)) throw new Error('.git is read-only for AgentDesk file tools');
  if (mutable && ALLOWED_ROOTS.some((root) => normalized === root)) throw new Error('An allowed root cannot be modified');
  return normalized;
}

async function existing(value, mutable = false) {
  const requested = allowedPath(value, mutable);
  const actual = await nativePath(requested);
  return allowedPath(actual, mutable);
}

async function destination(value) {
  const requested = allowedPath(value, true);
  const parent = await existing(path.dirname(requested));
  const target = allowedPath(path.join(parent, path.basename(requested)), true);
  let entry;
  try { entry = await fs.lstat(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return target;
  }
  if (entry.isSymbolicLink()) throw new Error('Use the real destination path instead of a symbolic link');
  return existing(target, true);
}

async function hasRepository(pathname) {
  try {
    const info = await fs.lstat(pathname);
    if (!info.isDirectory()) return false;
    await fs.lstat(path.join(pathname, '.git'));
    return true;
  } catch { return false; }
}

const fields = {
  path: { type: 'string', description: 'Absolute POSIX path in the user’s home, /Volumes or /tmp, for example /Users/name/project/file.txt' },
  destination: { type: 'string', description: 'Destination absolute POSIX path' },
  offset: { type: 'integer', minimum: 0, description: 'Starting byte offset or directory entry offset' },
  encoding: { type: 'string', enum: ['utf8', 'base64'] },
  content: { type: 'string' },
  overwrite: { type: 'boolean', description: 'Allow replacing an existing file; defaults to false' },
};

const operation = (name, description, required, optional = []) => ({
  type: 'function', name: 'agentdesk_file_' + name, description,
  inputSchema: {
    type: 'object', additionalProperties: false, required,
    properties: Object.fromEntries([...required, ...optional].map((key) => [key, fields[key]])),
  },
});

const specs = [
  operation('list', 'List up to 250 entries in a local macOS directory. Available in AgentDesk Full Access mode.', ['path'], ['offset']),
  operation('read', 'Read up to 1 MiB from a local macOS file as UTF-8 text or base64; use base64 for binary data. Available in AgentDesk Full Access mode.', ['path'], ['encoding', 'offset']),
  operation('write', 'Write UTF-8 or base64 data to a local macOS file. Can create a file or replace it with overwrite=true. Available in AgentDesk Full Access mode.', ['path', 'content'], ['encoding', 'overwrite']),
  operation('mkdir', 'Create one local macOS directory. Available in AgentDesk Full Access mode.', ['path']),
  operation('copy', 'Copy a local macOS file. Available in AgentDesk Full Access mode.', ['path', 'destination'], ['overwrite']),
  operation('move', 'Rename a local file or directory on the same volume. Available in AgentDesk Full Access mode.', ['path', 'destination']),
  operation('trash', 'Move a local macOS file or directory to the Trash. Available in AgentDesk Full Access mode.', ['path']),
];

const WRITE_TOOLS = new Set(['agentdesk_file_write', 'agentdesk_file_mkdir', 'agentdesk_file_copy', 'agentdesk_file_move', 'agentdesk_file_trash']);
const isWriteTool = (name) => WRITE_TOOLS.has(name);

function argsFor(tool, values) {
  const schema = specs.find(({ name }) => name === tool)?.inputSchema;
  if (!schema || !values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid macOS file tool');
  if (schema.required.some((key) => !Object.hasOwn(values, key))) throw new Error('Missing macOS file tool argument');
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(schema.properties, key) && schema.properties[key];
    const valid = field?.type === 'integer' ? Number.isSafeInteger(value) && value >= 0 : typeof value === field?.type;
    if (!valid || (field.enum && !field.enum.includes(value))) throw new Error('Invalid argument: ' + key);
  }
  return values;
}

async function writeAtomic(target, bytes, overwrite) {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.agentdesk-' + randomUUID() + '.tmp');
  let mode = 0o600;
  let exists = false;
  try {
    const current = await fs.lstat(target);
    if (current.isSymbolicLink()) throw new Error('Use the real destination path instead of a symbolic link');
    if (!overwrite) throw new Error('File already exists; pass overwrite=true to replace it');
    if (current.isDirectory()) throw new Error('Destination is a directory');
    mode = current.mode & 0o777;
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
    if (exists) await fs.chmod(temporary, mode);
    if (!overwrite) {
      // link() 在同目录内原子创建目标；目标已存在时以 EEXIST 失败，不会覆盖。
      try { await fs.link(temporary, target); }
      catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
        await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
      }
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, target);
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function call(tool, values, trash) {
  try {
    const args = argsFor(tool, values);
    let output;
    switch (tool) {
      case 'agentdesk_file_list': {
        const folder = await existing(args.path);
        const offset = args.offset ?? 0;
        const entries = [];
        const directory = await fs.opendir(folder);
        let index = 0;
        let nextOffset = null;
        for await (const entry of directory) {
          try { allowedPath(path.join(folder, entry.name)); } catch { continue; }
          if (index++ < offset) continue;
          if (entries.length === 250) { nextOffset = offset + entries.length; break; }
          entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file' });
        }
        output = { path: folder, entries, nextOffset };
        break;
      }
      case 'agentdesk_file_read': {
        const file = await existing(args.path);
        const offset = args.offset ?? 0;
        const handle = await fs.open(file, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error('Use agentdesk_file_list for directories');
          const bytes = Buffer.alloc(Math.min(LIMIT + 4, Math.max(0, info.size - offset)));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
          const encoding = args.encoding || 'utf8';
          let end = Math.min(bytesRead, LIMIT);
          if (encoding === 'utf8' && end < bytesRead) {
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
          }
          const content = bytes.subarray(0, end);
          output = { path: file, content: content.toString(encoding), nextOffset: offset + end < info.size && end > 0 ? offset + end : null };
        } finally { await handle.close(); }
        break;
      }
      case 'agentdesk_file_write': {
        const target = await destination(args.path);
        const bytes = Buffer.from(args.content, args.encoding || 'utf8');
        if (bytes.length > LIMIT) throw new Error('Write content exceeds the 1 MiB per-call limit');
        await writeAtomic(target, bytes, !!args.overwrite);
        output = { path: target, bytes: bytes.length };
        break;
      }
      case 'agentdesk_file_mkdir': {
        const target = await destination(args.path);
        await fs.mkdir(target);
        output = { path: target };
        break;
      }
      case 'agentdesk_file_copy': {
        const source = await existing(args.path);
        const target = await destination(args.destination);
        await fs.copyFile(source, target, args.overwrite ? 0 : constants.COPYFILE_EXCL);
        output = { path: target };
        break;
      }
      case 'agentdesk_file_move': {
        const source = await existing(args.path, true);
        if (await hasRepository(source)) throw new Error('Move or trash a Git repository from Finder instead');
        const target = await destination(args.destination);
        const occupied = await fs.stat(target).then(() => true, (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (occupied) throw new Error('Destination already exists');
        await fs.rename(source, target);
        output = { path: target };
        break;
      }
      case 'agentdesk_file_trash': {
        const target = await existing(args.path, true);
        if (await hasRepository(target)) throw new Error('Move or trash a Git repository from Finder instead');
        await trash(target);
        output = { path: target, recycled: true };
        break;
      }
    }
    return result(true, output);
  } catch (error) {
    return result(false, { error: error.message, code: error.code });
  }
}

function result(success, output) {
  return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] };
}

module.exports = { specs, call, result, allowedPath, isWriteTool, LIMIT, WRITE_TOOLS };