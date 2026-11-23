// Launches the PACKAGED AgentDesk app (CI, after electron-builder) and checks the terminal view in its real window:
// xterm.js is loaded under the app's content-security policy, a terminal renders typed text, and the panel opens
// from the composer and explains when the open chat has no native terminal (CI has no VPS2 connection).
//   node scripts/packaged-ui-smoke.js <path to AgentDesk.exe | AgentDesk.app/Contents/MacOS/AgentDesk>
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function directStart(exe, env) {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const child = spawn(exe, ['--enable-logging=stderr', '--user-data-dir=' + path.join(env.HOME, 'AgentDesk')],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const keep = (chunk) => { out = (out + chunk).slice(-1500); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); resolve(JSON.stringify({ stillRunningAfter: '15s', output: out })); }, 15_000);
    child.once('error', (error) => { clearTimeout(timer); resolve(JSON.stringify({ spawnError: error.message })); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(JSON.stringify({ code, signal, output: out })); });
  });
}

async function main() {
  const { _electron: electron } = require('playwright-core');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-ui-home-'));
  // Pass user-data-dir explicitly: macOS resolves its Application Support directory independently of HOME.
  // A fresh profile for the app. Every folder the environment names must exist: on Windows Electron and Chromium
  // take the user-data and cache locations from these variables at start-up.
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), AGENTDESK_UI_SMOKE: '1' };
  for (const folder of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(folder, { recursive: true });
  let app;
  try {
    app = await electron.launch({ executablePath: path.resolve(process.argv[2]),
      args: ['--user-data-dir=' + path.join(home, 'AgentDesk')], env, timeout: 60_000 });
  } catch (error) {
    // The launch error alone ("Process failed to launch!") says nothing: start the app directly with the same
    // environment and report how it ended and what it printed (readable in the CI annotations).
    throw new Error(error.message + ' — direct start: ' + await directStart(path.resolve(process.argv[2]), env));
  }
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.Terminal === 'function' && !!document.querySelector('#terminalPanel'), null, { timeout: 30_000 });
    const rendered = await page.evaluate(() => new Promise((resolve) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:200px;';
      document.body.appendChild(host);
      const term = new window.Terminal({ cols: 80, rows: 10 });
      const FitAddon = window.FitAddon?.FitAddon;
      if (FitAddon) term.loadAddon(new FitAddon());
      term.open(host);
      term.write('agentdesk xterm ok\r\n', () => {
        const line = term.buffer.active.getLine(0)?.translateToString(true);
        resolve({ line, fit: Boolean(FitAddon), canvas: Boolean(host.querySelector('.xterm-screen')) });
        term.dispose(); host.remove();
      });
    }));
    console.log(JSON.stringify({ step: 'xterm', ...rendered }));
    assert.equal(rendered.line, 'agentdesk xterm ok');
    assert.ok(rendered.fit && rendered.canvas);
    const panel = await page.evaluate(() => {
      const button = document.querySelector('#terminalBtn');
      return { button: Boolean(button), panelScript: Boolean(window.AgentDeskTerminal) };
    });
    console.log(JSON.stringify({ step: 'panel', ...panel }));
    assert.ok(panel.button, 'terminal button missing');
    // The attachment notices load in the real window (adding a file used to show nothing on success).
    const attachNotice = await page.evaluate(() => window.AgentDeskAttachNotice?.added([{ name: 'a.txt' }], 'chat') || null);
    console.log(JSON.stringify({ step: 'attach-notice', text: attachNotice }));
    assert.equal(attachNotice, '已添加 1 个附件（先存在本机，发送消息时一起上传）');
    // A group project created from the orchestrator: before it is set up, attachments are refused (the problem);
    // set up the way the app now does it automatically (a cloud project bound to the orchestrator workspace, no
    // folder picker), attachments are accepted — in the packaged app's real main process.
    const project = await page.evaluate(async () => {
      const id = 'group-' + crypto.randomUUID();
      const tiny = btoa('agentdesk');
      const before = await window.desk.files.pasteChat(id, 'a.txt', tiny);
      const added = await window.desk.projects.add({ groupId: id, name: 'CI 群聊项目', kind: 'remote', orchestratorWorkspace: 'mac' });
      const after = await window.desk.files.pasteChat(id, 'a.txt', tiny);
      return { before: before.files.length, beforeError: before.errors[0] || null, added: added.ok,
        registered: Boolean(added.projects?.some((item) => item.id === id && item.kind === 'remote' && item.orchestratorWorkspace === 'mac' && !item.localRoot)),
        after: after.files.length, afterErrors: after.errors };
    });
    console.log(JSON.stringify({ step: 'group-project-attachments', ...project }));
    assert.equal(project.before, 0, 'an unregistered project must not take attachments');
    assert.ok(project.added && project.registered, 'the project is registered without a folder');
    assert.equal(project.after, 1, 'attachments work once the project is set up: ' + JSON.stringify(project.afterErrors));
    // Every stage's last safety net: a failure nobody handled is shown, instead of a click doing nothing.
    const safetyNet = await page.evaluate(() => new Promise((resolve) => {
      Promise.reject(new Error('ci-unhandled-check'));
      setTimeout(() => resolve(document.querySelector('#toast')?.textContent || ''), 300);
    }));
    console.log(JSON.stringify({ step: 'unhandled-failure-notice', text: safetyNet }));
    assert.equal(safetyNet, '操作没有完成：ci-unhandled-check');
    await page.screenshot({ path: path.resolve('terminal-ui-smoke.png') }).catch(() => {});
  } finally {
    await app?.close().catch(() => {});
  }
  console.log(JSON.stringify({ step: 'done', ok: true }));
}

main().then(() => process.exit(0), (error) => {
  console.log(JSON.stringify({ step: 'failed', error: error.stack || error.message }));
  console.log('::error::' + String(error.stack || error.message).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 3000));
  process.exit(1);
});
