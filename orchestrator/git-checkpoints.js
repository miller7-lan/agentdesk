// Git checkpoints for direct chats (D8, spec §6.5). Before a turn that may write, the project's state is
// recorded with `git stash create` and kept under refs/agentdesk/checkpoints/<session>/<turn>. Neither the
// working tree nor the index is touched, nothing is committed to a branch and nothing is pushed. Projects can
// switch it off. Untracked files are not part of `git stash create`; they are listed in the checkpoint note.
//
// Restoring writes tracked files back to the checkpoint's content. It is refused while another session holds
// a file lock in the project (the caller checks), so it never overwrites another session's work in progress.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const KEEP = 50;
const KEEP_DAYS = 14;
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;
const PREFIX = 'refs/agentdesk/checkpoints/';

function gitEnv() {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR)$/i.test(key)) delete env[key];
  return env;
}

async function git(root, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await exec('git', ['-C', root, ...args], { env: gitEnv(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

// Returns { ref, commit, untracked } or { skipped: reason }.
async function createCheckpoint(root, { session, turn, enabled = true, now = Date.now } = {}) {
  if (!enabled) return { skipped: 'disabled' };
  if (!SAFE.test(session || '') || !SAFE.test(turn || '')) throw new Error('invalid_checkpoint_name');
  if (await git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) !== 'true') return { skipped: 'not_a_repository' };
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (!head) return { skipped: 'no_commit_yet' };
  // An empty result means no tracked changes: the checkpoint is HEAD itself.
  const stash = await git(root, ['stash', 'create', `agentdesk checkpoint ${session}/${turn}`]);
  const commit = stash || head;
  const ref = PREFIX + session + '/' + turn;
  await git(root, ['update-ref', '-m', 'agentdesk checkpoint', ref, commit]);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length;
  await prune(root, { now });
  return { ref, commit, head, untracked, at: new Date(now()).toISOString() };
}

async function list(root) {
  const out = await git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname)%00%(objectname)%00%(creatordate:unix)', PREFIX], { allowFail: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, commit, time] = line.split('\0');
    return { ref, commit, at: new Date(Number(time) * 1000).toISOString() };
  });
}

// Keeps the newest 50 checkpoints and nothing older than 14 days (a suggestion of the spec, adjustable).
async function prune(root, { keep = KEEP, days = KEEP_DAYS, now = Date.now } = {}) {
  const all = await list(root);
  const cutoff = now() - days * 86_400_000;
  const drop = all.filter((item, index) => index >= keep || Date.parse(item.at) < cutoff);
  for (const item of drop) await git(root, ['update-ref', '-d', item.ref], { allowFail: true });
  return drop.length;
}

// Writes tracked files back to the checkpoint. `othersHoldLocks` is checked by the caller (spec §6.5).
async function restoreCheckpoint(root, ref, { othersHoldLocks = false } = {}) {
  if (typeof ref !== 'string' || !ref.startsWith(PREFIX) || ref.split('/').length !== 5 || !ref.split('/').slice(3).every((part) => SAFE.test(part))) {
    throw new Error('invalid_checkpoint_ref');
  }
  if (othersHoldLocks) throw new Error('checkpoint_restore_blocked_by_locks');
  const commit = await git(root, ['rev-parse', '--verify', ref + '^{commit}']);
  await git(root, ['restore', '--source=' + commit, '--worktree', '--', ':/']);
  return { restored: ref, commit };
}

module.exports = { createCheckpoint, restoreCheckpoint, list, prune, PREFIX };
