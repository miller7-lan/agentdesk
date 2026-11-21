// Real terminal check inside a PACKAGED AgentDesk (Windows x64 / macOS arm64), run by CI after electron-builder:
//
//   ELECTRON_RUN_AS_NODE=1 <AgentDesk.exe | AgentDesk.app/Contents/MacOS/AgentDesk> scripts/packaged-terminal-smoke.js <resources dir>
//
// It loads the app's own code and node-pty from app.asar / app.asar.unpacked with the packaged Electron runtime
// (so the native module, its Electron ABI and the asar unpacking are what is tested), starts the real Worker,
// and drives real shells: PowerShell and CMD on Windows, zsh and bash on a Mac (inside the same sandbox-exec
// profile the app uses). Output is JSON lines; any failure exits non-zero.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resources = path.resolve(process.argv[2] || '');
const asar = path.join(resources, 'app.asar');
const log = (step, detail = {}) => console.log(JSON.stringify({ step, ...detail }));
const WINDOWS = process.platform === 'win32';
const marker = { powershell: 'Write-Output ("agent"+"desk-ok")\r', cmd: 'echo agent^desk-ok\r', zsh: 'echo agent""desk-ok\r', bash: 'echo agent""desk-ok\r' };
const long = { powershell: 'Start-Sleep -Seconds 30; Write-Output after-sleep\r', cmd: 'ping -n 30 127.0.0.1 > nul & echo after-sleep\r',
  zsh: 'sleep 30; echo after-sleep\r', bash: 'sleep 30; echo after-sleep\r' };

async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout: ' + what);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function main() {
  assert.ok(fs.existsSync(asar), 'app.asar missing at ' + asar);
  log('runtime', { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, arch: process.arch, platform: process.platform });
  const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
  assert.ok(fs.existsSync(unpacked), 'node-pty is not unpacked from the asar');
  const prebuild = path.join(unpacked, 'prebuilds', `${process.platform}-${process.arch}`);
  log('node-pty', { unpacked: true, prebuild: fs.existsSync(prebuild), files: fs.existsSync(prebuild) ? fs.readdirSync(prebuild) : [] });
  // The renderer's terminal view ships inside the asar.
  const xterm = fs.readFileSync(path.join(asar, 'src', 'vendor', 'xterm', 'xterm.js'), 'utf8');
  assert.ok(xterm.includes('Terminal'), 'xterm.js missing from the package');
  assert.ok(fs.readFileSync(path.join(asar, 'src', 'index.html'), 'utf8').includes('terminal-panel.js'));

  const { TerminalSessions, loadPty } = require(path.join(asar, 'orchestrator', 'terminal-sessions.js'));
  assert.ok(loadPty()?.spawn, 'node-pty does not load in the packaged runtime');
  const { serveWorker, connectWorker, createSecret } = require(path.join(asar, 'orchestrator', 'windows-chat-worker.js'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-pkg-worker-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-pkg-project-')));
  createSecret(stateDir);
  // The Worker exactly as the app starts it, with its own TerminalSessions (and the Mac sandbox profile).
  const server = serveWorker(stateDir);
  await new Promise((resolve) => server.once('listening', resolve));
  const secret = createSecret(stateDir);
  let streamed = 0;
  const first = await connectWorker(stateDir, secret, { onEvent: (kind, value) => { if (kind === 'terminal' && value.type === 'output' && value.data) streamed += 1; } });
  const identity = { device: 'packaged-smoke', provider: 'claude', threadId: 'smoke-thread', projectId: 'smoke', root: project, fullAccess: true };
  const binding = { ...identity, ...await first.request('acquire', { binding: identity }) };
  const caps = await first.request('capabilities', {});
  assert.equal(caps.pty, true, 'Worker reports no pty');
  log('worker', { capabilities: caps });

  const shells = WINDOWS ? ['powershell', 'cmd'] : ['zsh', 'bash'];
  const ids = {};
  for (const shell of shells) {
    const started = Date.now();
    const opened = await first.request('terminalOpen', { binding, shell, cols: 100, rows: 30 });
    const id = ids[shell] = opened.terminalId;
    await first.request('terminalInput', { binding, terminalId: id, data: marker[shell] });
    await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).data.includes('agentdesk-ok'), 30_000, shell + ' output');
    log('shell', { shell, ok: true, ms: Date.now() - started });
    // The AI's tool writes into the same terminal.
    const mark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
    await first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: marker[shell] } });
    await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: mark })).data.includes('agentdesk-ok'), 30_000, shell + ' AI write');
    // Takeover refuses the AI and lets the person type; hand back.
    await first.request('terminalTakeover', { binding, terminalId: id, on: true });
    await assert.rejects(first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: 'x' } }), /terminal_taken_over/);
    await first.request('terminalTakeover', { binding, terminalId: id, on: false });
    // Ctrl+C interrupts a long command; the shell answers afterwards.
    await first.request('terminalInput', { binding, terminalId: id, data: long[shell] });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await first.request('terminalSignal', { binding, terminalId: id, signal: 'SIGINT' });
    if (shell === 'cmd') {
      // CMD asks "Terminate batch job (Y/N)?" only for batch files; for ping it just stops. Send Enter for a fresh prompt.
      await first.request('terminalInput', { binding, terminalId: id, data: '\r' });
    }
    const afterMark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
    await first.request('terminalInput', { binding, terminalId: id, data: marker[shell] });
    const after = await until(async () => { const r = await first.request('terminalRead', { binding, terminalId: id, cursor: afterMark }); return r.data.includes('agentdesk-ok') && r; }, 30_000, shell + ' after Ctrl+C');
    assert.equal(after.data.includes('after-sleep'), false, shell + ': Ctrl+C did not stop the command');
    const resized = await first.request('terminalResize', { binding, terminalId: id, cols: 150, rows: 45 });
    assert.equal(resized.cols, 150);
    log('interactive', { shell, ai: true, takeover: true, ctrlC: true, resize: true });
  }
  assert.ok(streamed > 0, 'no output events reached the client');

  // Close the "app": the terminals keep running in the Worker and the next connection reattaches.
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = await connectWorker(stateDir, secret);
  const again = { ...identity, ...await second.request('lookup', { binding: identity }) };
  const listed = await second.request('terminalRead', { binding: again });
  assert.equal(listed.terminals.filter((item) => item.state === 'running').length, shells.length);
  const mark2 = (await second.request('terminalRead', { binding: again, terminalId: ids[shells[0]], cursor: 0 })).cursor;
  await second.request('terminalInput', { binding: again, terminalId: ids[shells[0]], data: marker[shells[0]] });
  await until(async () => (await second.request('terminalRead', { binding: again, terminalId: ids[shells[0]], cursor: mark2 })).data.includes('agentdesk-ok'), 30_000, 'reattached terminal');
  log('reattach', { running: listed.terminals.length, ok: true });
  for (const id of Object.values(ids)) await second.request('terminalClose', { binding: again, terminalId: id });
  second.close();
  server.close();
  log('done', { ok: true });
}

main().then(() => process.exit(0), (error) => {
  // process.exit ends the shells too; nothing is left running on the runner. log('failed', { error: error.stack || error.message }); console.log('::error::' + String(error.stack || error.message).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 1500)); process.exit(1); });
