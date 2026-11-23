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

// On a timeout the error carries what the terminal showed and whether its shell is still running, so a CI failure
// explains itself (the annotations are the only part of a run readable without signing in).
async function until(check, ms, what, explain) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout: ' + what + (explain ? ' — ' + await explain().catch((error) => 'explain failed: ' + error.message) : ''));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// Wait (up to 10 s) for output after `mark` — the shell's answer to Ctrl+C — and for it to stop changing.
async function settled(client, binding, id, mark) {
  const end = Date.now() + 10_000;
  let seen = -1;
  while (Date.now() < end) {
    const { cursor } = await client.request('terminalRead', { binding, terminalId: id, cursor: 0 });
    if (cursor > mark && cursor === seen) return true;
    seen = cursor;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
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

  const explainer = (id) => async () => {
    const all = await first.request('terminalRead', { binding });
    const view = all.terminals.find((item) => item.terminalId === id) || {};
    const tail = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').slice(-700);
    return JSON.stringify({ state: view.state, exitCode: view.exitCode, tail });
  };
  const shells = WINDOWS ? ['powershell', 'cmd'] : ['zsh', 'bash'];
  const ids = {};
  for (const shell of shells) {
    const started = Date.now();
    const opened = await first.request('terminalOpen', { binding, shell, cols: 100, rows: 30 });
    const id = ids[shell] = opened.terminalId;
    await first.request('terminalInput', { binding, terminalId: id, data: marker[shell] });
    await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).data.includes('agentdesk-ok'), 30_000, shell + ' output', explainer(id));
    log('shell', { shell, ok: true, ms: Date.now() - started });
    // The AI's tool writes into the same terminal.
    const mark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
    await first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: marker[shell] } });
    await until(async () => (await first.request('terminalRead', { binding, terminalId: id, cursor: mark })).data.includes('agentdesk-ok'), 30_000, shell + ' AI write', explainer(id));
    // Takeover refuses the AI and lets the person type; hand back.
    await first.request('terminalTakeover', { binding, terminalId: id, on: true });
    await assert.rejects(first.request('terminal', { binding, args: { action: 'write', terminalId: id, data: 'x' } }), /terminal_taken_over/);
    await first.request('terminalTakeover', { binding, terminalId: id, on: false });
    // Ctrl+C interrupts a long command; the shell answers afterwards.
    await first.request('terminalInput', { binding, terminalId: id, data: long[shell] });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const signalMark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
    await first.request('terminalSignal', { binding, terminalId: id, signal: 'SIGINT' });
    if (shell === 'cmd') {
      // CMD asks "Terminate batch job (Y/N)?" only for batch files; for ping it just stops. Send Enter for a fresh prompt.
      await first.request('terminalInput', { binding, terminalId: id, data: '\r' });
    }
    // Like a person: type the next command once the shell has answered the Ctrl+C (its new prompt). Consoles discard
    // what was typed before they handled Ctrl+C (Windows flushes the console input; a POSIX tty flushes on SIGINT).
    await settled(first, binding, id, signalMark);
    const afterMark = (await first.request('terminalRead', { binding, terminalId: id, cursor: 0 })).cursor;
    await first.request('terminalInput', { binding, terminalId: id, data: marker[shell] });
    const after = await until(async () => { const r = await first.request('terminalRead', { binding, terminalId: id, cursor: afterMark }); return r.data.includes('agentdesk-ok') && r; }, 30_000, shell + ' after Ctrl+C', explainer(id));
    if (after.data.includes('after-sleep')) assert.fail(shell + ': Ctrl+C did not stop the command — ' + await explainer(id)());
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
  const purged = await second.request('projectDelete', { device: identity.device, projectId: identity.projectId });
  assert.equal(purged.deleted, true);
  assert.equal(await second.request('lookup', { binding: identity }), null);
  log('project-delete', { terminalsClosed: true, leaseRemoved: true });
  second.close();
  server.close();
  log('done', { ok: true });
}

main().then(() => process.exit(0), (error) => {
  // process.exit ends the shells too; nothing is left running on the runner.
  log('failed', { error: error.stack || error.message });
  console.log('::error::' + String(error.stack || error.message).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 3000));
  process.exit(1);
});
