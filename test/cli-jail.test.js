const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jailArgs, prepareHome, writeIdentity } = require('../orchestrator/cli-jail');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-jail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a device home gets the login (bound) and settings (copied once), never the shared history', (t) => {
  const dir = scratch(t);
  const shared = path.join(dir, 'homes');
  fs.mkdirSync(path.join(shared, 'claude', '.claude', 'projects', '-other-device'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'claude', '.claude', '.credentials.json'), '{"token":1}');
  fs.writeFileSync(path.join(shared, 'claude', '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(shared, 'claude', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { '/srv/x': {} } }));
  const home = path.join(dir, 'device', 'home', 'claude');
  const logins = prepareHome('claude', home, shared);
  assert.deepEqual(logins, [[fs.realpathSync(path.join(shared, 'claude', '.claude', '.credentials.json')), '.claude/.credentials.json']]);
  assert.equal(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'), '', 'only a mount point; the login itself is bound in');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), { hasCompletedOnboarding: true }, 'other people\'s project list left out');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'projects')), 'no shared history');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"mine":1}');
  prepareHome('claude', home, shared);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{"mine":1}', 'seeded once only');
});

test('the sandbox starts from nothing: no host root, no AgentDesk state, own network, fixed identity', (t) => {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const workspace = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const args = jailArgs({ runtime: dir, home, workspace, cwd: '/work/项目', writable: true, logins: [] });
  const pairs = [];
  for (let i = 0; i < args.length; i++) if (['--bind', '--ro-bind', '--dev-bind'].includes(args[i])) { pairs.push([args[i], args[i + 1], args[i + 2]]); i += 2; }
  assert.ok(!pairs.some(([, source]) => source === '/'), 'the host root is never mounted');
  for (const [, source] of pairs) {
    assert.ok(!/^\/(root|srv|home|var\/lib|var\/log|opt\/agentdesk-orchestrator|etc\/(ssh|shadow|agentdesk))/.test(source), source);
  }
  for (const flag of ['--unshare-net', '--unshare-pid', '--unshare-user', '--die-with-parent']) assert.ok(args.includes(flag), flag);
  assert.ok(pairs.some(([kind, , target]) => kind === '--bind' && target === '/work/项目'));
  assert.ok(pairs.some(([kind, , target]) => kind === '--ro-bind' && target === '/etc/passwd'));
  const readOnly = jailArgs({ runtime: dir, home, workspace, cwd: '/work/项目', writable: false, logins: [] });
  assert.equal(readOnly[readOnly.indexOf('/work/项目') - 2], '--ro-bind');
  const passwd = fs.readFileSync(writeIdentity(dir).find(([, target]) => target === '/etc/passwd')[0], 'utf8');
  assert.equal(passwd.trim().split('\n').length, 3, 'names nobody else on VPS2');
  assert.match(fs.readFileSync(path.join(dir, 'etc', 'resolv.conf'), 'utf8'), /10\.0\.2\.3/);
});
