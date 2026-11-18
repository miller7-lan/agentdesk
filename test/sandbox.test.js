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
