// Per-device CLI conversation history for single chats.
//
// Every single chat of one provider shares one CLI home on VPS2 (homes/<provider>): it holds the login, and the
// login is refreshed in place, so it cannot be copied per device. The CLI also keeps every conversation's
// transcript in that home, and a conversation may use its shell, so without this one device's chat could read
// another device's conversations (and the WeChat assistant's, and group steps').
//
// In the sandbox, the folders below are therefore replaced by this chat instance's own copies (one per
// device, or per native session), bound over the shared home. The login and settings stay shared; the
// conversations do not. The list is of history, not of logins: a history location a future CLI version adds is
// not hidden until it is listed here, but nothing breaks.
const fs = require('node:fs');
const path = require('node:path');

const AGY = path.join('.gemini', 'antigravity-cli');
const PRIVATE = {
  // agy keeps conversations in SQLite (WAL) next to other files: binding single files would leave the -wal/-shm
  // journals in the shared folder, where two devices' databases could pick up each other's journal. So the whole
  // folder is the instance's own; only the login token inside it (rewritten in place) is bound back from the shared
  // home. A new folder is seeded once with the shared one's program files and settings, never its history.
  antigravity: {
    folder: AGY,
    shared: ['antigravity-oauth-token'],
    // Copied into a new instance folder (program files and settings, no history); anything else agy recreates.
    seed: ['bin', 'builtin', 'installation_id', 'settings.json', 'jetski_state.pbtxt', 'last_check.timestamp'],
    dirs: [],
  },
  claude: {
    dirs: [...['projects', 'sessions', 'session-env', 'shell-snapshots', 'todos', 'file-history', 'plans', 'paste-cache', 'debug']
      .map((name) => path.join('.claude', name)), path.join('.cache', 'claude-cli-nodejs')],
  },
  grok: { dirs: ['sessions', 'logs', 'memtrace'].map((name) => path.join('.grok', name)) },
};
const SEEDED = '.agentdesk-seeded';

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The bwrap binds for one chat instance: [source, target] pairs, sources under root, targets under home.
// Both ends are created first (bwrap needs the target to exist inside the bound home).
function binds(provider, home, root) {
  const spec = PRIVATE[provider];
  if (!spec || !home || !root) return [];
  const pairs = [];
  if (spec.folder) {
    const source = path.join(root, spec.folder);
    const target = path.join(home, spec.folder);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(source, SEEDED))) {
      for (const name of spec.seed) {
        if (!fs.existsSync(path.join(target, name))) continue;
        fs.cpSync(path.join(target, name), path.join(source, name), { recursive: true, force: false, errorOnExist: false,
          preserveTimestamps: true, verbatimSymlinks: true });
      }
      fs.writeFileSync(path.join(source, SEEDED), new Date().toISOString() + '\n', { mode: 0o600 });
    }
    pairs.push([source, target]);
    for (const name of spec.shared) {
      const shared = path.join(target, name);
      if (!fs.existsSync(shared)) continue;
      // The mount point inside the instance folder; the shared file is bound onto it.
      fs.closeSync(fs.openSync(path.join(source, name), 'a', 0o600));
      pairs.push([shared, shared]);
    }
  }
  for (const relative of spec.dirs || []) {
    const source = path.join(root, relative);
    const target = path.join(home, relative);
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
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
