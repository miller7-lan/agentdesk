const { EventEmitter } = require('node:events');
const { encode, MAX_FRAME, messageId } = require('./transport');

const messageLifetime = 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isLiveQuota = (kind, body) => kind === 'task.status' && body.operation === 'quota_status';

class Endpoint extends EventEmitter {
  constructor(store, handler) {
    super();
    this.store = store;
    this.handler = handler;
    this.pending = new Map();
  }

  attach(name, port) {
    this[name]?.close?.();
    this[name] = port;
    port.on('data', (frame) => {
      this.receive(name, port, frame).catch((error) => this.emit('fault', error.message));
    });
    port.on('closed', () => {
      if (name.startsWith('ssh') && this[name] === port) this[name] = null;
    });
    port.on('fault', (error) => this.emit('fault', String(error)));
    port.on('receipt', (frame) => {
      if (!['pending', 'acknowledged', 'receipt_capacity'].includes(frame.state)) {
        this.pending.get(frame.message_id)?.reject(new Error(frame.state));
      }
    });
  }

  request(route, taskId, kind, body, timeout = 30000, id = messageId(), signal) {
    const port = this[route];
    if (!port?.ready || (route.startsWith('relay') && !port.online)) return Promise.reject(new Error(route + '_unavailable'));
    const frame = { type: 'data', task_id: taskId, message_id: id, kind, body };
    const liveQuota = isLiveQuota(kind, body);
    this.store.put('sent', id, { id, route, taskId, kind, state: 'pending', ...(liveQuota && { liveQuota }) });
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (kind === 'command.execute' && body.operation === 'run') {
          this.request(route, taskId, 'command.execute', {
            operation: 'cancel', request_id: id,
          }, 5000).catch(() => {});
        }
        finish(new Error('operation_cancelled'));
      };
      const finish = (error, result) => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(Object.assign(error, { requestId: id }));
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('operation_status_unknown')), timeout);
      this.pending.set(id, { taskId, route, resolve: (v) => finish(null, v), reject: finish });
      if (signal?.aborted) {
        finish(signal.reason);
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      try { port.send(frame); } catch (error) { finish(error); }
    });
  }

  async receive(route, port, frame) {
    const { type, task_id: taskId, message_id: id, kind, body } = frame;
    if (type !== 'data' || !uuid.test(taskId) || !uuid.test(id) || !body || typeof body !== 'object' || Array.isArray(body)) return;
    const created = Number.parseInt(id.slice(0, 13).replace('-', ''), 16);
    if (id[14] !== '7' || created < Date.now() - messageLifetime || created > Date.now() + 30000) return;
    let record = this.store.get('received', id);
    if (record && record.taskId !== taskId) return;
    if (!record) {
      record = { id, taskId, state: 'running' };
      this.store.put('received', id, record);
    } else {
      this.ack(route, port, frame);
      if (record.reply && route.startsWith('ssh')) port.send(record.reply);
      return;
    }
    if (kind === 'result' || kind === 'error') {
      const request = this.store.get('sent', body.in_reply_to);
      if (request?.taskId === taskId && request.route === route) {
        this.store.put('sent', request.id, { ...request, state: 'finished', ...(!request.liveQuota && { result: body }) });
        const pending = this.pending.get(request.id);
        if (kind === 'error') {
          pending?.reject(Object.assign(new Error(body.error || 'remote_error'), { remoteConfirmed: true }));
        } else {
          pending?.resolve(body.value);
        }
      }
      this.store.put('received', id, { ...record, state: 'finished' });
      this.ack(route, port, frame);
      return;
    }

    this.ack(route, port, frame);
    let replyKind = 'result';
    let replyBody;
    try {
      replyBody = {
        value: kind === 'task.status' && body.operation === 'operation_status'
          ? this.status(taskId, body.request_id)
          : await this.handler(frame, route),
      };
    } catch (error) {
      replyKind = 'error';
      replyBody = { error: error.message };
    }
    const reply = {
      type: 'data', task_id: taskId, message_id: messageId(), kind: replyKind,
      body: { ...replyBody, in_reply_to: id },
    };
    if (Buffer.byteLength(encode(reply)) > MAX_FRAME - 512) {
      reply.kind = 'error';
      reply.body = { in_reply_to: id, error: 'response_too_large' };
    }
    this.store.put('received', id, { ...record, state: 'finished', ...(!isLiveQuota(kind, body) && { reply }) });
    if (port.ready) port.send(reply);
  }

  status(taskId, id) {
    const record = this.store.get('received', id);
    if (!record || record.taskId !== taskId) return { state: 'unknown' };
    return { state: record.state, kind: record.reply?.kind, outcome: record.reply?.body };
  }

  ack(route, port, frame) {
    if (route.startsWith('relay')) {
      try { port.send({ type: 'ack', task_id: frame.task_id, message_id: frame.message_id }); }
      catch {}
    }
  }
}

function direct(wire, close) {
  const port = new EventEmitter();
  port.ready = true;
  port.close = close;
  port.send = (frame) => wire.send(frame);
  wire.on('frame', (frame) => port.emit('data', frame));
  wire.on('fault', (error) => port.emit('fault', error.message));
  wire.on('closed', () => {
    port.ready = false;
    port.emit('closed');
  });
  return port;
}

function expireMessages(store) {
  const hex = (Date.now() - messageLifetime).toString(16).padStart(12, '0');
  store.pruneMessages(hex.slice(0, 8) + '-' + hex.slice(8));
}

module.exports = { Endpoint, direct, expireMessages };
