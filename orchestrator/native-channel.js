const { EventEmitter } = require('node:events');

const LIMIT = 64 * 1024;
const VERSION = 1;
const NATIVE_PROVIDERS = Object.freeze(['codex', 'claude', 'grok', 'antigravity']);
const channelTypes = new Set(['s', 'p', 'c']);
// Native CLI single chats (native-tui-host.js): terminal bytes, the tool relay and file uploads instead of 'p'.
const TUI_TYPES = Object.freeze(['s', 't', 'c', 'm', 'u']);

// SFTP and provider JSON-RPC are separate byte streams. Frames never contain an operating-system
// path granting authority, and the provider process never receives the SFTP/control channels.
class NativeChannel extends EventEmitter {
  constructor(input, output, types = channelTypes) {
    super();
    this.output = output;
    this.types = types instanceof Set ? types : new Set(types);
    let buffer = Buffer.alloc(0);
    input.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const size = buffer.readUInt32BE(0);
        const type = String.fromCharCode(buffer[4]);
        if (!size || size > LIMIT || !this.types.has(type)) {
          input.destroy();
          this.emit('failure', new Error('invalid_native_channel_frame'));
          return;
        }
        if (buffer.length < 5 + size) return;
        const data = buffer.subarray(5, 5 + size);
        buffer = buffer.subarray(5 + size);
        this.emit(type, data);
      }
    });
    input.once('error', (error) => this.emit('failure', error));
    input.once('end', () => this.emit('end'));
    output.once('error', (error) => this.emit('failure', error));
  }

  send(type, bytes) {
    if (!this.types.has(type) || this.output.destroyed || this.output.writableEnded) throw new Error('native_channel_closed');
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (this.output.writableLength + data.length > 8 * 1024 * 1024) throw new Error('native_channel_backpressure');
    for (let offset = 0; offset < data.length; offset += LIMIT) {
      const payload = data.subarray(offset, offset + LIMIT);
      const header = Buffer.alloc(5);
      header.writeUInt32BE(payload.length);
      header[4] = type.charCodeAt(0);
      this.output.write(Buffer.concat([header, payload]));
    }
  }
}

module.exports = { NativeChannel, VERSION, NATIVE_PROVIDERS, TUI_TYPES };
