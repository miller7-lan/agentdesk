const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { connect } = require('node:tls');

const MAX_FRAME = 192 * 1024;

function encode(frame) {
  return JSON.stringify(frame).replace(/[^\x00-\x7f]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
}

function messageId() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

class Lines extends EventEmitter {
  constructor(input, output = input, limit = MAX_FRAME) {
    super();
    this.output = output;
    this.limit = limit;
    let remainder = Buffer.alloc(0);
    input.on('data', (chunk) => {
      remainder = Buffer.concat([remainder, chunk]);
      let end;
      try {
        while ((end = remainder.indexOf(10)) !== -1) {
          if (end >= limit) throw new Error('frame_too_large');
          const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(remainder.subarray(0, end)));
          remainder = remainder.subarray(end + 1);
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid_frame');
          this.emit('frame', frame);
        }
        if (remainder.length >= limit) throw new Error('frame_too_large');
      } catch (error) {
        input.destroy();
        this.emit('fault', error);
      }
    });
    input.once('close', () => this.emit('closed'));
    input.on('error', (error) => this.emit('fault', error));
  }

  send(frame) {
    const data = encode(frame);
    if (Buffer.byteLength(data) > this.limit) throw new Error('frame_too_large');
    if (this.output.destroyed || this.output.writableEnded) throw new Error('transport_closed');
    if (this.output.writableLength > this.limit * 8) throw new Error('transport_backpressure');
    this.output.write(data);
  }
}

class Relay extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.delay = 1000;
  }

  start() {
    this.stopped = false;
    this.dial();
  }

  dial() {
    const { host, port = 22022, ca, servername, deviceId, token, role } = this.config;
    const socket = this.socket = connect({ host, port, ca, ...(servername ? { servername } : {}), minVersion: 'TLSv1.2' });
    const wire = new Lines(socket);
    this.wire = wire;
    let pongDeadline;
    const helloDeadline = setTimeout(() => socket.destroy(), 10000);
    let heartbeat;
    wire.on('fault', (error) => this.emit('fault', error.code || error.message));
    socket.once('secureConnect', () => {
      try { wire.send({ type: 'hello', version: 1, device_id: deviceId, token }); }
      catch { socket.destroy(); }
    });
    wire.on('frame', (frame) => {
      if (frame.type === 'protocol_error') {
        this.emit('fault', frame.code);
        socket.destroy();
        return;
      }
      if (frame.type === 'welcome') {
        if (frame.version !== 1 || frame.device_id !== deviceId || frame.role !== role || this.ready) {
          socket.destroy();
          return;
        }
        clearTimeout(helloDeadline);
        this.ready = true;
        this.peer = frame.peer_id;
        this.online = frame.peer_online;
        this.delay = 1000;
        heartbeat = setInterval(() => {
          try {
            wire.send({ type: 'ping', device_id: deviceId });
            pongDeadline = setTimeout(() => socket.destroy(), 10000);
          } catch {
            socket.destroy();
          }
        }, 20000);
        this.emit('ready');
      } else if (!this.ready) {
        socket.destroy();
      } else if (frame.type === 'pong') {
        clearTimeout(pongDeadline);
      } else if (frame.type === 'presence' && frame.device_id === this.peer) {
        this.online = frame.online;
        this.emit('presence', this.online);
      } else if (frame.type === 'data' && frame.device_id === this.peer) {
        this.emit('data', frame);
      } else if (frame.type === 'receipt') {
        this.emit('receipt', frame);
      }
    });
    socket.once('close', () => {
      clearTimeout(helloDeadline);
      clearTimeout(pongDeadline);
      clearInterval(heartbeat);
      this.ready = this.online = false;
      this.emit('closed');
      if (!this.stopped) {
        this.retry = setTimeout(() => this.dial(), this.delay * (0.8 + Math.random() * 0.2));
        this.delay = Math.min(30000, this.delay * 2);
      }
    });
  }

  send(frame) {
    if (!this.ready) throw new Error('relay_disconnected');
    this.wire.send({ ...frame, device_id: this.config.deviceId });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }
}

module.exports = { Lines, Relay, messageId, encode, MAX_FRAME };
