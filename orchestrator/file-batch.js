const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { encode } = require('./transport');

const MAX_ITEMS = 32;
const MAX_RESPONSE = 20 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_REQUEST = 128 * 1024;
const PAGE = 8 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^[a-f0-9]{64}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function spec(name, write) {
  const properties = {
    path: { type: 'string', description: 'File path allowed by the tool' },
    encoding: { type: 'string', enum: ['utf8', 'base64'] },
    ...(write ? {
      version: { type: ['string', 'null'], description: 'SHA-256 returned by batch read, or null to create a new file' },
      content: { type: 'string' },
    } : {
      offset: { type: 'integer', minimum: 0 },
      maxBytes: { type: 'integer', minimum: 1, maximum: PAGE },
    }),
  };
  return {
    type: 'function', name,
    description: write
      ? 'Create or replace files in one call. Supply an expected version for each file. All items are checked before any writes. Results match the order of items.'
      : 'Read files in one call. Each item returns its own SHA-256, content and nextOffset. The total content is capped at 20 KiB. Results match the order of items.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: MAX_ITEMS,
          items: { type: 'object', additionalProperties: false,
            required: write ? ['path', 'version', 'content'] : ['path'], properties },
        },
      },
    },
  };
}

function validate(items, write) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS ||
      Buffer.byteLength(encode({ items })) > MAX_REQUEST) throw new Error('invalid_batch_size');
  for (const item of items) {
    if (!object(item) || typeof item.path !== 'string' || !item.path || item.path.length > 1024 ||
        (item.encoding !== undefined && !['utf8', 'base64'].includes(item.encoding))) throw new Error('invalid_batch_item');
    if (write) {
      if (typeof item.content !== 'string' || !(item.version === null ||
          typeof item.version === 'string' && versionPattern.test(item.version))) throw new Error('invalid_batch_version_or_content');
    } else if ((item.offset !== undefined && (!Number.isSafeInteger(item.offset) || item.offset < 0)) ||
               (item.maxBytes !== undefined && (!Number.isSafeInteger(item.maxBytes) || item.maxBytes < 1 || item.maxBytes > PAGE))) {
      throw new Error('invalid_batch_read_range');
    }
  }
}

