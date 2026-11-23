const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_IDENTIFIER = 120;
const tags = ['operation', 'status', 'kind', 'code', 'provider', 'projectId', 'taskId', 'route', 'error', 'version', 'agent'];

function plainTag(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTIFIER && /^[a-z0-9_.:-]+$/i.test(value) ? value : undefined;
}

function safeFields(input = {}) {
  const result = {};
  for (const tag of tags) {
    if (tag === 'projectId' || tag === 'taskId') {
      if (/^(live|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(input[tag] || '')) result[tag] = input[tag];
    } else if (plainTag(input[tag])) result[tag] = input[tag];
  }
  return result;
}

function stamp(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('');
}

async function tail(filename, limit) {
  let file;
  try { file = await fs.open(filename, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, limit);
    if (!length) return [];
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8', 0, bytesRead).trim().split('\n');
    if (size > limit) lines.shift();
    return lines.flatMap((line) => {
      try {
        const { time, event, ...fields } = JSON.parse(line);
        return Number.isFinite(Date.parse(time)) && plainTag(event) ? [{ time, event, ...safeFields(fields) }] : [];
      } catch { return []; }
    });
  } finally { await file.close(); }
}

function createLogger(root, { limit = MAX_LOG_BYTES, now = () => new Date(), onError = () => {} } = {}) {
  const logfile = path.join(root, 'agentdesk.log');
  let pending = Promise.resolve();

  function record(event, fields, audit = false) {
    if (!plainTag(event)) return Promise.resolve();
    const time = now();
    const row = JSON.stringify({ time: time.toISOString(), event, ...safeFields(fields) }) + '\n';
    const job = pending.then(async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const target = audit ? path.join(root, 'audit-' + stamp(time) + '.jsonl') : logfile;
      if (!audit) {
        const size = await fs.stat(target).then((info) => info.size, (error) => {
          if (error.code !== 'ENOENT') throw error;
          return 0;
        });
        if (size && size + Buffer.byteLength(row) > limit) {
          for (const [from, to] of [[target + '.1', target + '.2'], [target, target + '.1']]) {
            await fs.rename(from, to).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          }
        }
      }
      await fs.appendFile(target, row, { mode: 0o600 });
    });
    pending = job.catch(() => { try { onError(); } catch {} });
    return pending;
  }

  async function tails() {
    await pending;
    const log = await tail(logfile, 24 * 1024);
    const audits = await fs.readdir(root).catch(() => []);
    const latest = audits.filter((name) => /^audit-\d{8}\.jsonl$/.test(name)).sort().at(-1);
    const audit = latest ? await tail(path.join(root, latest), 24 * 1024) : [];
    return { log, audit };
  }

  return { log: record, audit: (event, fields) => record(event, fields, true), tails };
}

module.exports = { createLogger, safeFields };
