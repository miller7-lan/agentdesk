const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cliHistory = require('../orchestrator/cli-history');

function dirs(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cli-history-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return { home, root: path.join(base, 'history', 'chat-antigravity-lenovo') };
}

test('each private history folder and file gets its own copy bound over the shared home; logins are never bound', (t) => {
  for (const provider of ['antigravity', 'claude', 'grok']) {
    const { home, root } = dirs(t);
    const pairs = cliHistory.binds(provider, home, root);
    assert.ok(pairs.length > 0);
    for (const [source, target] of pairs) {
      assert.ok(source.startsWith(root + path.sep));
      assert.ok(target.startsWith(home + path.sep));
      assert.equal(path.relative(root, source), path.relative(home, target));
      assert.ok(fs.existsSync(source) && fs.existsSync(target));
    }
    const bound = pairs.map(([, target]) => path.relative(home, target));
    for (const login of ['.gemini/oauth_creds.json', '.gemini/antigravity-cli/antigravity-oauth-token', '.claude/.credentials.json',
      '.claude.json', '.grok/auth.json', '.gemini/config', '.gemini/antigravity-cli']) {
      assert.ok(!bound.includes(login), `${provider} must not bind ${login}`);
    }
    const args = cliHistory.bwrapArgs(pairs);
    assert.equal(args.length, pairs.length * 3);
    assert.deepEqual(args.slice(0, 3), ['--bind', ...pairs[0]]);
  }
  assert.ok(cliHistory.binds('antigravity', '', '/x').length === 0);
  assert.ok(cliHistory.binds('codex', '/h', '/x').length === 0);
});

test('the conversation transcripts of every provider are among the private paths', () => {
  const all = (provider) => [...cliHistory.PRIVATE[provider].dirs, ...cliHistory.PRIVATE[provider].files];
  assert.ok(all('antigravity').includes(path.join('.gemini', 'antigravity-cli', 'brain')));
  assert.ok(all('antigravity').includes(path.join('.gemini', 'antigravity-cli', 'conversations')));
  assert.ok(all('antigravity').includes(path.join('.gemini', 'antigravity-cli', 'conversation_summaries.db')));
  assert.ok(all('claude').includes(path.join('.claude', 'projects')));
  assert.ok(all('grok').includes(path.join('.grok', 'sessions')));
});

