// Terminal chain through the real Worker: the person's actions from the window (open, input, takeover, resize,
// Ctrl+C, close) and the AI's terminal tool reach the same terminal, events stream the output, and a terminal
// keeps running when the app's connection goes away and is found again by the next connection.
// With node-pty installed (CI after npm ci) a real shell is used; otherwise a stand-in pty with the same interface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { serveWorker, connectWorker, createSecret } = require('../orchestrator/windows-chat-worker');
const { TerminalSessions, loadPty } = require('../orchestrator/terminal-sessions');

const realPty = loadPty();
const WINDOWS = process.platform === 'win32';

function fakePty() {
  return {
    spawn() {
      const events = new EventEmitter();
      let line = '';
      const child = {
        onData: (fn) => events.on('data', fn), onExit: (fn) => events.on('exit', fn),
        write(data) {
          if (data === '\x03') { line = ''; events.emit('data', '^C\r\n$ '); return; }
          events.emit('data', data);
          line += data;
          if (line.endsWith('\r')) {
            const out = /agent"?"?\^?desk-ok|\("agent"\+"desk-ok"\)/.test(line) ? 'agentdesk-ok' : '';
            events.emit('data', '\r\n' + out + '\r\n$ ');
            line = '';
          }
        },
        resize() {}, kill() { events.emit('exit', { exitCode: 0 }); },
      };
      setTimeout(() => events.emit('data', '$ '), 5);
      return child;
    },
  };
}

const marker = WINDOWS ? 'Write-Output ("agent"+"desk-ok")\r' : 'echo agent""desk-ok\r';

async function until(check, ms = 15_000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('terminals through the Worker: window and AI share one terminal, takeover, Ctrl+C, resize, and survival across app reconnects', {
  skip: process.platform !== 'linux' && !realPty, timeout: 60_000,
}, async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-terminal-worker-'));
  // The real path: on macOS /var is a link to /private/var, and leases compare real paths.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-terminal-project-')));
  const terminals = new TerminalSessions({ pty: realPty || fakePty(), onEvent: (event) => events.push(event) });
  const events = [];
  createSecret(stateDir);
  const server = serveWorker(stateDir, { terminals });
  await new Promise((resolve) => server.once('listening', resolve));
  // Real shells keep the process alive: end them even when an assertion fails, so the run cannot hang.
  t.after(() => {
    terminals.closeAll();
    server.close();
    try { fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); } catch {}
  });
  const secret = createSecret(stateDir);
  const received = [];
  const first = await connectWorker(stateDir, secret, { onEvent: (kind, value) => received.push([kind, value]) });
  t.after(() => first.close());
  const identity = { device: 'dev', provider: 'claude', threadId: 'thread-1', projectId: 'p', root: project, fullAccess: true };
  const binding = { ...identity, ...await first.request('acquire', { binding: identity }) };
  assert.equal((await first.request('capabilities', {})).pty, true);

  // The person opens a terminal from the window.
  const opened = await first.request('terminalOpen', { binding, cols: 100, rows: 30 });
  const id = opened.terminalId;
  await first.request('terminalInput', { binding, terminalId: id, data: marker });
  await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).data.includes('agentdesk-ok'), 20_000, 'user output');
  // Output was streamed to the window with the data chunk and the cursor after it.
  assert.ok(received.some(([kind, value]) => kind === 'terminal' && value.type === 'output' && typeof value.data === 'string'));

  // The AI sees the same terminal with its tool, and types into it.
  const listed = await first.request('terminal', { binding, args: { action: 'list' } });
  assert.deepEqual(listed.terminals.map((item) => item.terminalId), [id]);
  const before = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
  await first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: marker } });
  await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: before })).data.includes('agentdesk-ok'), 20_000, 'AI output');

  // Takeover: the AI's input is refused, the person can still type; handing back lets the AI in again.
  await first.request('terminalTakeover', { binding, terminalId: id, on: true });
  await assert.rejects(first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: 'x' } }), /terminal_taken_over/);
  await first.request('terminalInput', { binding, terminalId: id, data: marker });
  await first.request('terminalTakeover', { binding, terminalId: id, on: false });
  await first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: '' } });

  // Ctrl+C stops a long command and the shell answers again.
  const long = WINDOWS ? 'Start-Sleep -Seconds 30; Write-Output after-sleep\r' : 'sleep 30; echo after-sleep\r';
  await first.request('terminalInput', { binding, terminalId: id, data: long });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await first.request('terminalSignal', { binding, terminalId: id, signal: 'SIGINT' });
  const mark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
  await first.request('terminalInput', { binding, terminalId: id, data: marker });
  const after = await until(async () => { const r = await first.request('terminalRead', { binding, terminalId: id, cursor: mark }); return r.data.includes('agentdesk-ok') && r; }, 20_000, 'shell after Ctrl+C');
  assert.equal(after.data.includes('after-sleep'), false);
  assert.equal((await first.request('terminalResize', { binding, terminalId: id, cols: 140, rows: 40 })).cols, 140);

  // The app goes away (window closed, app quit): the terminal keeps running in the Worker.
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await connectWorker(stateDir, secret);
  t.after(() => second.close());
  const found = await second.request('lookup', { binding: identity });
  const again = { ...identity, ...found };
  const list = await second.request('terminalRead', { binding: again });
  assert.equal(list.terminals.length, 1);
  assert.equal(list.terminals[0].state, 'running');
  const tail = await second.request('terminalRead', { binding: again, terminalId: id, cursor: 0 });
  assert.ok(tail.data.includes('agentdesk-ok'), 'earlier output is there for the reattached window');
  // Another conversation cannot see or use it.
  const other = { ...identity, threadId: 'thread-2' };
  const otherBinding = { ...other, ...await second.request('acquire', { binding: other }) };
  assert.deepEqual((await second.request('terminalRead', { binding: otherBinding })).terminals, []);
  await assert.rejects(second.request('terminalInput', { binding: otherBinding, terminalId: id, data: 'x' }), /terminal_not_found/);
  assert.equal((await second.request('terminalClose', { binding: again, terminalId: id })).state, 'closed');
});
