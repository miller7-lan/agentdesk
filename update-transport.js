'use strict';
// The loopback feed: electron-updater only speaks HTTP(S), while the update files live on VPS2 and reach this
// computer only through the existing SSH control channel (client_update_read). This small server listens on
// 127.0.0.1, under a random path and Basic-auth credentials, serves exactly the files the validated manifest lists,
// and turns each HTTP request (including single Range requests, which differential download uses) into reads over
// the control channel. It does not compute or apply any patch itself: block maps, differential download, full
// download fallback and sha512 checks all stay in electron-updater.

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { latestYaml, feedFileName } = require('./orchestrator/update-manifest');

// Bounded by the control channel: one frame is at most MAX_FRAME (192 KiB, orchestrator/transport.js) and carries
// the chunk base64-encoded, so 128 KiB of raw bytes (about 171 KiB encoded) is the largest safe read.
const READ_CHUNK = 128 * 1024;

function parseRange(header, size) {
  if (header === undefined) return { full: true };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { multiple: String(header).includes(',') };
  let start;
  let end;
  if (match[1] === '') {
    if (match[2] === '') return { invalid: true };
    const suffix = Number(match[2]);
    if (!suffix) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

// read(name, offset, length) → Buffer of exactly min(length, size - offset) bytes, from VPS2.
// Reads in flight at once. Each read is a round trip over SSH (often through the VPS1 jump host), so one at a time
// leaves the line idle most of the time; a few in flight keep it busy without flooding the control channel.
const PARALLEL_READS = 4;

function createLoopbackFeed({ manifest, read, chunk = READ_CHUNK, parallel = PARALLEL_READS, now = () => new Date() }) {
  const token = randomBytes(16).toString('hex');
  const user = 'agentdesk';
  const password = randomBytes(24).toString('base64url');
  const expected = Buffer.from('Basic ' + Buffer.from(user + ':' + password).toString('base64'));
  const yaml = latestYaml(manifest, now().toISOString());
  const yamlName = feedFileName(manifest.platform);
  const files = new Map([...manifest.files, ...manifest.previousBlockmaps].map((entry) => [entry.name, entry]));
  const stats = { requests: 0, rangeRequests: 0, multiRangeRequests: 0, bytesFromServer: 0, perFile: {} };
  const sockets = new Set();

  async function stream(response, entry, start, end) {
    let offset = start;
    let next = start;
    const ahead = [];
    // Keep up to `parallel` reads running ahead of what has been written; bytes still go out strictly in order.
    const fill = () => {
      while (ahead.length < parallel && next <= end) {
        const length = Math.min(chunk, end - next + 1);
        const pending = read(entry.name, next, length).then(bytes => ({ bytes, length }));
        pending.catch(() => {});
        ahead.push(pending);
        next += length;
      }
    };
    while (offset <= end) {
      fill();
      const { bytes, length } = await ahead.shift();
      if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw new Error('update_read_short');
      stats.bytesFromServer += bytes.length;
      stats.perFile[entry.name] = (stats.perFile[entry.name] || 0) + bytes.length;
      offset += bytes.length;
      // Each wait removes its own listeners, so a long download does not pile them up on the response.
      if (!response.write(bytes)) await new Promise((resolve, reject) => {
        const drained = () => { response.off('close', closed); resolve(); };
        const closed = () => { response.off('drain', drained); reject(new Error('update_client_closed')); };
        response.once('drain', drained);
        response.once('close', closed);
      });
    }
  }

  const server = http.createServer((request, response) => {
    stats.requests++;
    const deny = (code) => { response.writeHead(code, { 'Content-Length': 0 }); response.end(); };
    const auth = Buffer.from(String(request.headers.authorization || ''));
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny(401);
    if (!['GET', 'HEAD'].includes(request.method)) return deny(405);
    const prefix = '/' + token + '/';
    const url = String(request.url || '').split('?')[0];
    if (!url.startsWith(prefix)) return deny(404);
    const name = decodeURIComponent(url.slice(prefix.length));
    if (name === yamlName) {
      response.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': Buffer.byteLength(yaml), 'Cache-Control': 'no-store' });
      return response.end(request.method === 'HEAD' ? undefined : yaml);
    }
    const entry = files.get(name);
    if (!entry) return deny(404);
    const range = parseRange(request.headers.range, entry.size);
    if (range.invalid) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + entry.size, 'Content-Length': 0 });
      return response.end();
    }
    let start = 0;
    let end = entry.size - 1;
    let status = 200;
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range.multiple) {
      // Multipart byte ranges are not served: the updater is configured for one range per request, and a 200 with
      // the whole file makes it fall back to a full download rather than mis-assemble anything.
      stats.multiRangeRequests++;
    } else if (!range.full) {
      ({ start, end } = range);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
      stats.rangeRequests++;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') return response.end();
    stream(response, entry, start, end).then(() => response.end(), () => response.destroy());
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });

  return {
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve({ url: `http://127.0.0.1:${port}/${token}/`, headers: { Authorization: expected.toString() } });
        });
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// The feed URL handed to electron-updater: only the address this process generated for itself.
function loopbackFeedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\/[0-9a-f]{32}\/$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

// Reads one file range from VPS2 through the control channel, chunk by chunk, checking every reply.
// A refused request (wrong file, version no longer offered, changed file) fails at once; anything else (a slow or
// dropped line, the Bridge reconnecting) is retried a few times before the download gives up.
const FINAL_READ_ERRORS = /invalid_update|update_version_not_offered|update_file_changed|unsupported_operation|无权操作主控线路/;

function controlChannelReader(control, { version, platform, arch, chunk = READ_CHUNK, attempts = 5, backoff = 1000 } = {}) {
  const ask = async (request) => {
    for (let attempt = 1; ; attempt++) {
      let reply;
      try { reply = await control(request); } catch (error) { reply = { ok: false, error: error.message }; }
      if (reply?.ok) return reply;
      const message = reply?.error || 'update_read_failed';
      if (attempt >= attempts || FINAL_READ_ERRORS.test(message)) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, backoff * attempt));
    }
  };
  return async (name, offset, length) => {
    const parts = [];
    let position = offset;
    const end = offset + length;
    while (position < end) {
      const want = Math.min(chunk, end - position);
      const reply = await ask({ operation: 'client_update_read', update: { platform, arch, version, file: name, offset: position, length: want } });
      const value = reply.value || {};
      const data = Buffer.from(typeof value.data === 'string' ? value.data : '', 'base64');
      if (value.file !== name || value.offset !== position || !data.length || data.length > want) throw new Error('invalid_update_chunk');
      parts.push(data);
      position += data.length;
    }
    return Buffer.concat(parts);
  };
}

module.exports = { createLoopbackFeed, loopbackFeedUrl, controlChannelReader, parseRange, READ_CHUNK, PARALLEL_READS };
