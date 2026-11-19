const { constants, realpath } = require('node:fs');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const path = require('node:path').win32;
const nativePath = promisify(realpath.native);

const LIMIT = 1024 * 1024;
// One read returns at most this much; the model pages on with nextOffset. A 1 MiB page could put a quarter of a
// million tokens into the conversation at once (pi reads in pages of about 50 KB for the same reason).
const READ_PAGE = 64 * 1024;
const systemNames = /^(?:windows|program files(?: \(x86\))?|programdata|recovery|boot|efi|system volume information|\$recycle\.bin|\$windows\.~[^\\]+|windows\.old|perfLogs|documents and settings|pagefile\.sys|hiberfil\.sys|swapfile\.sys|bootmgr|bootnxt|dumpstack\.log(?:\.tmp)?|winre\.wim)$/i;
const volumeNames = /^(?:system volume information|\$recycle\.bin)$/i;
const reserved = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)/i;

function allowedPath(value, mutable = false) {
  if (typeof value !== 'string') throw new Error('Provide an absolute Windows path on C: or D:');
  const input = value.replaceAll('/', '\\');
  if (!/^[cd]:\\/i.test(input)) throw new Error('Provide an absolute Windows path on C: or D:');
  const parts = input.slice(3).replace(/\\+$/, '').split('\\').filter(Boolean);
  for (const part of parts) {
    if (/[:*?"<>|\x00-\x1f]/.test(part) || /[ .]$/.test(part) || reserved.test(part)) {
      throw new Error('Unsupported Windows path component');
    }
  }
  if (!parts.length && mutable) throw new Error('A drive root cannot be modified');
  if (parts.length && (volumeNames.test(parts[0]) || (/^c:/i.test(input) && systemNames.test(parts[0])))) {
    throw new Error('Windows system location is outside AgentDesk file access');
  }
  return path.normalize(input);
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

const fields = {
  path: { type: 'string', description: 'Absolute path on C: or D:, for example C:\\Users\\example\\filename.txt or D:\\folder' },
  destination: { type: 'string', description: 'Destination absolute path, on C: or D:' },
  offset: { type: 'integer', minimum: 0, description: 'Starting byte offset or directory entry offset' },
  encoding: { type: 'string', enum: ['utf8', 'base64'] },
  content: { type: 'string' },
  overwrite: { type: 'boolean', description: 'Allow replacing an existing file; defaults to false' },
};

const operation = (name, description, required, optional = []) => ({
  type: 'function', name: 'windows_file_' + name, description,
  inputSchema: {
    type: 'object', additionalProperties: false, required,
    properties: Object.fromEntries([...required, ...optional].map((key) => [key, fields[key]])),
  },
});

const specs = [
  operation('list', 'List up to 250 entries in a local Windows directory. Available in AgentDesk Full Access mode.', ['path'], ['offset']),
  operation('read', 'Read up to 64 KiB of a local Windows file as UTF-8 text or base64 (use base64 for binary data); continue from nextOffset for the rest. Available in AgentDesk Full Access mode.', ['path'], ['encoding', 'offset']),
  operation('write', 'Write UTF-8 or base64 data to a local Windows file. Can create a file or replace it with overwrite=true. Available in AgentDesk Full Access mode.', ['path', 'content'], ['encoding', 'overwrite']),
  operation('mkdir', 'Create one local Windows directory. Available in AgentDesk Full Access mode.', ['path']),
  operation('copy', 'Copy a local Windows file, including between C: and D:. Available in AgentDesk Full Access mode.', ['path', 'destination'], ['overwrite']),
  operation('move', 'Rename a file or directory on the same Windows volume. Available in AgentDesk Full Access mode.', ['path', 'destination']),
  operation('trash', 'Move a local Windows file or directory to the Recycle Bin. Available in AgentDesk Full Access mode.', ['path']),
];

function argsFor(tool, values) {
  const schema = specs.find(({ name }) => name === tool)?.inputSchema;
  if (!schema || !values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid Windows file tool');
  if (schema.required.some((key) => !Object.hasOwn(values, key))) throw new Error('Missing Windows file tool argument');
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(schema.properties, key) && schema.properties[key];
    const valid = field?.type === 'integer' ? Number.isSafeInteger(value) && value >= 0 : typeof value === field?.type;
    if (!valid || (field.enum && !field.enum.includes(value))) throw new Error('Invalid argument: ' + key);
  }
  return values;
}

async function call(tool, values, trash) {
  try {
    const args = argsFor(tool, values);
    let output;
    switch (tool) {
      case 'windows_file_list': {
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
      case 'windows_file_read': {
        const file = await existing(args.path);
        const offset = args.offset ?? 0;
        const handle = await fs.open(file, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error('Use windows_file_list for directories');
          const bytes = Buffer.alloc(Math.min(READ_PAGE + 4, Math.max(0, info.size - offset)));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
          const encoding = args.encoding || 'utf8';
          let end = Math.min(bytesRead, READ_PAGE);
          if (encoding === 'utf8' && end < bytesRead) {
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
          }
          const content = bytes.subarray(0, end);
          output = { path: file, content: content.toString(encoding), nextOffset: offset + end < info.size && end > 0 ? offset + end : null };
        } finally { await handle.close(); }
        break;
      }
      case 'windows_file_write': {
        const target = await destination(args.path);
        const bytes = Buffer.from(args.content, args.encoding || 'utf8');
        if (bytes.length > LIMIT) throw new Error('Write content exceeds the 1 MiB per-call limit');
        await fs.writeFile(target, bytes, { flag: args.overwrite ? 'w' : 'wx' });
        output = { path: target, bytes: bytes.length };
        break;
      }
      case 'windows_file_mkdir': {
        const target = await destination(args.path);
        await fs.mkdir(target);
        output = { path: target };
        break;
      }
      case 'windows_file_copy': {
        const source = await existing(args.path);
        const target = await destination(args.destination);
        await fs.copyFile(source, target, args.overwrite ? 0 : constants.COPYFILE_EXCL);
        output = { path: target };
        break;
      }
      case 'windows_file_move': {
        const source = await existing(args.path, true);
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
      case 'windows_file_trash': {
        const target = await existing(args.path, true);
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

module.exports = { specs, call, result, allowedPath, LIMIT, READ_PAGE };
