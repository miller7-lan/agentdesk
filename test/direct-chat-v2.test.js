const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../orchestrator/device-registry');
const { DirectChatStore } = require('../orchestrator/direct-chat-store');
const { ChatClient, ROOT } = require('./fixtures/chat-client');

// chat-server uses Unix domain sockets; it runs on VPS2 (Linux).
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

function temporary(t, prefix = 'agentdesk-v2-') {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function publicKey() {
  const { publicKey: key } = generateKeyPairSync('ed25519');
  // OpenSSH wire format of an ed25519 key: string "ssh-ed25519", string <32 bytes>.
  const raw = key.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encode = (buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length); return Buffer.concat([length, buffer]); };
  return 'ssh-ed25519 ' + Buffer.concat([encode(Buffer.from('ssh-ed25519')), encode(raw)]).toString('base64') + ' test@example';
}

const MAC = '6f0c7a1e-2b4d-4c11-9a5e-0d3b2c1a9f10';
const WIN = 'lenovo_actjm6t3';

function setup(t, { v2 = true } = {}) {
  const state = temporary(t);
  const file = path.join(state, 'devices.json');
  registry.approve(file, { deviceId: MAC, platform: 'darwin', label: 'Mac', pubkey: publicKey(), legacyTag: 'default' });
  registry.approve(file, { deviceId: WIN, platform: 'win32', label: 'Lenovo', pubkey: publicKey() });
  if (v2) { registry.setDirectChatV2(file, MAC, true); registry.setDirectChatV2(file, WIN, true); }
  return { state, file };
}

function client(t, provider, { state, file }, deviceId, platform, extra = {}) {
  return new ChatClient(t, provider, state, { AGENTDESK_DEVICES: file, AGENTDESK_DEVICE: deviceId, AGENTDESK_PLATFORM: platform, ...extra }).start();
}

const hello = (deviceId, platform) => ({ device: { deviceId, platform, protocolVersion: 2, appVersion: '0.3.0', capabilities: ['attachmentsV2'] } });

async function open(chat, localRoot = '/Users/example/project') {
  const { thread } = await chat.request('thread/start', { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, localRoot, projectId: 'p1' });
  return thread.id;
}

test('A2: a hello that disagrees with the key identity is refused; matching hello opens v2', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await assert.rejects(chat.request('initialize', hello(WIN, 'win32')), /DEVICE_MISMATCH/);
  await assert.rejects(chat.request('initialize', hello(MAC, 'win32')), /DEVICE_MISMATCH/);
  await assert.rejects(chat.request('thread/start', {}), /HELLO_REQUIRED/);
  await assert.rejects(chat.request('initialize', {}), /UPGRADE_REQUIRED/);
  const ready = await chat.request('initialize', hello(MAC, 'darwin'));
  assert.equal(ready.device.deviceId, MAC);
  assert.equal(ready.device.directChatV2, true);
  assert.equal(ready.features.attachmentsV2, true);
  const id = await open(chat);
  assert.match(id, /^claude-/);
});

test('A15: a device that is not approved can only say hello; revoke applies to the running server at once', async (t) => {
  const env = setup(t);
  const stranger = await client(t, 'claude', env, 'f00dbabe-0000-4000-8000-000000000000', 'darwin');
  const answer = await stranger.request('initialize', hello('f00dbabe-0000-4000-8000-000000000000', 'darwin'));
  assert.equal(answer.device.state, 'unregistered');
  await assert.rejects(stranger.request('thread/start', {}), /DEVICE_NOT_APPROVED/);

  const chat = await client(t, 'claude', env, WIN, 'win32');
  await chat.request('initialize', hello(WIN, 'win32'));
  const id = await open(chat, 'C:\\Users\\example\\project');
  registry.revoke(env.file, WIN);
  await assert.rejects(chat.request('turn/start', { threadId: id, localRoot: 'C:\\Users\\example\\project', input: [{ type: 'text', text: 'hi' }] }), /DEVICE_REVOKED/);
});

