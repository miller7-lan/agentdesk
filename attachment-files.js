// Reads a file the person attached, of any type. A folder becomes one .zip with its files inside, so it can
// travel as a single attachment; version-control and dependency folders inside it are left out.
const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('./orchestrator/zipfile');

const SKIPPED = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store', 'Thumbs.db']);
const MAX_FILES = 5000;

const cleanName = (name) => String(name).replace(/[\x00-\x1f\\/]/g, '_').slice(-180) || 'attachment';

async function collect(root, limit) {
  const entries = [];
  let total = 0;
  const skipped = [];
  async function walk(folder, prefix) {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) { skipped.push(prefix + entry.name); continue; }
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;   // a link may point outside the folder the person chose
      if (entry.isDirectory()) { await walk(full, prefix + entry.name + '/'); continue; }
      if (!entry.isFile()) continue;
      const data = await fs.promises.readFile(full);
      total += data.length;
      if (total > limit * 4) throw new Error('文件夹内容过多，请只拖入需要的文件。');
      if (entries.length >= MAX_FILES) throw new Error(`文件夹内文件超过 ${MAX_FILES} 个，请只拖入需要的文件。`);
      entries.push({ name: prefix + entry.name, data });
    }
  }
  await walk(root, path.basename(root) + '/');
  return { entries, skipped };
}

// Returns { name, bytes, folder?: { files, skipped } }. Throws with a message for the person.
async function readAttachment(file, limit) {
  const info = await fs.promises.stat(file);
  const base = cleanName(path.basename(file));
  if (info.isDirectory()) {
    const { entries, skipped } = await collect(file, limit);
    if (!entries.length) throw new Error('文件夹是空的。');
    const bytes = writeZip(entries);
    if (bytes.length > limit) throw new Error(`文件夹打包后超过 ${Math.round(limit / 1048576)} MB，请只拖入需要的文件。`);
    return { name: base + '.zip', bytes, folder: { files: entries.length, skipped } };
  }
  if (!info.isFile()) throw new Error('只能添加文件或文件夹。');
  if (info.size > limit) throw new Error(`单个附件必须不超过 ${Math.round(limit / 1048576)} MB。`);
  const handle = await fs.promises.open(file, 'r');
  try {
    const content = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead !== info.size) throw new Error('文件在读取时发生变化，请重新选择。');
    return { name: base, bytes: content.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

module.exports = { readAttachment, cleanName, SKIPPED };
