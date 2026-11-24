const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { runAdapter } = require('../orchestrator/adapters');

const bwrap = '/usr/bin/bwrap';
const usable = process.platform === 'linux' && existsSync(bwrap);

test('a sandboxed CLI may run commands in its own worktree but sees no other task or login', { skip: !usable }, async (t) => {
  // Outside /tmp: the sandbox gives the CLI a fresh, empty /tmp, as it does on the VPS.
  const root = await fs.mkdtemp(path.join(__dirname, '..', '.sandbox-test-'));
  t.after(async () => { if (process.env.KEEP) console.log(await fs.readFile(path.join(root, 'step.log'), 'utf8').catch(() => '')); await fs.rm(root, { recursive: true, force: true }); });
  const stateDir = path.join(root, 'state');
  const cwd = path.join(stateDir, 'worktrees', 'task-a', 'edit');
  const home = path.join(stateDir, 'homes', 'grok');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(stateDir, 'worktrees', 'task-b'), { recursive: true });
  await fs.mkdir(path.join(stateDir, 'homes', 'codex'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'worktrees', 'task-b', 'secret.txt'), 'other task');
  await fs.writeFile(path.join(stateDir, 'homes', 'codex', 'auth.json'), 'codex login');
  // A stand-in for the Grok CLI: reports its permissions, writes in its worktree, tries to read beyond it.
  const cli = path.join(root, 'fake-grok.js');
  await fs.writeFile(cli, `#!${process.execPath}
const fs = require('fs');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return 'hidden'; } };
fs.writeFileSync('result.txt', 'tests passed');
console.log(JSON.stringify({ bash: process.argv.join(' ').includes('--allow Bash'),
  other: read(${JSON.stringify(path.join(stateDir, 'worktrees', 'task-b', 'secret.txt'))}),
  login: read(${JSON.stringify(path.join(stateDir, 'homes', 'codex', 'auth.json'))}) }));
`, { mode: 0o755 });
  const result = await runAdapter({
    name: 'grok', config: { bin: cli, env: { HOME: home, PATH: process.env.PATH }, sandbox: { bin: bwrap, stateDir, hideDefaults: [] } },   // this checkout lives under /home
    cwd, prompt: 'run the tests', readonly: false, timeout: 20000, signal: new AbortController().signal,
    log: path.join(root, 'step.log'), onSession() {},
  });
  const report = JSON.parse(result.output.trim().split('\n').at(-1));
  assert.deepEqual(report, { bash: true, other: 'hidden', login: 'hidden' });
  assert.equal(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8'), 'tests passed');
});

test('the system is mounted folder by folder, skipping /srv, so one stale mount there cannot break every sandbox', () => {
  const { sandboxCommand, systemMounts } = require('../orchestrator/sandbox');
  const entry = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' });
  const root = () => [entry('usr', 'dir'), entry('bin', 'link'), entry('srv', 'dir'), entry('etc', 'dir'), entry('swapfile', 'file'),
    entry('proc', 'dir'), entry('tmp', 'dir'), entry('dev', 'dir'), entry('var', 'dir')];
  const mounts = systemMounts(root, () => 'usr/bin');
  assert.deepEqual(mounts, ['--symlink', 'usr/bin', '/bin', '--ro-bind', '/etc', '/etc', '--ro-bind', '/usr', '/usr', '--ro-bind', '/var', '/var']);
  const { args } = sandboxCommand('cli', ['x'], { cwd: __dirname, readRoot: root, readLink: () => 'usr/bin', hideDefaults: [] });
  assert.ok(!args.join(' ').includes('/srv'));
  assert.ok(!args.includes('--ro-bind') || args.indexOf('/') === args.indexOf('--remount-ro') + 1);
  assert.equal(args[args.indexOf('--') - 1], '/');                  // root made read-only after every mount
  assert.equal(args[args.indexOf('--') - 2], '--remount-ro');
});

test('group steps keep CLI conversations per device: a step sees only its own device history, not the shared home or another device', { skip: !usable }, async (t) => {
  const root = await fs.mkdtemp(path.join(__dirname, '..', '.sandbox-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const cwd = path.join(stateDir, 'worktrees', 'task-a', 'edit');
  const home = path.join(stateDir, 'homes', 'grok');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(home, '.grok', 'sessions', 'shared'), { recursive: true });
  await fs.writeFile(path.join(home, '.grok', 'sessions', 'shared', 'secret.txt'), 'wechat conversation');
  await fs.writeFile(path.join(home, '.grok', 'auth.json'), 'login');
  const other = path.join(stateDir, 'cli-history', 'adapter-group-windows', 'grok', '.grok', 'sessions', 'w');
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'secret.txt'), 'windows conversation');
  const cli = path.join(root, 'fake-grok.js');
  await fs.writeFile(cli, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return 'hidden'; } };
const sessions = path.join(process.env.HOME, '.grok', 'sessions');
fs.mkdirSync(path.join(sessions, 'mine'), { recursive: true });
fs.writeFileSync(path.join(sessions, 'mine', 'chat.txt'), 'mac step');
console.log(JSON.stringify({ listed: fs.readdirSync(sessions).sort(), login: read(path.join(process.env.HOME, '.grok', 'auth.json')),
  shared: read(path.join(sessions, 'shared', 'secret.txt')),
  windows: read(${JSON.stringify(path.join(other, 'secret.txt'))}) }));
`, { mode: 0o755 });
  const result = await runAdapter({
    name: 'grok', config: { bin: cli, env: { HOME: home, PATH: process.env.PATH }, sandbox: { bin: bwrap, stateDir, hideDefaults: [] } },
    cwd, prompt: 'go', readonly: false, timeout: 20000, signal: new AbortController().signal,
    log: path.join(root, 'step.log'), onSession() {}, history: 'group-mac',
  });
  const report = JSON.parse(result.output.trim().split('\n').at(-1));
  assert.deepEqual(report, { listed: ['mine'], login: 'login', shared: 'hidden', windows: 'hidden' });
  const own = path.join(stateDir, 'cli-history', 'adapter-group-mac', 'grok', '.grok', 'sessions', 'mine', 'chat.txt');
  assert.equal(await fs.readFile(own, 'utf8'), 'mac step');
  assert.ok(!existsSync(path.join(home, '.grok', 'sessions', 'mine')));
});