test('A3: each device keeps its own SQLite and cannot see or resume the other device sessions', async (t) => {
  const env = setup(t);
  const mac = await client(t, 'claude', env, MAC, 'darwin');
  await mac.request('initialize', hello(MAC, 'darwin'));
  const macThread = await open(mac);
  const win = await client(t, 'claude', env, WIN, 'win32');
  await win.request('initialize', hello(WIN, 'win32'));
  const winThread = await open(win, 'C:\\Users\\example\\project');
  assert.ok(fs.existsSync(path.join(env.state, 'direct-chat', MAC, 'state.sqlite')));
  assert.ok(fs.existsSync(path.join(env.state, 'direct-chat', WIN, 'state.sqlite')));
  assert.deepEqual((await mac.request('thread/list')).data.map((item) => item.id), [macThread]);
  assert.deepEqual((await win.request('thread/list')).data.map((item) => item.id), [winThread]);
  await assert.rejects(win.request('thread/resume', { threadId: macThread }), /thread_not_found/);
  await assert.rejects(mac.request('attachment/list', { threadId: winThread }), /thread_not_found/);
  // Paths are kept as hashes only.
  const macStore = new DirectChatStore(env.state, MAC);
  t.after(() => macStore.close());
  const saved = macStore.loadSessions('claude')[macThread];
  assert.equal(saved.localRoot, '');
  assert.equal(saved.projectHash, createHash('sha256').update(MAC + '\0/Users/example/project').digest('hex'));
});

test('a v2 turn must name the project the session was opened for, and the prompt names the device', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await chat.request('initialize', hello(MAC, 'darwin'));
  const id = await open(chat);
  await assert.rejects(chat.request('turn/start', { threadId: id, localRoot: '/Users/example/other', input: [{ type: 'text', text: 'x' }] }), /PROJECT_MISMATCH/);
  const started = await chat.request('turn/start', { threadId: id, localRoot: '/Users/example/project', input: [{ type: 'text', text: 'SCENARIO:TEXT' }] });
  const done = await chat.waitFor('turn/completed', (params) => params.turn.id === started.turn.id, 12000);
  assert.equal(done.turn.status, 'completed');
  const text = chat.notifications('item/completed').filter((item) => item.item?.type === 'agentMessage').at(-1).item.text;
  const report = JSON.parse(text.slice(text.indexOf('REPORT:') + 7));
  const prompt = report.args[report.args.indexOf('--append-system-prompt') + 1] || report.args.join(' ');
  assert.match(prompt, /设备「Mac」（macOS）/);
  assert.match(prompt, /\/Users\/example\/project/);
});

