const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { request } = require('./mcp');
const { RemoteFiles } = require('./windows');

// Admin flags are optional and order-independent: --tag may repeat, --name=value is accepted, and the
// remaining positional values keep their old meaning.
function parseFlags(tokens) {
  const flags = { tags: [] };
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(token);
    if (!match) {
      positional.push(token);
      continue;
    }
    const value = match[2] ?? tokens[++index];
    if (value === undefined) throw new Error('missing_value_for_' + match[1]);
    if (match[1] === 'tag') flags.tags.push(value);
    else flags[match[1]] = value;
  }
  return { flags, positional };
}

async function main([socketPath, command, id, argument, ...rest]) {
  const send = (frame) => request(socketPath, { ...frame, bridge: process.env.AGENTDESK_BRIDGE || undefined }, 920000);
  const files = new RemoteFiles({
    request: (_route, task_id, kind, body) => send({ operation: 'bridge', task_id, kind, body }),
  });
  if (command === 'quotas') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'quota_status' } });
  }
  if (command === 'ls' || command === 'doctor') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: command === 'ls' ? 'list' : 'doctor' } });
  }
  if (command === 'report') {
    const { flags } = parseFlags([id, argument, ...rest].filter((value) => value !== undefined));
    return send({ kind: 'task.status', task_id: randomUUID(), body: {
      operation: 'report',
      ...(flags.since !== undefined && { since: flags.since }),
      ...(flags.until !== undefined && { until: flags.until }),
      ...(flags.owner !== undefined && { owner: flags.owner }),
      ...(flags.project !== undefined && { project: flags.project }),
      ...(flags.tags.length && { tags: flags.tags }),
      ...(flags.format !== undefined && { format: flags.format }),
    } });
  }
  if (command === 'benchmark' && id) {
    const { flags } = parseFlags([argument, ...rest].filter((value) => value !== undefined));
    return send({ kind: 'task.status', task_id: randomUUID(), body: {
      operation: 'benchmark', benchmarkId: id,
      ...(flags.format !== undefined && { format: flags.format }),
    } });
  }
  if (command === 'submit' && id && argument) {
    const { flags, positional } = parseFlags(rest);
    const benchmarkId = flags['benchmark-id'] ?? flags.benchmarkId;
    return send({ kind: 'task.request', task_id: randomUUID(), body: {
      workspace: id, prompt: argument,
      ...(positional[0] !== undefined && { command: positional[0] }),
      ...(flags.tags.length && { tags: flags.tags }),
      ...(flags.project !== undefined && { project: flags.project }),
      ...(benchmarkId !== undefined && { benchmarkId }),
      ...(flags.arm !== undefined && { arm: flags.arm }),
    } });
  }
  if (['status', 'cancel', 'apply', 'reconcile'].includes(command) && id) {
    return send({ kind: 'task.status', task_id: id, body: { operation: command, after: Number(argument) || 0 } });
  }
  if (command === 'route' && ['ssh', 'relay'].includes(id)) {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'select_route', route: id } });
  }
  if (command === 'bridge' && id && argument && rest[0]) {
    return send({ operation: 'bridge', kind: argument, task_id: id, body: JSON.parse(rest[0]) });
  }
  if (command === 'upload' && id && argument) {
    if ((await fs.stat(argument)).size > 20 * 1024 * 1024) throw new Error('file_too_large');
    const stream_id = rest[0] || randomUUID();
    try {
      await files.upload(null, id, await fs.readFile(argument), stream_id);
    } catch (error) {
      error.streamId = stream_id;
      throw error;
    }
    return { stream_id };
  }
  if (command === 'download' && id && argument && rest[0]) {
    const bytes = await files.download(null, id, JSON.parse(rest[0]));
    await fs.writeFile(argument, bytes, { flag: 'wx', mode: 0o600 });
    return { path: argument, size: bytes.length };
  }
  throw new Error('Usage: admin.js <socket> ls | doctor | quotas | report [--since ISO] [--until ISO] [--owner O] [--project P] [--tag T] [--format json|table|csv] | benchmark <benchmark-id> [--format json|table|csv] | submit <workspace> <prompt> [test-command] [--tag T] [--project P] [--benchmark-id ID] [--arm single|multi] | status <task-id> [after] | cancel <task-id> | apply <task-id> | reconcile <task-id> | route <ssh|relay> | bridge <task-id> <kind> <json> | upload <task-id> <file> [stream-id] | download <task-id> <output> <json>');
}

main(process.argv.slice(2)).then((value) => {
  console.log(JSON.stringify({ ok: true, value }, null, 2));
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, request_id: error.requestId, stream_id: error.streamId }));
  process.exitCode = 1;
});