test('resuming an older conversation copies only that one from the shared home, once, without touching the original', (t) => {
  const { home, root } = dirs(t);
  const base = path.join(home, '.gemini', 'antigravity-cli');
  for (const id of ['mine-1', 'other-2']) {
    fs.mkdirSync(path.join(base, 'brain', id), { recursive: true });
    fs.writeFileSync(path.join(base, 'brain', id, 'transcript.jsonl'), id);
    fs.mkdirSync(path.join(base, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(base, 'conversations', id + '.db'), id);
  }
  assert.equal(cliHistory.adopt('antigravity', home, root, 'mine-1'), 2);
  const own = path.join(root, '.gemini', 'antigravity-cli');
  assert.equal(fs.readFileSync(path.join(own, 'brain', 'mine-1', 'transcript.jsonl'), 'utf8'), 'mine-1');
  assert.equal(fs.readFileSync(path.join(own, 'conversations', 'mine-1.db'), 'utf8'), 'mine-1');
  assert.ok(!fs.existsSync(path.join(own, 'brain', 'other-2')));
  assert.ok(fs.existsSync(path.join(base, 'brain', 'mine-1')));
  // A second resume keeps the instance's own (newer) copy.
  fs.writeFileSync(path.join(own, 'conversations', 'mine-1.db'), 'newer');
  assert.equal(cliHistory.adopt('antigravity', home, root, 'mine-1'), 0);
  assert.equal(fs.readFileSync(path.join(own, 'conversations', 'mine-1.db'), 'utf8'), 'newer');
  // Session IDs are never paths.
  for (const bad of ['../other-2', '', null, '.', 'a/b']) assert.equal(cliHistory.adopt('antigravity', home, root, bad), 0);
  assert.ok(!fs.existsSync(path.join(own, 'brain', 'other-2')));
});

test('Claude and Grok conversations are adopted from their working-folder directories', (t) => {
  const { home, root } = dirs(t);
  const claudeFolder = path.join('.claude', 'projects', '-var-lib-thread-1');
  fs.mkdirSync(path.join(home, claudeFolder, 'sess-a', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(home, claudeFolder, 'sess-a.jsonl'), 'a');
  fs.writeFileSync(path.join(home, claudeFolder, 'sess-b.jsonl'), 'b');
  assert.equal(cliHistory.adopt('claude', home, root, 'sess-a'), 2);
  assert.equal(fs.readFileSync(path.join(root, claudeFolder, 'sess-a.jsonl'), 'utf8'), 'a');
  assert.ok(fs.existsSync(path.join(root, claudeFolder, 'sess-a', 'subagents')));
  assert.ok(!fs.existsSync(path.join(root, claudeFolder, 'sess-b.jsonl')));

  const grokFolder = path.join('.grok', 'sessions', encodeURIComponent('/var/lib/thread-2'));
  fs.mkdirSync(path.join(home, grokFolder, 'g-1'), { recursive: true });
  fs.writeFileSync(path.join(home, grokFolder, 'g-1', 'chat_history.jsonl'), 'g');
  fs.mkdirSync(path.join(home, grokFolder, 'g-2'), { recursive: true });
  assert.equal(cliHistory.adopt('grok', home, root, 'g-1'), 1);
  assert.ok(fs.existsSync(path.join(root, grokFolder, 'g-1', 'chat_history.jsonl')));
  assert.ok(!fs.existsSync(path.join(root, grokFolder, 'g-2')));
});

test('deleting a chat removes its Antigravity transcript from the instance history only', (t) => {
  const { home, root } = dirs(t);
  const own = path.join(root, '.gemini', 'antigravity-cli');
  for (const id of ['gone', 'kept']) {
    fs.mkdirSync(path.join(own, 'brain', id), { recursive: true });
    fs.mkdirSync(path.join(own, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(own, 'conversations', id + '.db'), id);
    fs.writeFileSync(path.join(own, 'conversations', id + '.db-wal'), id);
  }
  cliHistory.purge('antigravity', root, ['gone', '../kept']);
  assert.ok(!fs.existsSync(path.join(own, 'brain', 'gone')));
  assert.ok(!fs.existsSync(path.join(own, 'conversations', 'gone.db')));
  assert.ok(!fs.existsSync(path.join(own, 'conversations', 'gone.db-wal')));
  assert.ok(fs.existsSync(path.join(own, 'brain', 'kept')));
  assert.ok(fs.existsSync(path.join(own, 'conversations', 'kept.db')));
  assert.ok(fs.existsSync(home));
});

test('chat-server binds the instance history in the sandbox and adopts older conversations first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'chat-server.js'), 'utf8');
  assert.match(source, /const HISTORY_ROOT = path\.join\(STATE_DIR, 'cli-history', instance\)/);
  assert.match(source, /if \(SANDBOX\) \{[\s\S]*?cliHistory\.adopt\(PROVIDER, HOME, HISTORY_ROOT, turn\.thread\.sessionId\)[\s\S]*?launch\.args\.splice\(launch\.args\.indexOf\('--chdir'\), 0, \.\.\.cliHistory\.bwrapArgs\(cliHistory\.binds\(PROVIDER, HOME, HISTORY_ROOT\)\)\)/);
  assert.match(source, /for \(const home of \[HISTORY_ROOT, HOME\]\) await require\('\.\/project-delete'\)\.cliHistory/);
  assert.match(source, /cliHistory\.purge\(PROVIDER, HISTORY_ROOT, sessions\)/);
});