test('A7: attachments are confirmed only after commit, resume from nextOffset and stay in their session', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await chat.request('initialize', hello(MAC, 'darwin'));
  const first = await open(chat);
  const second = await open(chat);
  const bytes = Buffer.from('hello attachment '.repeat(1000));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const begun = await chat.request('attachment/begin', { threadId: first, name: 'note.txt', size: bytes.length, sha256 });
  assert.equal(begun.state, 'uploading');
  const half = 8000;
  const chunk1 = await chat.request('attachment/chunk', { threadId: first, attachmentId: begun.attachmentId, offset: 0, data: bytes.subarray(0, half).toString('base64') });
  assert.equal(chunk1.nextOffset, half);
  // A reconnecting client asks where to resume.
  const listed = await chat.request('attachment/list', { threadId: first });
  assert.equal(listed.data[0].state, 'uploading');
  assert.equal(listed.data[0].nextOffset, half);
  // Not received yet: a turn cannot take it.
  await assert.rejects(chat.request('turn/start', { threadId: first, localRoot: '/Users/example/project', input: [{ type: 'text', text: 'x' }], attachmentIds: [begun.attachmentId] }), /attachment_state_uploading/);
  await assert.rejects(chat.request('attachment/chunk', { threadId: first, attachmentId: begun.attachmentId, offset: half + 1, data: 'AA==' }), /attachment_offset_mismatch/);
  await chat.request('attachment/chunk', { threadId: first, attachmentId: begun.attachmentId, offset: half, data: bytes.subarray(half).toString('base64') });
  // Another session cannot see or use it.
  await assert.rejects(chat.request('attachment/commit', { threadId: second, attachmentId: begun.attachmentId }), /attachment_not_found/);
  const committed = await chat.request('attachment/commit', { threadId: first, attachmentId: begun.attachmentId });
  assert.equal(committed.state, 'received');
  assert.equal(committed.sha256, sha256);
  assert.ok(committed.receivedAt);
  assert.deepEqual((await chat.request('attachment/list', { threadId: second })).data, []);
  const stored = path.join(env.state, 'direct-chat', MAC, 'attachments', first);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(stored, fs.readdirSync(stored).find((name) => name.endsWith('-note.txt'))))).digest('hex'), sha256);
  const started = await chat.request('turn/start', { threadId: first, localRoot: '/Users/example/project', input: [{ type: 'text', text: 'SCENARIO:ATTACH' }], attachmentIds: [begun.attachmentId] });
  const done = await chat.waitFor('turn/completed', (params) => params.turn.id === started.turn.id, 12000);
  assert.equal(done.turn.status, 'completed');
  assert.equal((await chat.request('attachment/list', { threadId: first })).data[0].state, 'attached');
  // The attachment stays on the VPS for the session (not deleted after the turn, never copied to the project).
  assert.ok(fs.readdirSync(stored).length >= 1);
});

test('A7: a commit whose bytes do not match the announced sha256 fails and is not shown as received', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await chat.request('initialize', hello(MAC, 'darwin'));
  const id = await open(chat);
  const begun = await chat.request('attachment/begin', { threadId: id, name: 'a.bin', size: 4, sha256: 'a'.repeat(64) });
  await chat.request('attachment/chunk', { threadId: id, attachmentId: begun.attachmentId, offset: 0, data: Buffer.from('abcd').toString('base64') });
  await assert.rejects(chat.request('attachment/commit', { threadId: id, attachmentId: begun.attachmentId }), /ATTACHMENT_HASH_MISMATCH/);
  assert.equal((await chat.request('attachment/list', { threadId: id })).data[0].state, 'failed');
});

test('v1 keys keep the old behaviour, and attachment/reset only clears its own conversation', async (t) => {
  const state = temporary(t);
  const chat = await new ChatClient(t, 'claude', state, { AGENTDESK_CHAT_DEVICE: 'windows' }).start();
  const init = await chat.request('initialize', {});
  assert.equal(init.device, undefined);
  assert.equal(init.features.attachmentsV2, false);
  const a = (await chat.request('thread/start', { localRoot: '/x' })).thread.id;
  const b = (await chat.request('thread/start', { localRoot: '/x' })).thread.id;
  assert.deepEqual((await chat.request('thread/list')).data, []);
  const id = '11111111-2222-4333-8444-555555555555';
  await chat.request('attachment/chunk', { threadId: a, id, offset: 0, data: Buffer.from('abc').toString('base64') });
  await chat.request('attachment/reset', { threadId: b });
  // a's upload is still there: the next chunk continues at offset 3.
  assert.equal((await chat.request('attachment/chunk', { threadId: a, id, offset: 3, data: Buffer.from('d').toString('base64') })).nextOffset, 4);
  assert.ok(fs.existsSync(path.join(state, 'chat-claude-windows.json')));
});

test('approved device with v2 off keeps its v1 state file named by its legacy tag', async (t) => {
  const env = setup(t, { v2: false });
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  const init = await chat.request('initialize', hello(MAC, 'darwin'));
  assert.equal(init.device.directChatV2, false);
  await open(chat);
  assert.ok(fs.existsSync(path.join(env.state, 'chat-claude.json')));
  assert.equal(fs.existsSync(path.join(env.state, 'direct-chat', MAC)), false);
});

