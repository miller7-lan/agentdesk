const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createAdminShell, helperScript } = require('../admin-shell');

const pipePath = (name) => process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');

// Plays the elevated helper: reads the pipe name and token from the script it was given, connects, and answers
// each request with `answer(request)`.
function fakeHelper({ answer = (q) => ({ id: q.id, code: 0, stdout: 'ran:' + Buffer.from(q.encoded, 'base64').toString('utf16le').split('\n').pop(), stderr: '', timedOut: false }),
  token: override, outcome = 'started', seen = [] } = {}) {
  return async (encoded) => {
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    seen.push(script);
    if (outcome !== 'started') return outcome;
    const pipeName = /NamedPipeClientStream\('\.','([^']+)'/.exec(script)[1];
    const token = override ?? /\$w\.WriteLine\('([0-9a-f]+)'\)/.exec(script)[1];
    const socket = net.connect(pipePath(pipeName));
    socket.setEncoding('utf8');
    socket.write(token + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const reply = answer(JSON.parse(line));
        if (reply) socket.write(JSON.stringify(reply) + '\n');
      }
    });
    socket.on('error', () => {});
    return 'started';
  };
}

function shell(options = {}) {
  const asked = { start: 0, run: 0 };
  const audits = [];
  const admin = createAdminShell({
    platform: 'win32', pipePath, connectMs: 2000,
    confirmStart: async () => { asked.start++; return options.startAnswer ?? true; },
    confirmRun: async () => { asked.run++; return options.runAnswer ?? true; },
    audit: (event, fields) => audits.push(fields.status),
    ...options,
  });
  return { admin, asked, audits };
}

const run = (script, extra = {}) => ({ action: 'run', script, reason: 'test', ...extra });

test('admin shell: nothing starts when the person declines in AgentDesk', async () => {
  const seen = [];
  const { admin, asked, audits } = shell({ startAnswer: false, launch: fakeHelper({ seen }) });
  const result = await admin.call({ scope: 's', policy: 'ask', args: run('whoami') });
  assert.equal(result.ok, false);
  assert.match(result.error, /拒绝/);
  assert.equal(asked.start, 1);
  assert.equal(seen.length, 0, 'no UAC prompt after the AgentDesk dialog was declined');
  assert.deepEqual(audits, ['declined_app']);
});

test('admin shell: a declined UAC prompt is reported and nothing runs', async () => {
  const { admin, audits } = shell({ launch: fakeHelper({ outcome: 'declined' }) });
  const result = await admin.call({ scope: 's', policy: 'ask', args: run('whoami') });
  assert.equal(result.ok, false);
  assert.match(result.error, /否/);
  assert.equal(admin.active('s'), false);
  assert.deepEqual(audits, ['declined_uac']);
});

test('admin shell: runs after consent; ask policy confirms later commands, full does not', async () => {
  const { admin, asked } = shell({ launch: fakeHelper() });
  const first = await admin.call({ scope: 'a', policy: 'ask', args: run('first') });
  assert.equal(first.ok, true);
  assert.equal(first.stdout, 'ran:first');
  assert.equal(asked.run, 0, 'the first command was shown in the start dialog');
  const second = await admin.call({ scope: 'a', policy: 'ask', args: run('second') });
  assert.equal(second.stdout, 'ran:second');
  assert.equal(asked.run, 1);
  assert.equal(asked.start, 1, 'one elevation per session');

  const full = shell({ launch: fakeHelper() });
  await full.admin.call({ scope: 'f', policy: 'full', args: run('one') });
  await full.admin.call({ scope: 'f', policy: 'full', args: run('two') });
  assert.equal(full.asked.run, 0);
  admin.endAll();
  full.admin.endAll();
});

test('admin shell: a declined command does not run, and end closes the session', async () => {
  const { admin } = shell({ launch: fakeHelper(), runAnswer: false });
  await admin.call({ scope: 'x', policy: 'ask', args: run('first') });
  const refused = await admin.call({ scope: 'x', policy: 'ask', args: run('second') });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /未获批准/);
  assert.deepEqual(await admin.call({ scope: 'x', policy: 'ask', args: { action: 'end' } }), { ok: true, ended: true });
  assert.equal(admin.active('x'), false);
});

test('admin shell: read-only turns, other platforms and bad scripts are refused', async () => {
  const { admin, asked } = shell({ launch: fakeHelper() });
  assert.equal((await admin.call({ scope: 'r', policy: 'read', args: run('x') })).ok, false);
  assert.equal((await admin.call({ scope: 'r', policy: 'ask', args: run('  ') })).error, 'invalid_admin_shell_script');
  assert.equal((await admin.call({ scope: 'r', policy: 'ask', args: { action: 'nope' } })).error, 'invalid_admin_shell_action');
  assert.equal(asked.start, 0);
  const mac = createAdminShell({ platform: 'darwin', confirmStart: async () => true, confirmRun: async () => true });
  assert.equal((await mac.call({ scope: 'm', policy: 'full', args: run('x') })).error, 'admin_shell_windows_only');
});

test('admin shell: a client with the wrong token is not accepted', async () => {
  const { admin } = shell({ launch: fakeHelper({ token: 'f'.repeat(64) }), connectMs: 300 });
  const result = await admin.call({ scope: 't', policy: 'ask', args: run('x') });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(admin.active('t'), false);
});

test('admin shell: output is cut to the last 16000 characters and the session ends when idle', async () => {
  const { admin, audits } = shell({ idleMs: 50,
    launch: fakeHelper({ answer: (q) => ({ id: q.id, code: 1, stdout: 'x'.repeat(20_000), stderr: 'bad', timedOut: false }) }) });
  const result = await admin.call({ scope: 'i', policy: 'ask', args: run('big') });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 16_000);
  assert.equal(result.truncated, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(admin.active('i'), false);
  assert.ok(audits.includes('idle'));
});

test('admin helper checks that the pipe belongs to AgentDesk before sending its token', () => {
  const script = helperScript({ pipeName: 'agentdesk-admin-abc', token: 'deadbeef', serverPid: 4242 });
  const check = script.indexOf('GetNamedPipeServerProcessId($c');
  const send = script.indexOf("$w.WriteLine('deadbeef')");
  assert.ok(check > 0 && send > check);
  assert.match(script, /-ne 4242\)\{exit 3\}/);
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length < 16_000, 'fits the elevated command line');
});

test('admin shell: PowerShell CLIXML errors come back as plain text', () => {
  const { plainErrors } = require('../admin-shell');
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"><AV>x</AV></Obj><S S="Error">a &amp; b : boom_x000D__x000A_</S><S S="Error">  + Id_x000D__x000A_</S></Objs>';
  assert.equal(plainErrors(clixml), 'a & b : boom\r\n  + Id\r\n');
  assert.equal(plainErrors('plain'), 'plain');
});
