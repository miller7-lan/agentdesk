const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { catalogue, builtinWindowsCommands } = require('../local-commands');

const env = { SystemRoot: 'C:\\Windows' };

test('Windows projects get the built-in read-only diagnostics, even without a Bridge configuration', () => {
  const list = catalogue(null, 'C:\\proj', { platform: 'win32', env });
  const names = list.map(({ name }) => name);
  for (const name of ['sys-overview', 'net-listening', 'power-settings', 'tasks-list', 'events-power']) assert.ok(names.includes(name), name);
  for (const item of list) {
    assert.equal(item.builtin, true);
    assert.equal(item.cwd, 'C:\\proj');
    assert.equal(item.argv[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  }
  assert.deepEqual(catalogue(null, '/Users/me/proj', { platform: 'darwin', env }), [], 'Mac unchanged');
  assert.deepEqual(catalogue(null, '', { platform: 'win32', env }), [], 'no project folder, no commands');
});

test('the person\'s own commands come first, win on a name clash, and can switch the built-ins off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-'));
  const file = path.join(dir, 'bridge.json');
  const root = path.join(dir, 'proj');
  const write = (extra) => fs.writeFileSync(file, JSON.stringify({ workspaces: { w: { root, agentCommands: ['git-status', 'sys-overview'],
    commands: { 'git-status': ['git', 'status'], 'sys-overview': ['mine.exe'] }, ...extra } } }));
  write({});
  const list = catalogue(file, root, { platform: 'win32', env });
  assert.deepEqual(list.slice(0, 2).map(({ name, argv }) => [name, argv[0]]), [['git-status', 'git'], ['sys-overview', 'mine.exe']]);
  assert.equal(list.filter(({ name }) => name === 'sys-overview').length, 1);
  assert.ok(list.some(({ name }) => name === 'tasks-list'));
  write({ builtinCommands: false });
  assert.deepEqual(catalogue(file, root, { platform: 'win32', env }).map(({ name }) => name), ['git-status', 'sys-overview']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('built-in diagnostics are fixed PowerShell scripts that only read', () => {
  for (const [name, argv] of Object.entries(builtinWindowsCommands(env))) {
    assert.equal(argv[4], '-Command', name);
    assert.doesNotMatch(argv[5], /\b(Set-|Remove-|Stop-|Start-|New-|Disable-|Enable-|Restart-|Register-|Unregister-)|powercfg \/(change|set)/i, name);
  }
});
