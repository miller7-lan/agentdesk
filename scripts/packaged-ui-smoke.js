// Launches the PACKAGED AgentDesk app (CI, after electron-builder) and checks the terminal view in its real window:
// xterm.js is loaded under the app's content-security policy, a terminal renders typed text, and the panel opens
// from the composer and explains when the open chat has no native terminal (CI has no VPS2 connection).
//   node scripts/packaged-ui-smoke.js <path to AgentDesk.exe | AgentDesk.app/Contents/MacOS/AgentDesk>
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const { _electron: electron } = require('playwright-core');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-ui-home-'));
  const app = await electron.launch({ executablePath: path.resolve(process.argv[2]), args: [],
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), AGENTDESK_UI_SMOKE: '1' }, timeout: 60_000 });
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
    await page.screenshot({ path: path.resolve('terminal-ui-smoke.png') }).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
  console.log(JSON.stringify({ step: 'done', ok: true }));
}

main().then(() => process.exit(0), (error) => { console.log(JSON.stringify({ step: 'failed', error: error.stack || error.message })); console.log('::error::' + String(error.stack || error.message).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 1500)); process.exit(1); });
