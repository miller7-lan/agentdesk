// CLI upgrades from the client (D11, Q5, spec §9.3).
//
// Request side (orchestrator, service account): any approved device may ask for an upgrade of one CLI; the
// request is validated and written to a spool folder. Nothing is upgraded by the orchestrator itself.
// Runner side (root, a separate unit that is NOT installed: gate G3): picks up requests one at a time under the
// same flock as the daily timer, marks the CLI as upgrading so new direct-chat turns wait while running turns
// continue, backs up the installed version, runs the vendor's own updater, checks the result without a model
// call, and restores the backup when the check fails. Every step is written to the request's result file.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');

// The vendor updaters this machine uses (see /usr/local/sbin/agentdesk-cli-update). Only "latest" is offered:
// whether each updater can install a chosen version is not verified, so versions are refused rather than guessed.
const PROVIDERS = {
  codex: { bin: '/usr/bin/codex', update: ['update'] },
  claude: { bin: '/usr/bin/claude', update: ['update'] },
  grok: { bin: '/usr/local/bin/grok', update: ['update'] },
  antigravity: { bin: '/usr/local/bin/agy', update: ['update'] },
};
const DEFAULT_SPOOL = '/var/lib/agentdesk-orchestrator/cli-upgrade';
const DEFAULT_BACKUPS = '/var/lib/agentdesk-cli-rollback';
const REQUEST_ID = /^[0-9]{15}-[0-9a-f]{12}$/;
const fail = (code) => Object.assign(new Error(code), { code });

function folders(spool) {
  const value = { requests: path.join(spool, 'requests'), results: path.join(spool, 'results'), state: path.join(spool, 'state') };
  for (const folder of Object.values(value)) fs.mkdirSync(folder, { recursive: true, mode: 0o770 });
  return value;
}