test('v1 threads of the device are copied once into its SQLite and the original file is left as it was', async (t) => {
  const env = setup(t);
  const legacyId = 'claude-' + '12345678-1234-4234-8234-123456789abc';
  const legacy = { version: 1, threads: { [legacyId]: { id: legacyId, provider: 'claude', sessionId: 'abc', started: true, dynamicTools: [],
    approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' }, systemPrompt: '', localRoot: '/Users/old', projectId: 'p', title: 'old',
    createdAt: Date.now(), updatedAt: Date.now() } } };
  const legacyFile = path.join(env.state, 'chat-claude.json');
  fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  const before = fs.readFileSync(legacyFile);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await chat.request('initialize', hello(MAC, 'darwin'));
  const list = (await chat.request('thread/list')).data;
  assert.deepEqual(list.map((item) => item.id), [legacyId]);
  assert.deepEqual(fs.readFileSync(legacyFile), before);
});

test('A16: on one device four sessions run their CLI, the fifth waits in line until one ends', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin', { AGENTDESK_SEAT_SLOTS: path.join(env.state, 'slots') });
  await chat.request('initialize', hello(MAC, 'darwin'));
  const threads = [];
  for (let index = 0; index < 5; index++) threads.push(await open(chat));
  const turns = [];
  for (const id of threads) {
    turns.push((await chat.request('turn/start', { threadId: id, localRoot: '/Users/example/project', input: [{ type: 'text', text: 'SCENARIO:HANG' }] })).turn.id);
  }
  const queued = await chat.waitFor('turn/queued', (params) => params.threadId === threads[4], 8000);
  assert.equal(queued.position, 1);
  const active = () => fs.readdirSync(path.join(env.state, 'slots', 'active')).length;
  assert.equal(active(), 4);
  await chat.request('turn/interrupt', { threadId: threads[0] });
  await chat.waitFor('turn/completed', (params) => params.turn.id === turns[0], 8000);
  // The waiting session gets the freed slot.
  for (let wait = 0; wait < 100 && !fs.readdirSync(path.join(env.state, 'slots', 'active')).some((name) => name.includes(threads[4])); wait++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.readdirSync(path.join(env.state, 'slots', 'active')).some((name) => name.includes(threads[4])));
  for (const id of threads.slice(1)) await chat.request('turn/interrupt', { threadId: id });
});

test('status/read reports CLI version with source and time, and a missing quota as unknown (not 0%)', async (t) => {
  const env = setup(t);
  const chat = await client(t, 'claude', env, MAC, 'darwin');
  await chat.request('initialize', hello(MAC, 'darwin'));
  const { items } = await chat.request('status/read', {});
  const quota = items.find((item) => item.kind === 'quota');
  assert.equal(quota.value, null);
  assert.equal(quota.freshness, 'unknown');
  const version = items.find((item) => item.kind === 'version');
  assert.ok(['fresh', 'error', 'unknown'].includes(version.freshness));
  assert.ok(version.receivedAt);
});

test('codex-desktop workspace: v2 devices get their own rebuilt folder, others keep the old one untouched', (t) => {
  const env = setup(t);
  const run = (deviceId, platform) => execFileSync(process.execPath, [path.join(ROOT, 'orchestrator', 'device-registry.js'), 'codex-workspace'], {
    env: { ...process.env, AGENTDESK_DEVICES: env.file, AGENTDESK_STATE: env.state, AGENTDESK_DEVICE: deviceId || '', AGENTDESK_PLATFORM: platform || '' },
  }).toString().trim();
  assert.equal(run(MAC, 'darwin'), path.join(env.state, 'direct-chat', MAC, 'codex-workspace'));
  assert.equal(run(WIN, 'win32'), path.join(env.state, 'direct-chat', WIN, 'codex-workspace'));
  assert.equal(run('', ''), path.join(env.state, 'desktop-workspace'));
  assert.throws(() => run(MAC, 'win32'));
});
