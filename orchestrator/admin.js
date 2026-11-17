const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { request } = require('./mcp');
const { RemoteFiles } = require('./windows');

async function main([socketPath, command, id, argument, ...rest]) {
  const send = (frame) => request(socketPath, { ...frame, bridge: process.env.AGENTDESK_BRIDGE || undefined }, 920000);
  const files = new RemoteFiles({
    request: (_route, task_id, kind, body) => send({ operation: 'bridge', task_id, kind, body }),
  });
  if (command === 'quotas') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'quota_status' } });
  }
  if (command === 'submit' && id && argument) {
    return send({ kind: 'task.request', task_id: randomUUID(), body: { workspace: id, prompt: argument, command: rest[0] } });
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
  throw new Error('Usage: admin.js <socket> submit <workspace> <prompt> [test-command] | status <task-id> [after] | cancel <task-id> | apply <task-id> | reconcile <task-id> | route <ssh|relay> | bridge <task-id> <kind> <json> | upload <task-id> <file> [stream-id] | download <task-id> <output> <json>');
}

main(process.argv.slice(2)).then((value) => {
  console.log(JSON.stringify({ ok: true, value }, null, 2));
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, request_id: error.requestId, stream_id: error.streamId }));
  process.exitCode = 1;
});
