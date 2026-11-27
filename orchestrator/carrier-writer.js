// Bytes for a carrier process on VPS2 (command/exec/write through the codex app-server). Each write is one request
// that waits for its reply; sending every frame as its own request made each keystroke wait behind every earlier
// frame (SFTP of the project included), one round trip apiece. Here at most one write is in flight, and the next
// one carries everything that arrived meanwhile: a keystroke waits for at most the write already on its way.
function createCarrierWriter({ write, onError, limit = 8 * 1024 * 1024, maxChunk = 1024 * 1024 }) {
  const outbox = [];
  let pending = 0;
  let writing = false;
  let failed = false;
  const pump = () => {
    if (writing || failed || !outbox.length) return;
    const parts = [];
    let size = 0;
    while (outbox.length && (size === 0 || size + outbox[0].length <= maxChunk)) {
      const part = outbox.shift();
      parts.push(part);
      size += part.length;
    }
    const chunk = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    writing = true;
    Promise.resolve().then(() => write(chunk)).then(() => {
      writing = false;
      pending -= chunk.length;
      pump();
    }, (error) => { failed = true; onError(error); });
  };
  return {
    push(data) {
      if (failed) return;
      pending += data.length;
      if (pending > limit) { failed = true; onError(new Error('native_channel_backpressure')); return; }
      outbox.push(data);
      pump();
    },
    get pending() { return pending; },
  };
}

module.exports = { createCarrierWriter };
