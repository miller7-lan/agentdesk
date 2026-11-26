const test = require('node:test');
const assert = require('node:assert/strict');
const { Desktop } = require('../desktop');

function fake() {
  const desktop = new Desktop('unused');
  desktop.timeoutMs = 20;
  const writes = [];
  desktop.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) }, kill() {} };
  return { desktop, writes };
}

test('one slow desktop call fails on its own without stopping the backend', async () => {
  const { desktop } = fake();
  await assert.rejects(desktop.send('tools/call', {}), /timed out/);
  assert.ok(desktop.child, 'backend kept running after a single timeout');
  assert.equal(desktop.pending.size, 0);
});

test('three consecutive timeouts restart the desktop backend', async () => {
  const { desktop } = fake();
  for (let i = 0; i < 3; i++) await assert.rejects(desktop.send('tools/call', {}), /timed out/);
  assert.equal(desktop.child, null);
});

const { resolveLaunchApp } = require('../desktop');

test('desktop_launch resolves bare Windows program names the backend cannot find', () => {
  const present = new Set([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Tools\\bin\\rg.exe',
  ]);
  const options = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files',
    Path: 'relative\\dir;"C:\\Tools\\bin"' }, exists: (file) => present.has(file) };
  assert.equal(resolveLaunchApp('powershell.exe', options), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(resolveLaunchApp('powershell', options), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(resolveLaunchApp('pwsh', options), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(resolveLaunchApp('cmd.exe', options), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(resolveLaunchApp('rg', options), 'C:\\Tools\\bin\\rg.exe');
  // Unknown names (app names) and explicit paths pass through untouched.
  assert.equal(resolveLaunchApp('Calculator', options), 'Calculator');
  assert.equal(resolveLaunchApp('D:\\x\\y.exe', options), 'D:\\x\\y.exe');
  assert.equal(resolveLaunchApp('..\\evil.exe', options), '..\\evil.exe');
  // Only Windows is rewritten.
  assert.equal(resolveLaunchApp('powershell.exe', { ...options, platform: 'darwin' }), 'powershell.exe');
});

test('desktop_launch sends the resolved path to the backend', async () => {
  const { desktop, writes } = fake();
  desktop.tools = new Map([['desktop_launch', { inputSchema: { properties: { app: {}, args: {} } } }]]);
  desktop.active.set('turn', 'thread');
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const fs = require('node:fs');
  const realExists = fs.existsSync;
  fs.existsSync = (file) => file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const env = { ...process.env };
  process.env.SystemRoot = 'C:\\Windows';
  try {
    const pending = desktop.call({ threadId: 'thread', turnId: 'turn', tool: 'desktop_launch',
      arguments: { app: 'powershell.exe', args: ['-NoExit'] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.at(-1).params.arguments.app, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(writes.at(-1).params.arguments.args, ['-NoExit']);
    await pending;
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
    fs.existsSync = realExists;
    process.env = env;
  }
});