function atomicJson(file, value, mode = 0o640) {
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode });
  fs.renameSync(temporary, file);
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// Q5: every approved device may ask. Returns the queued request, or the pending one it was merged into.
function requestUpgrade({ spool = DEFAULT_SPOOL, provider, target = 'latest', device, now = Date.now }) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw fail('invalid_cli_provider');
  if (target !== 'latest') throw fail('cli_version_selection_unsupported');
  if (!device || device.state !== 'approved') throw fail('device_not_approved');
  const { requests, results } = folders(spool);
  for (const name of fs.readdirSync(requests).sort()) {
    const pending = readJson(path.join(requests, name));
    if (pending?.provider === provider && !readJson(path.join(results, name))?.finishedAt) {
      return { requestId: pending.requestId, state: 'queued', merged: true, provider };
    }
  }
  const requestId = `${String(now()).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
  const request = { requestId, provider, target, deviceId: device.deviceId, label: device.label, requestedAt: new Date(now()).toISOString() };
  atomicJson(path.join(requests, requestId + '.json'), request);
  return { requestId, state: 'queued', merged: false, provider };
}

function upgradeStatus({ spool = DEFAULT_SPOOL } = {}) {
  const { requests, results, state } = folders(spool);
  const list = fs.readdirSync(requests).filter((name) => name.endsWith('.json')).sort().slice(-50).map((name) => {
    const request = readJson(path.join(requests, name));
    const result = readJson(path.join(results, name));
    return { ...request, state: result?.state || 'queued', events: result?.events || [], fromVersion: result?.fromVersion, toVersion: result?.toVersion,
      finishedAt: result?.finishedAt };
  });
  const upgrading = fs.readdirSync(state).filter((name) => name.endsWith('.upgrading')).map((name) => name.replace(/\.upgrading$/, ''));
  return { requests: list, upgrading, runnerInstalled: fs.existsSync(path.join(spool, 'runner-installed')) };
}

// New direct-chat turns of a CLI wait while it is being upgraded (running turns are not interrupted).
function isUpgrading(provider, { spool = DEFAULT_SPOOL, maxAgeMs = 30 * 60_000, now = Date.now } = {}) {
  try {
    const stat = fs.statSync(path.join(spool, 'state', provider + '.upgrading'));
    return now() - stat.mtimeMs < maxAgeMs;   // a stale marker (crashed runner) does not block turns forever
  } catch { return false; }
}

/* ---------- runner (root; not installed until G3 is confirmed) ---------- */
function run(command, args, { timeout = 900_000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { timeout, env: { ...process.env, CI: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// The thing to back up: the npm package folder for an npm-installed CLI, otherwise the binary itself.
function installRoot(bin) {
  const real = fs.realpathSync(bin);
  let folder = path.dirname(real);
  while (folder !== path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, 'package.json')) && folder.includes(`${path.sep}node_modules${path.sep}`)) return { kind: 'directory', path: folder };
    folder = path.dirname(folder);
  }
  return { kind: 'file', path: real };
}

function digest(file) {
  try { return createHash('sha256').update(fs.readFileSync(fs.realpathSync(file))).digest('hex'); } catch { return null; }
}

function restore(backup, root) {
  const aside = root.path + '.agentdesk-failed-' + Date.now();
  fs.renameSync(root.path, aside);
  try {
    fs.cpSync(backup, root.path, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  } catch (error) {
    fs.renameSync(aside, root.path);
    throw error;
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

async function runRequest(request, { spool = DEFAULT_SPOOL, backups = DEFAULT_BACKUPS, providers = PROVIDERS, exec, now = Date.now,
  doctor = async () => ({ ok: true }) } = {}) {
  if (!REQUEST_ID.test(request?.requestId || '') || !Object.hasOwn(providers, request.provider)) throw fail('invalid_cli_upgrade_request');
  const { results, state } = folders(spool);
  const resultFile = path.join(results, request.requestId + '.json');
  const record = { requestId: request.requestId, provider: request.provider, state: 'started', events: [] };
  const event = (type, detail = {}) => {
    record.events.push({ type: 'cli.upgrade.' + type, at: new Date(now()).toISOString(), ...detail });
    atomicJson(resultFile, record);
  };
  const { bin, update } = providers[request.provider];
  const version = async () => {
    const answer = await run(bin, ['--version'], { timeout: 20_000, exec });
    return answer.code === 0 ? answer.stdout.trim().split('\n')[0].slice(0, 120) : null;
  };
  const marker = path.join(state, request.provider + '.upgrading');
  fs.writeFileSync(marker, request.requestId);
  try {
    event('started');
    record.fromVersion = await version();
    record.fromSha256 = digest(bin);
    const root = installRoot(bin);
    const backup = path.join(backups, request.provider, (record.fromVersion || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_'));
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.cpSync(root.path, backup, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    event('progress', { step: 'backed_up', fromVersion: record.fromVersion });
    const updated = await run(bin, update, { exec });
    record.toVersion = await version();
    record.toSha256 = digest(bin);
    // The check: the CLI starts and reports a version, and the orchestrator's doctor still sees it. No model call.
    const health = updated.code === 0 && record.toVersion ? await doctor(request.provider) : { ok: false, error: 'updater_failed' };
    if (!health.ok) {
      restore(backup, root);
      record.toVersion = await version();
      record.state = 'rolledBack';
      event('rolledBack', { reason: health.error || 'smoke_failed', updaterExit: updated.code, stderr: updated.stderr.slice(-400) });
    } else {
      record.state = 'succeeded';
      event('succeeded', { fromVersion: record.fromVersion, toVersion: record.toVersion, changed: record.fromSha256 !== record.toSha256 });
    }
  } catch (error) {
    record.state = 'failed';
    event('failed', { error: error.message });
  } finally {
    record.finishedAt = new Date(now()).toISOString();
    atomicJson(resultFile, record);
    try { fs.unlinkSync(marker); } catch {}
  }
  return record;
}

// One pass over the queue, oldest first; the caller holds /run/agentdesk-cli-update.lock (shared with the timer).
async function runPending(options = {}) {
  const spool = options.spool || DEFAULT_SPOOL;
  const { requests, results } = folders(spool);
  const done = [];
  for (const name of fs.readdirSync(requests).filter((item) => item.endsWith('.json')).sort()) {
    if (readJson(path.join(results, name))?.finishedAt) continue;
    const request = readJson(path.join(requests, name));
    if (request) done.push(await runRequest(request, options));
  }
  return done;
}

module.exports = { PROVIDERS, requestUpgrade, upgradeStatus, isUpgrading, runRequest, runPending, installRoot, DEFAULT_SPOOL };

if (require.main === module && process.argv[2] === 'run-pending') {
  // Sample entry point for the root unit (gate G3): flock -n /run/agentdesk-cli-update.lock node cli-upgrade.js run-pending
  if (process.getuid?.() !== 0) { process.stderr.write('cli-upgrade runner must run as root\n'); process.exit(2); }
  runPending().then((list) => process.stdout.write(JSON.stringify(list.map(({ requestId, provider, state }) => ({ requestId, provider, state }))) + '\n'),
    (error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
