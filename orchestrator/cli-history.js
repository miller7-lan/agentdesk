// Per-device CLI conversation history for single chats.
//
// Every single chat of one provider shares one CLI home on VPS2 (homes/<provider>): it holds the login, and the
// login is refreshed in place, so it cannot be copied per device. The CLI also keeps every conversation's
// transcript in that home, and a conversation may use its shell, so without this one device's chat could read
// another device's conversations (and the WeChat assistant's, and group steps').
//
// In the sandbox, the folders and files below are therefore replaced by this chat instance's own copies (one per
// device, or per native session), bound over the shared home. The login and settings stay shared; the
// conversations do not. The list is of history, not of logins: a history location a future CLI version adds is
// not hidden until it is listed here, but nothing breaks.
const fs = require('node:fs');
const path = require('node:path');

const PRIVATE = {
  antigravity: {
    dirs: ['brain', 'conversations', 'annotations', 'implicit', 'log', 'presence', 'scratch', 'cache', 'crashes']
      .map((name) => path.join('.gemini', 'antigravity-cli', name)),
    // jetbox_summaries_proto.pb is replaced by rename, which a bound file refuses (EBUSY): agy logs that and goes
    // on without the summary cache. The point is that it no longer sees every other conversation's summary.
    files: ['conversation_summaries.db', 'jetbox_summaries_proto.pb', 'history.jsonl']
      .map((name) => path.join('.gemini', 'antigravity-cli', name)),
  },
  claude: {
    dirs: [...['projects', 'sessions', 'session-env', 'shell-snapshots', 'todos', 'file-history', 'plans', 'paste-cache', 'debug']
      .map((name) => path.join('.claude', name)), path.join('.cache', 'claude-cli-nodejs')],
    files: [],
  },
  grok: { dirs: ['sessions', 'logs', 'memtrace'].map((name) => path.join('.grok', name)), files: [] },
};

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The bwrap binds for one chat instance: [source, target] pairs, sources under root, targets under home.
// Both ends are created first (bwrap needs the target to exist inside the bound home).
function binds(provider, home, root) {
  const spec = PRIVATE[provider];
  if (!spec || !home || !root) return [];
  const pairs = [];
  for (const relative of spec.dirs) {
    const source = path.join(root, relative);
    const target = path.join(home, relative);
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    pairs.push([source, target]);
  }
  for (const relative of spec.files) {
    const source = path.join(root, relative);
    const target = path.join(home, relative);
    for (const file of [source, target]) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    pairs.push([source, target]);
  }
  return pairs;
}

function bwrapArgs(pairs) {
  return pairs.flatMap(([source, target]) => ['--bind', source, target]);
}

function copyMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(source, target, { recursive: true, preserveTimestamps: true, errorOnExist: false, force: false });
  return true;
}

// A conversation started before this change has its transcript in the shared home. The first time it is resumed,
// that one conversation is copied into the instance's own history (the thread record says it is this instance's),
// so it continues with its context. Nothing else is copied; the shared copy is left where it is.
function adopt(provider, home, root, session) {
  if (!PRIVATE[provider] || !home || !root || typeof session !== 'string' || !SESSION.test(session)) return 0;
  let copied = 0;
  const copy = (relative) => { if (copyMissing(path.join(home, relative), path.join(root, relative))) copied++; };
  const list = (relative) => { try { return fs.readdirSync(path.join(home, relative)); } catch { return []; } };
  if (provider === 'antigravity') {
    const base = path.join('.gemini', 'antigravity-cli');
    copy(path.join(base, 'brain', session));
    for (const suffix of ['.db', '.db-wal', '.db-shm']) copy(path.join(base, 'conversations', session + suffix));
    copy(path.join(base, 'annotations', session + '.pbtxt'));
  } else if (provider === 'claude') {
    const projects = path.join('.claude', 'projects');
    for (const folder of list(projects)) {
      if (!fs.existsSync(path.join(home, projects, folder, session + '.jsonl'))) continue;
      copy(path.join(projects, folder, session + '.jsonl'));
      copy(path.join(projects, folder, session));
    }
  } else if (provider === 'grok') {
    const sessions = path.join('.grok', 'sessions');
    for (const folder of list(sessions)) copy(path.join(sessions, folder, session));
  }
  return copied;
}

// Deleting a single chat: its Antigravity transcript in this instance's own history goes too (the working-folder
// keyed Claude/Grok histories are removed by project-delete.cliHistory). Only ever called with the instance root.
function purge(provider, root, sessions) {
  if (provider !== 'antigravity' || !root) return;
  const base = path.join(root, '.gemini', 'antigravity-cli');
  for (const session of sessions) {
    if (typeof session !== 'string' || !SESSION.test(session)) continue;
    for (const target of [path.join(base, 'brain', session), path.join(base, 'annotations', session + '.pbtxt'),
      ...['.db', '.db-wal', '.db-shm'].map((suffix) => path.join(base, 'conversations', session + suffix))]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

module.exports = { PRIVATE, binds, bwrapArgs, adopt, purge };
