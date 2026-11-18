const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { allowedPath } = require('./windows-files');

const maxBytes = 2000;
async function readText(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw Error('请选择不超过 2 KB 的文本文件。');
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, bytesRead);
    if (bytesRead > maxBytes || content.includes(0)) throw Error('请选择不超过 2 KB 的文本文件。');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } finally { await handle.close(); }
}

async function capture(filename, kind) {
  const selected = allowedPath(filename, kind === 'file');
  const canonical = allowedPath(await fs.realpath(selected), kind === 'file');
  const stat = await fs.stat(canonical);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw Error('所选路径类型不匹配。');
  return { path: canonical, kind, ...(kind === 'file' && { before: await readText(canonical) }) };
}

function prepare(scope, input) {
  const { action, name, content } = input || {};
  if (scope.kind === 'file') {
    if (action !== 'replace' || name !== undefined) throw Error('只能替换所选文件的内容。');
  } else if (!['mkdir', 'create'].includes(action) || typeof name !== 'string' ||
      !name || name.length > 180 || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw Error('只能在所选目录内新建一个文件或文件夹。');
  }
  if (action !== 'mkdir' && (typeof content !== 'string' || Buffer.byteLength(content) > maxBytes || content.includes('\0'))) {
    throw Error('新内容必须是 2 KB 以内的 UTF-8 文本。');
  }
  const target = allowedPath(scope.kind === 'file' ? scope.path : path.join(scope.path, name), true);
  return { action, target, content };
}

async function apply(scope, change) {
  const current = await capture(scope.path, scope.kind);
  if (current.path !== scope.path || current.before !== scope.before) throw Error('本机内容已有变化，请重新选取并生成操作。');
  const { target, action, content } = change;
  if (action === 'mkdir') return fs.mkdir(target);
  if (action === 'create') return fs.writeFile(target, content, { flag: 'wx' });
  const temporary = path.join(path.dirname(target), '.agentdesk-' + randomUUID() + '.tmp');
  try {
    const { mode } = await fs.stat(target);
    await fs.writeFile(temporary, content, { flag: 'wx', mode });
    if ((await capture(target, 'file')).before !== scope.before || (await fs.lstat(target)).isSymbolicLink()) {
      throw Error('本机内容已有变化，请重新选取并生成操作。');
    }
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

module.exports = { capture, prepare, apply };
