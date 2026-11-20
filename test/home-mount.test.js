const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { createReadOnlySftp, packet, T, S } = require('../orchestrator/sftp-readonly');
const { Scheduler } = require('../orchestrator/scheduler');

// A tiny SFTP client over a stream pair, enough to drive the read-only server.
function client(root, options = {}) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  createReadOnlySftp({ root, ...options })(toServer, fromServer);
  let buffer = Buffer.alloc(0);
  const waiting = [];
  fromServer.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      waiting.shift()(body);
    }
  });
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const str = (v) => { const d = Buffer.from(v); return Buffer.concat([u32(d.length), d]); };
  let id = 0;
  const call = (type, ...parts) => new Promise((resolve) => { waiting.push(resolve); toServer.write(packet(type, [u32(++id), ...parts])); });
  const statusOf = (body) => body[0] === T.STATUS ? body.readUInt32BE(5) : null;
  const handleOf = (body) => { const n = body.readUInt32BE(5); return body.subarray(9, 9 + n); };
  const names = (body) => {
    if (body[0] !== T.NAME) return [];
    let offset = 5; const count = body.readUInt32BE(offset); offset += 4; const out = [];
    for (let i = 0; i < count; i += 1) {
      const n = body.readUInt32BE(offset); out.push(body.subarray(offset + 4, offset + 4 + n).toString()); offset += 4 + n;
      offset += 4 + body.readUInt32BE(offset);          // longname
      const flags = body.readUInt32BE(offset); offset += 4;
      if (flags & 1) offset += 8; if (flags & 2) offset += 8; if (flags & 4) offset += 4; if (flags & 8) offset += 8;
    }
    return out;
  };
  return {
    async init() { return new Promise((resolve) => { waiting.push(resolve); toServer.write(packet(T.INIT, [u32(3)])); }); },
    async list(dir) {
      const opened = await call(T.OPENDIR, str(dir));
      if (opened[0] !== T.HANDLE) return statusOf(opened);
      const handle = handleOf(opened); const all = [];
      for (;;) { const r = await call(T.READDIR, Buffer.concat([u32(handle.length), handle])); if (r[0] !== T.NAME) break; all.push(...names(r)); }
      await call(T.CLOSE, Buffer.concat([u32(handle.length), handle]));
      return all.sort();
    },
    async read(file) {
      const opened = await call(T.OPEN, str(file), u32(1), u32(0));
      if (opened[0] !== T.HANDLE) return statusOf(opened);
      const handle = Buffer.concat([u32(handleOf(opened).length), handleOf(opened)]);
      const offset = Buffer.alloc(8);
      const data = await call(T.READ, handle, offset, u32(1000));
      await call(T.CLOSE, handle);
      return data.subarray(9, 9 + data.readUInt32BE(5)).toString();
    },
    async openForWrite(file) { return statusOf(await call(T.OPEN, str(file), u32(0x2 | 0x8), u32(0))); },
    async remove(file) { return statusOf(await call(T.REMOVE, str(file))); },
  };
}

test('the Bridge serves the home folder read-only, without credential folders or ways out', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-home-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, 'home');
  const alias = path.join(fixture, 'home-alias');
  fs.mkdirSync(path.join(home, 'proj', 'src'), { recursive: true });
  fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.mkdirSync(path.join(home, 'bridge-state'));
  fs.writeFileSync(path.join(home, 'proj', 'src', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'SECRET');
  fs.writeFileSync(path.join(home, 'bridge-state', 'key'), 'SECRET');
  if (process.platform !== 'win32') {
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'note.txt'), 'outside fixture');
    fs.symlinkSync(outside, path.join(home, 'proj', 'out'));
  }
  const sftp = client(alias, { hidden: [path.join(alias, 'bridge-state')] });
  const version = await sftp.init();
  assert.equal(version[0], T.VERSION);
  assert.deepEqual(await sftp.list('/'), ['proj']);                      // .ssh and the Bridge's state are not listed
  assert.deepEqual(await sftp.list('/proj'), ['src']);                   // a link that leaves the home folder is not either
  assert.equal(await sftp.read('/proj/src/a.js'), 'console.log(1)');
  assert.equal(await sftp.read('/.ssh/id_ed25519'), S.PERMISSION_DENIED);
  assert.equal(await sftp.read('/bridge-state/key'), S.PERMISSION_DENIED);
  assert.equal(await sftp.read('/../../etc/hostname'), S.PERMISSION_DENIED);
  if (process.platform !== 'win32') assert.equal(await sftp.read('/proj/out/note.txt'), S.PERMISSION_DENIED);
  assert.equal(await sftp.openForWrite('/proj/src/a.js'), S.PERMISSION_DENIED);
  assert.equal(await sftp.remove('/proj/src/a.js'), S.PERMISSION_DENIED);
  assert.equal(fs.readFileSync(path.join(home, 'proj', 'src', 'a.js'), 'utf8'), 'console.log(1)');
});

