const path = require('node:path');
const fs = require('node:fs/promises');

const attachmentLimit = 10 * 1024 * 1024;
const maxAttachments = 3;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function attachmentRoot(stateDir, taskId) {
  if (typeof taskId !== 'string' || !idPattern.test(taskId)) throw Error('invalid_task_id');
  return path.join(stateDir, 'chat-attachments', taskId);
}

function validAttachments(list) {
  return Array.isArray(list) && list.length <= maxAttachments &&
    list.every(item => typeof item?.id === 'string' && idPattern.test(item.id) &&
      typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 180 &&
      !/[\\/\x00-\x1f]/.test(item.name) && /^[0-9a-f]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= attachmentLimit) &&
    new Set(list.map(item => item.id)).size === list.length;
}

async function sweepAttachments(stateDir, now = Date.now()) {
  const root = path.join(stateDir, 'chat-attachments');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const directory = attachmentRoot(stateDir, entry.name);
    if ((await fs.stat(directory)).mtimeMs < now - 86400000) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { attachmentLimit, maxAttachments, idPattern, attachmentRoot, validAttachments, sweepAttachments };
