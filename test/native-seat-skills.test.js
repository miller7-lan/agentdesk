'use strict';
// A local skill (~/.codex/skills on this computer) used in a Codex native chat is written into the sandboxed
// Codex's own CODEX_HOME/agentdesk-skills through the seat, registered as an extra root and confirmed by a reload
// (orchestrator/windows-native-seat.js installSkill).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeChannel, VERSION } = require('../orchestrator/native-channel');
const { Lines } = require('../orchestrator/transport');
const { openWindowsNativeSeat } = require('../orchestrator/windows-native-seat');

const MOUNT = '/var/tmp/agentdesk-native-seat-x/windows-chat-mounts/project-y';
const HOME = '/root/.codex';

function harness({ recognise = true } = {}) {
  const remote = new EventEmitter();
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const host = new NativeChannel(hostIn, hostOut);
  const providerIn = new PassThrough();
  const providerOut = new PassThrough();
  const provider = new Lines(providerIn, providerOut, 1 << 20);
  host.on('p', (data) => providerIn.write(data));
  providerOut.on('data', (data) => host.send('p', data));
  let carrier;
  hostOut.on('data', (data) => remote.emit('notification', { method: 'command/exec/outputDelta',
    params: { processId: carrier, stream: 'stdout', deltaBase64: data.toString('base64') } }));
  remote.request = async (method, params) => {
    if (method === 'command/exec') { carrier = params.processId; setImmediate(() => host.send('c', Buffer.from(JSON.stringify({
      protocolVersion: VERSION, state: 'ready', mountPath: MOUNT })))); return new Promise(() => {}); }
    if (method === 'command/exec/write') { hostIn.write(Buffer.from(params.deltaBase64, 'base64')); return {}; }
    throw new Error('unexpected ' + method);
  };
  const worker = { request: async () => null, openSftp: async () => { const s = new PassThrough(); s.destroy = () => {}; return s; } };
  const calls = [];
  const files = new Map();
  let roots = [];
  provider.on('frame', (frame) => {
    if (!frame.method || frame.id === undefined) return;
    calls.push(frame);
    const p = frame.params || {};
    let result = {};
    if (frame.method === 'skills/list') {
      const skills = [{ name: 'imagegen', scope: 'system', path: HOME + '/skills/.system/imagegen/SKILL.md' }];
      if (recognise) for (const root of roots) for (const file of files.keys()) {
        if (file.startsWith(root + '/') && file.endsWith('/SKILL.md')) skills.push({ name: 'college-lab-report', scope: 'user', path: file, enabled: true });
      }
      result = { data: [{ cwd: p.cwds?.[0], skills }] };
    }
    if (frame.method === 'fs/writeFile') files.set(p.path, Buffer.from(p.dataBase64, 'base64').toString());
    if (frame.method === 'skills/extraRoots/set') roots = p.extraRoots;
    provider.send({ id: frame.id, result });
  });
  return { remote, worker, calls, files };
}

const pack = [{ rel: 'SKILL.md', b64: Buffer.from('---\nname: college-lab-report\n---\n').toString('base64') },
  { rel: 'references/style.md', b64: Buffer.from('风格').toString('base64') }];

test('a Codex native seat installs a local skill into its CODEX_HOME and registers the root', async () => {
  const { remote, worker, calls, files } = harness();
  const seat = await openWindowsNativeSeat({ remote, worker, identity: { threadId: 'thread-1', provider: 'codex', fullAccess: true },
    binding: {}, checkpoints: false });
  const { path } = await seat.installSkill({ name: 'college-lab-report', folder: 'college-lab-report', files: pack });
  assert.equal(path, HOME + '/agentdesk-skills/college-lab-report/SKILL.md');
  assert.equal(files.get(HOME + '/agentdesk-skills/college-lab-report/references/style.md'), '风格');
  assert.deepEqual(calls.find((c) => c.method === 'skills/extraRoots/set').params, { extraRoots: [HOME + '/agentdesk-skills'] });
  const reload = calls.filter((c) => c.method === 'skills/list').at(-1).params;
  assert.deepEqual(reload, { cwds: [MOUNT], forceReload: true });
  remote.emit('codex-down');
});

test('a native seat refuses unsafe skill paths and reports a skill Codex did not pick up', async () => {
  const { remote, worker, calls } = harness({ recognise: false });
  const seat = await openWindowsNativeSeat({ remote, worker, identity: { threadId: 'thread-1', provider: 'codex', fullAccess: true },
    binding: {}, checkpoints: false });
  for (const bad of [{ folder: '../x', files: pack }, { folder: '.system', files: pack }, { folder: 'ok', files: [{ rel: '../../auth.json', b64: '' }] },
    { folder: 'ok', files: [{ rel: '/etc/passwd', b64: '' }] }, { folder: 'ok', files: [] }]) {
    await assert.rejects(seat.installSkill({ name: 'x', ...bad }), /invalid_skill/);
  }
  assert.equal(calls.filter((c) => c.method === 'fs/writeFile').length, 0, 'nothing is written for a refused skill');
  await assert.rejects(seat.installSkill({ name: 'college-lab-report', folder: 'college-lab-report', files: pack }), /没有识别/);
  remote.emit('codex-down');
});

test('only a Codex native seat takes local skills', async () => {
  const { remote, worker } = harness();
  const seat = await openWindowsNativeSeat({ remote, worker, identity: { threadId: 'thread-1', provider: 'claude', fullAccess: true },
    binding: {}, checkpoints: false });
  await assert.rejects(seat.installSkill({ name: 'a', folder: 'a', files: pack }), /只有 Codex/);
  remote.emit('codex-down');
});