test('the SSH gateway sends only the exact mount word to the mount socket', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const servers = ['main', 'mount'].map((name) => net.createServer((socket) => { seen.push(name); socket.end(name); }).listen(path.join(dir, name + '.sock')));
  t.after(() => servers.forEach((server) => server.close()));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = (command) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'orchestrator', 'ssh-gateway.js'), path.join(dir, 'main.sock'), path.join(dir, 'mount.sock')],
      { env: { ...process.env, SSH_ORIGINAL_COMMAND: command } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out));
    child.stdin.end();
  });
  assert.equal(await run('agentdesk-mount'), 'mount');
  assert.equal(await run('agentdesk-mount; rm -rf /'), 'main');
  assert.equal(await run(''), 'main');
});

test('reading goes by duty: with the mount up, read duties read it directly and the lead and the writer keep their tools', async () => {
  const calls = [];
  const self = Object.create(Scheduler.prototype);
  Object.assign(self, {
    config: { stateDir: os.tmpdir(), mcp: { socket: '/tmp/x.sock', capabilities: new Map() }, workspaces: { mac: { sshBridge: 'mac' } },
      adapters: { codex: {}, claude: {}, grok: {}, antigravity: {} } },
    mounts: new Map([['mac', { path: '/state/mounts/mac' }]]),
    files: { call: async () => ({ relative: 'work/proj' }) },
    bridgeRoute: () => 'ssh:mac', spillOver() {}, acquireCli: async () => () => {}, recordCall() {}, recordUsage() {}, cliBudget: () => ({}),
    save() {}, adapter: async (options) => { calls.push(options); return { output: 'ok' }; },
  });
  const task = { id: 't', workspace: 'mac', steps: [] };
  const run = (step) => S.invoke.call(self, task, step, '/tmp', new AbortController().signal, 'do it');
  const S = Scheduler.prototype;
  await run({ id: 'look', role: 'grok', capability: 'review' });
  await run({ id: 'edit', role: 'codex', capability: 'implement', write: true });
  await run({ id: 'group-planner', role: 'claude', capability: 'plan' });
  assert.deepEqual(calls.map((call) => [Boolean(call.mcp), call.readPaths]), [
    [false, ['/state/mounts/mac']],     // review: reads the mount, no Bridge tools
    [true, ['/state/mounts/mac']],      // implement: also keeps the write tools
    [true, ['/state/mounts/mac']],      // the lead: also reaches folders outside the home folder
  ]);
  assert.match(calls[0].prompt, /mounted read-only at \/state\/mounts\/mac; this task.s project on their computer is \/state\/mounts\/mac\/work\/proj/);
  // The mount is down: read duties read through the Bridge tools again.
  self.mounts.clear();
  await run({ id: 'look2', role: 'grok', capability: 'review' });
  assert.equal(Boolean(calls.at(-1).mcp), true);
  assert.deepEqual(calls.at(-1).readPaths, []);
});

test('VPS2 mounts each Bridge home with sshfs in passive, read-only mode over the mount socket', { skip: process.platform === 'win32' }, async (t) => {
  const { serveMounts } = require('../orchestrator/home-mount');
  const { EventEmitter } = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mnt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned = [];
  const spawnProcess = (bin, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit');
    let got = '';
    child.stdin.on('data', (chunk) => { got += chunk; if (got === 'sftp-hello') child.stdout.write('sftp-reply'); });
    spawned.push({ bin, args });
    return child;
  };
  const stop = serveMounts({ stateDir: dir, sshBridges: ['mac'], homeMounts: { sshfs: '/x/sshfs', fusermount: '/bin/true' } }, { log: () => {}, spawnProcess });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reply = await new Promise((resolve) => {
    const socket = net.connect(path.join(dir, 'bridge-mac-mount.sock'), () => socket.write('sftp-hello'));
    socket.on('data', (chunk) => { resolve(String(chunk)); socket.end(); });
  });
  assert.equal(reply, 'sftp-reply');                 // the SFTP stream reaches sshfs and back
  assert.equal(spawned[0].bin, '/x/sshfs');
  assert.deepEqual(spawned[0].args, ['-f', '-o', 'passive,ro,idmap=user,dir_cache=yes,dcache_timeout=5', ':/', path.join(dir, 'mounts', 'mac')]);
});
