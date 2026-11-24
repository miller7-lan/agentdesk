'use strict';
// 管理员会话里 CLI 操作关联电脑的工具服务。
// CLI 通过 orchestrator/mcp.js（scope remote）连本服务的 unix socket；每次运行发一个一次性 capability，
// 只能操作这次会话选中的那台电脑，并且只能往这次任务的目录里存截屏/取回的文件。
// 真正的操作由 devices.js 经主控 admin.sock 转给电脑上的 Bridge：
//   文件：整机读写（Bridge 配置 readAnyFolder + writeAnyFolder；覆盖前 Bridge 先备份，删除进废纸篓）
//   命令：group_shell（Mac 上凭据目录仍被沙箱挡住）
//   桌面：截屏、点击、输入（Bridge 配置 desktop: true）
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { Lines } = require('../transport');

const READS = new Set(['locations', 'list', 'stat', 'search', 'grep', 'read', 'read_batch', 'glob', 'grep_context']);
const WRITES = new Set(['write_batch', 'edit', 'mkdir', 'move', 'delete']);
const MAX_PUSH = 20 * 1024 * 1024;

function inside(dir, relative) {
  const target = path.resolve(dir, String(relative || ''));
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('path_outside_task');
  return target;
}

function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) candidate = `${base} (${n})${ext}`;
  return path.join(dir, candidate);
}

class RemoteTools {
  constructor({ socket, devices, log = () => {} }) {
    this.socket = socket;
    this.devices = devices;
    this.log = log;
    this.grants = new Map();
  }

  // 一次 CLI 运行一个 capability；运行结束 revoke。
  grant({ user, device, dir }) {
    const capability = randomBytes(24).toString('hex');
    this.grants.set(capability, { user, device, dir, taskId: randomUUID() });
    return capability;
  }

  revoke(capability) { this.grants.delete(capability); }

  mcp(capability) { return { socket: this.socket, capability, scope: 'remote', scopeArg: true }; }

  listen() {
    try { if (fs.lstatSync(this.socket).isSocket()) fs.unlinkSync(this.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.server = net.createServer((socket) => {
      const wire = new Lines(socket);
      wire.on('fault', () => socket.destroy());
      wire.once('frame', async (frame) => {
        try {
          const value = await this.handle(frame);
          if (!socket.destroyed) wire.send({ ok: true, value });
        } catch (error) {
          if (!socket.destroyed) wire.send({ ok: false, error: String(error?.message || error).slice(0, 500) });
        }
      });
    });
    this.server.listen(this.socket, () => fs.chmodSync(this.socket, 0o600));
    return this.server;
  }

  close() { this.server?.close(); }

  async handle(frame) {
    const grant = this.grants.get(frame.capability);
    if (!grant) throw new Error('permission_denied');
    const { device, taskId } = grant;
    const op = frame.operation;
    const call = (kind, body, timeout) => this.devices.bridge(device, kind, body, timeout, taskId);
    this.log('remote', device.id, op);
    if (READS.has(op)) {
      return call('file.read', { operation: op, root: op === 'locations' ? undefined : 'computer', anyFolder: true, path: frame.path,
        query: frame.query, offset: frame.offset, version: frame.version, caseSensitive: frame.caseSensitive === true,
        glob: frame.glob, context: frame.context, items: frame.items });
    }
    if (op === 'write') {
      // 单个 write 在 Bridge 上只收流；转成一项 write_batch。
      const reply = await call('file.write', { operation: 'write_batch', root: 'computer', anyFolder: true, backup: true,
        items: [{ path: frame.path, version: frame.version ?? null, content: frame.content, encoding: frame.encoding || 'utf8' }] });
      const result = reply?.results?.[0];
      if (result?.status !== 'written') throw new Error(result?.error || 'write_failed');
      return { type: 'file', size: result.bytes, version: result.version };
    }
    if (WRITES.has(op)) {
      return call('file.write', { operation: op, root: 'computer', anyFolder: true, backup: true, path: frame.path, destination: frame.destination,
        version: frame.version ?? (op === 'mkdir' ? null : frame.version), items: frame.items, oldText: frame.oldText, newText: frame.newText, replaceAll: frame.replaceAll });
    }
    if (op === 'shell') {
      const timeout = Number.isSafeInteger(frame.timeout_ms) ? Math.min(frame.timeout_ms, 900_000) : 300_000;
      const value = await call('command.execute', { operation: 'group_shell', script: frame.script, shell: frame.shell, timeout_ms: timeout }, timeout + 30_000);
      const tail = (text) => typeof text === 'string' && text.length > 8000 ? '…' + text.slice(-8000) : text;
      return { code: value.code, stdout: tail(value.stdout), stderr: tail(value.stderr) };
    }
    if (op === 'desktop') return call('task.request', { operation: 'desktop', tool: frame.tool, arguments: frame.arguments }, 55_000);
    if (op === 'desktop_image') return call('file.read', { operation: 'artifact', stream_id: frame.stream_id, offset: frame.offset }, 30_000);
    if (op === 'screenshot_save') {
      const out = path.join(grant.dir, 'out');
      const shot = await this.devices.screenshot(device, out);
      const wanted = path.basename(String(frame.filename || '')).replace(/[^\p{L}\p{N}._ -]/gu, '') || path.basename(shot);
      const target = freeName(out, /\.png$/i.test(wanted) ? wanted : wanted + '.png');
      fs.renameSync(shot, target);
      return { saved: path.relative(grant.dir, target), size: fs.statSync(target).size };
    }
    if (op === 'fetch') {
      const out = path.join(grant.dir, 'out');
      fs.mkdirSync(out, { recursive: true, mode: 0o700 });
      const chunks = [];
      let size = Infinity;
      for (let offset = 0; offset < size;) {
        const part = await call('file.read', { operation: 'read', root: 'computer', anyFolder: true, path: frame.path, offset });
        size = part.size;
        const data = Buffer.from(part.data || '', 'base64');
        if (!data.length) break;
        chunks.push(data);
        offset += data.length;
        if (offset > 50 * 1024 * 1024) throw new Error('file_too_large');
      }
      const target = freeName(out, path.basename(String(frame.path).replace(/\\/g, '/')) || 'file');
      fs.writeFileSync(target, Buffer.concat(chunks), { mode: 0o600 });
      return { saved: path.relative(grant.dir, target), size: fs.statSync(target).size };
    }
    if (op === 'push') {
      const source = inside(grant.dir, frame.source);
      const data = fs.readFileSync(source);
      if (data.length > MAX_PUSH) throw new Error('file_too_large');
      let version = null;
      if (frame.overwrite) version = await call('file.read', { operation: 'stat', root: 'computer', anyFolder: true, path: frame.path }).then((info) => info?.version ?? null, () => null);
      const reply = await call('file.write', { operation: 'write_batch', root: 'computer', anyFolder: true, backup: true,
        items: [{ path: frame.path, version, content: data.toString('base64'), encoding: 'base64' }] }, 120_000);
      const result = reply?.results?.[0];
      if (result?.status !== 'written') throw new Error(result?.error || 'write_failed');
      return { written: frame.path, bytes: result.bytes };
    }
    throw new Error('unsupported_operation');
  }
}

module.exports = { RemoteTools, inside };
