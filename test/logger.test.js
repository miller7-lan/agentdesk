const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger, redact, diagnostics } = require('../logger');

function dir(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-log-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('secrets and user content never reach the log', () => {
  const clean = redact({ token: 'abc', apiKey: 'k', nested: { password: 'p', path: 'C:\\work\\a.js' },
    content: 'file body', prompt: 'do things', tool: 'windows_file_write', long: 'x'.repeat(900) });
  assert.equal(clean.token, '[redacted]');
  assert.equal(clean.apiKey, '[redacted]');
  assert.equal(clean.nested.password, '[redacted]');
  assert.equal(clean.nested.path, 'C:\\work\\a.js');
  assert.equal(clean.content, '[omitted 9 chars]');
  assert.equal(clean.prompt, '[omitted 9 chars]');
  assert.equal(clean.tool, 'windows_file_write');
  assert.match(clean.long, /…\(900\)$/);
  assert.deepEqual(redact(Object.assign(new Error('boom'), { code: 'E1' })), { name: 'Error', message: 'boom', code: 'E1' });
});

test('one file per day, split when large, older than a week removed', (t) => {
  const folder = dir(t);
  fs.writeFileSync(path.join(folder, 'agentdesk-2026-11-01.log'), 'old\n');
  let now = new Date('2026-11-17T10:00:00Z');
  const log = new Logger({ dir: folder, maxBytes: 200, now: () => now });
  assert.ok(!fs.existsSync(path.join(folder, 'agentdesk-2026-11-01.log')), 'files older than seven days are pruned');
  for (let i = 0; i < 6; i++) log.info('remote.status', { codex: 'ready', i });
  assert.ok(log.files().length >= 2, 'a large day is split into parts');
  now = new Date('2026-11-18T09:00:00Z');
  log.warn('remote.status', { codex: 'retry' });
  const tail = log.tail(3);
  assert.equal(tail.length, 3);
  assert.match(tail.at(-1), /^2026-11-18T09:00:00.000Z WARN  remote\.status \{"codex":"retry"\}$/);
});

test('the diagnostics report holds version, redacted config, state and recent log lines', () => {
  const report = diagnostics({ info: { version: '0.2.7' }, config: { host: 'vps.example', codexKey: '/home/u/.agentdesk/key', token: 'secret' },
    state: { codex: 'ready' }, logs: ['line 1', 'line 2'] });
  assert.match(report, /"version": "0\.2\.7"/);
  assert.match(report, /"token": "\[redacted\]"/);
  assert.doesNotMatch(report, /secret/);
  assert.match(report, /最近日志（2 行）\nline 1\nline 2/);
});