async function snapshot(filename) {
  if (!(await fs.lstat(filename)).isFile()) throw new Error('batch_requires_regular_file_under_20_mib');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('batch_requires_regular_file_under_20_mib');
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size) throw new Error('version_conflict');
    return { bytes: buffer.subarray(0, total), mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

async function readBatch(items, resolve) {
  validate(items, false);
  const results = [];
  let remaining = MAX_RESPONSE;
  for (const item of items) {
    if (!remaining) { results.push({ status: 'skipped', reason: 'batch_read_limit' }); continue; }
    try {
      const { bytes } = await snapshot(await resolve(item.path));
      const offset = item.offset ?? 0;
      const encoding = item.encoding ?? 'utf8';
      let end = Math.min(bytes.length, offset + Math.min(item.maxBytes ?? PAGE, remaining));
      if (encoding === 'utf8' && end < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('invalid_utf8_offset');
      while (encoding === 'utf8' && end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (end === offset && offset < bytes.length) { results.push({ status: 'skipped', reason: 'batch_read_limit' }); continue; }
      const content = bytes.subarray(offset, end);
      remaining -= content.length;
      results.push({ status: 'read', version: digest(bytes), content: content.toString(encoding),
        nextOffset: end < bytes.length ? end : null });
    } catch (error) { results.push({ status: 'failed', error: String(error.message).slice(0, 160) }); }
  }
  return { results };
}

async function checkedFile(resolve, item) {
  const filename = await resolve(item.path);
  const current = await snapshot(filename).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if ((current ? digest(current.bytes) : null) !== item.version) throw new Error('version_conflict');
  return { filename, mode: current?.mode ?? 0o600 };
}

async function writeChecked(resolve, item, prepared, around) {
  const { filename, mode, bytes } = prepared;
  const temp = path.join(path.dirname(filename), '.agentdesk-batch-' + randomUUID());
  let created = false;
  try {
    await around(filename, async () => {
      const latest = await checkedFile(resolve, item);
      if (latest.filename !== filename) throw new Error('version_conflict');
      const handle = await fs.open(temp, 'wx', mode);
      created = true;
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      const check = await checkedFile(resolve, item);
      if (check.filename !== filename) throw new Error('version_conflict');
      if (item.version === null) await fs.link(temp, filename);
      else await fs.rename(temp, filename);
    });
    return { status: 'written', version: digest(bytes), bytes: bytes.length };
  } finally { if (created) await fs.unlink(temp).catch(() => {}); }
}

async function writeBatch(items, resolve, around = (_filename, run) => run()) {
  validate(items, true);
  const prepared = [];
  const results = items.map(() => ({ status: 'not_run' }));
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    try {
      const { filename, mode } = await checkedFile(resolve, item);
      const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
      if (seen.has(key)) throw new Error('duplicate_batch_path');
      seen.add(key);
      const bytes = Buffer.from(item.content, item.encoding ?? 'utf8');
      if (item.encoding === 'base64' && bytes.toString('base64') !== item.content) throw new Error('invalid_base64');
      prepared.push({ filename, mode, bytes });
    } catch (error) { results[index] = { status: 'failed', error: String(error.message).slice(0, 160) }; }
  }
  if (results.some(({ status }) => status === 'failed')) return { phase: 'preflight', results };
  for (const [index, entry] of prepared.entries()) {
    try {
      results[index] = await writeChecked(resolve, items[index], entry, around);
    } catch (error) {
      results[index] = { status: 'failed', error: String(error.message).slice(0, 160) };
      break;
    }
  }
  return { phase: 'write', results };
}

function editSpec(name) {
  return {
    type: 'function', name,
    description: 'Replace exact text in a local UTF-8 file. Read the file first. The old text must match once unless replaceAll is set.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'oldText', 'newText'],
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' },
        replaceAll: { type: 'boolean' }, version: { type: 'string', description: 'Optional expected SHA-256 from batch read' } } },
  };
}

async function editFile(args, resolve, around = (_filename, run) => run()) {
  const { path: pathname, oldText, newText, replaceAll = false, version } = args || {};
  if (typeof pathname !== 'string' || typeof oldText !== 'string' || !oldText || typeof newText !== 'string' ||
      typeof replaceAll !== 'boolean' || (version !== undefined && (typeof version !== 'string' || !versionPattern.test(version))) ||
      Buffer.byteLength(encode({ pathname, oldText, newText })) > MAX_REQUEST) throw new Error('invalid_edit');
  const filename = await resolve(pathname);
  const snapshotBefore = await snapshot(filename);
  const expected = digest(snapshotBefore.bytes);
  if (version !== undefined && version !== expected) throw new Error('version_conflict');
  const text = snapshotBefore.bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(snapshotBefore.bytes)) throw new Error('edit_requires_utf8');
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error('edit_text_not_found');
  if (!replaceAll && text.indexOf(oldText, first + 1) >= 0) throw new Error('edit_text_not_unique');
  let occurrences = 1;
  if (replaceAll) {
    for (let index = first; (index = text.indexOf(oldText, index + oldText.length)) >= 0;) occurrences++;
  }
  if (Buffer.byteLength(text) + occurrences * (Buffer.byteLength(newText) - Buffer.byteLength(oldText)) > MAX_FILE) {
    throw new Error('edit_file_too_large');
  }
  const edited = replaceAll ? text.replaceAll(oldText, () => newText) : text.slice(0, first) + newText + text.slice(first + oldText.length);
  const result = await writeChecked(resolve, { path: pathname, version: expected },
    { filename, mode: snapshotBefore.mode, bytes: Buffer.from(edited) }, around);
  return { ...result, replacements: occurrences };
}

module.exports = { spec, readBatch, writeBatch, validate, editSpec, editFile };
