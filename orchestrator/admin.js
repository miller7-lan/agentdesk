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

// `device` runs locally against the registry file (as root), not through the orchestrator socket.
// N1: it only changes the registry and prints suggested authorized_keys lines; it never writes SSH files.
function deviceCommand([action, deviceId, ...rest]) {
  const registry = require('./device-registry');
  const file = process.env.AGENTDESK_DEVICES || registry.DEFAULT_REGISTRY;
  const { flags, positional } = parseFlags(rest);
  const notice = '本命令只修改设备登记表，未改动任何 SSH 授权文件。请先在 /root/backups/ 备份 authorized_keys，再手动增删上面的 key 行。';
  if (action === 'list') return { registry: file, devices: registry.list(file) };
  if (action === 'approve' && deviceId) {
    const result = registry.approve(file, { deviceId, platform: flags.platform, label: flags.label, pubkey: flags.pubkey,
      channels: flags.channels, bridge: flags.bridge, legacyTag: flags['legacy-tag'], by: process.env.SUDO_USER || process.env.USER || 'admin' });
    return { ...result, notice };
  }
  if (action === 'revoke' && deviceId) return { ...registry.revoke(file, deviceId, { by: process.env.SUDO_USER || 'admin' }), notice };
  if (action === 'rename' && deviceId && positional[0]) return registry.rename(file, deviceId, positional.join(' '));
  if (action === 'v2' && deviceId && ['on', 'off'].includes(positional[0])) return registry.setDirectChatV2(file, deviceId, positional[0] === 'on');
  throw new Error('Usage: admin.js - device list | approve <deviceId> --platform darwin|win32 --label <名称> --pubkey \'<公钥>\' ' +
    '[--channels chat-claude,chat-grok,chat-antigravity,codex,bridge] [--bridge <name>] [--legacy-tag <tag>] | revoke <deviceId> | ' +
    'rename <deviceId> <名称> | v2 <deviceId> on|off');
}

async function main([socketPath, command, id, argument, ...rest]) {
  if (command === 'device') return deviceCommand([id, argument, ...rest].filter((value) => value !== undefined));
  const send = (frame) => request(socketPath, { ...frame, bridge: process.env.AGENTDESK_BRIDGE || undefined }, 920000);
  const files = new RemoteFiles({
    request: (_route, task_id, kind, body) => send({ operation: 'bridge', task_id, kind, body }),
  });
  if (command === 'quotas') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'quota_status' } });
  }
  if (command === 'catalog') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'model_catalog' } });
  }
  if (command === 'ls' || command === 'doctor' || command === 'gc') {
    return send({ kind: 'task.status', task_id: randomUUID(), body: { operation: { ls: 'list', doctor: 'doctor', gc: 'cleanup' }[command] } });
  }
  if (command === 'maintenance') {
    const action = ['on', 'off'].includes(id) ? id : 'status';
    return send({ kind: 'task.status', task_id: randomUUID(), body: {
      operation: 'maintenance', action,
      ...(action === 'on' && { reason: argument || 'deployment', source: process.env.AGENTDESK_MAINTENANCE_SOURCE || 'admin.js' }),
    } });
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
  throw new Error('Usage: admin.js <socket> device … | ls | doctor | gc | maintenance [on|off] [reason] | quotas | report [--since ISO] [--until ISO] [--owner O] [--project P] [--tag T] [--format json|table|csv] | benchmark <benchmark-id> [--format json|table|csv] | submit <workspace> <prompt> [test-command] [--tag T] [--project P] [--benchmark-id ID] [--arm single|multi] | status <task-id> [after] | cancel <task-id> | apply <task-id> | reconcile <task-id> | route <ssh|relay> | bridge <task-id> <kind> <json> | upload <task-id> <file> [stream-id] | download <task-id> <output> <json>');
}

main(process.argv.slice(2)).then((value) => {
  console.log(JSON.stringify({ ok: true, value }, null, 2));
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, request_id: error.requestId, stream_id: error.streamId }));
  process.exitCode = 1;
});
