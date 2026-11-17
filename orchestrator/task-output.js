const { constants } = require('node:fs');
const { open } = require('node:fs/promises');
const path = require('node:path');

const MAX_PATCH = 24 * 1024;
const MAX_LOG = 12 * 1024;

function patchFiles(task) {
  return (task.steps || []).filter((step) => step.write && step.paths?.length && !step.supersededBy)
    .map((step) => step.id);
}

async function readOutput(filename, limit, tail = false) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const { size } = info;
    if (!info.isFile()) throw new Error('invalid_artifact');
    if (!tail && size > limit) throw new Error('patch_too_large');
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, tail ? Math.max(0, size - limit) : 0);
    return { text: buffer.toString('utf8', 0, bytesRead), truncated: size > limit };
  } finally {
    await file.close();
  }
}

async function taskPatch(stateDir, task) {
  let patch = '';
  for (const stepId of patchFiles(task)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(stepId)) throw new Error('invalid_artifact');
    const file = path.join(stateDir, 'worktrees', task.id, stepId + '.patch');
    const { text } = await readOutput(file, MAX_PATCH - Buffer.byteLength(patch));
    patch += text;
  }
  return { base: task.base, patch };
}

async function taskOutput(stateDir, task, { operation, stepId, artifact }) {
  if (operation === 'task_diff') return taskPatch(stateDir, task);
  const patches = patchFiles(task);
  const steps = (task.steps || []).map((step) => step.id);
  if (operation === 'task_artifacts' && !artifact) {
    return [...patches.map((id) => ({ id: 'patch:' + id, name: id + '.patch' })),
      ...steps.map((id) => ({ id: 'log:' + id, name: id + '.log' }))];
  }
  const [kind, id] = operation === 'task_log' ? ['log', stepId] : String(artifact).split(':');
  if (!/^[a-z0-9_-]{1,32}$/.test(id) || !(kind === 'log' ? steps : kind === 'patch' ? patches : []).includes(id)) {
    throw new Error('invalid_artifact');
  }
  return kind === 'log'
    ? readOutput(path.join(stateDir, 'logs', task.id, id + '.log'), MAX_LOG, true)
    : readOutput(path.join(stateDir, 'worktrees', task.id, id + '.patch'), MAX_PATCH);
}

module.exports = { taskPatch, taskOutput, MAX_PATCH };
