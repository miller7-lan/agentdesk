// Desktop log: one file per day, a few MB at most, kept for a week. Events only: no prompts, no file
// contents, no keys. Plain Node so it can be tested without Electron.
const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = /token|password|secret|passphrase|authorization|cookie|api[-_]?key|private[-_]?key|credential/i;
const CONTENT_KEY = /^(content|data|b64|base64|text|prompt|input|output|stdout|stderr|imageUrl)$/i;

// Keys that hold secrets or user content are replaced; long strings are cut short.
function redact(value, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + `…(${value.length})` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message), code: value.code };
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_KEY.test(key) ? '[redacted]' : CONTENT_KEY.test(key) ? `[omitted ${typeof item === 'string' ? item.length + ' chars' : typeof item}]` : redact(item, depth + 1)]));
}

class Logger {
  constructor({ dir, maxBytes = 5 * 1024 * 1024, keepDays = 7, now = () => new Date() }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keepDays = keepDays;
    this.now = now;
    this.part = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    this.prune();
  }

  file(date = this.now()) {
    const day = date.toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.part = 0; }
    for (;;) {
      const name = path.join(this.dir, `agentdesk-${day}${this.part ? '.' + this.part : ''}.log`);
      let size = 0;
      try { size = fs.statSync(name).size; } catch {}
      if (size < this.maxBytes || this.part >= 9) return name;   // a day caps at ten parts
      this.part += 1;
    }
  }

  write(level, event, data) {
    const time = this.now();
    const line = `${time.toISOString()} ${level.toUpperCase().padEnd(5)} ${event}${data === undefined ? '' : ' ' + JSON.stringify(redact(data))}\n`;
    try { fs.appendFileSync(this.file(time), line, { mode: 0o600 }); } catch {}
  }

  info(event, data) { this.write('info', event, data); }
  warn(event, data) { this.write('warn', event, data); }
  error(event, data) { this.write('error', event, data); }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((name) => /^agentdesk-\d{4}-\d{2}-\d{2}(\.\d)?\.log$/.test(name)).sort((a, b) => {
        const key = (name) => name.replace(/\.log$/, '').replace(/^(agentdesk-\d{4}-\d{2}-\d{2})$/, '$1.0');
        return key(a).localeCompare(key(b));
      });
    } catch { return []; }
  }

  prune() {
    const cutoff = this.now().getTime() - this.keepDays * 86400_000;
    for (const name of this.files()) {
      const day = Date.parse(name.slice(10, 20) + 'T00:00:00Z');
      if (day < cutoff) try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch {}
    }
  }

  // The most recent lines across files, oldest first.
  tail(count = 2000) {
    const lines = [];
    for (const name of this.files().reverse()) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch { continue; }
      lines.unshift(...text.split('\n').filter(Boolean));
      if (lines.length >= count) break;
    }
    return lines.slice(-count);
  }
}

// A plain-text report a person can read and attach to a question.
function diagnostics({ info, config, state, logs }) {
  return [
    '# AgentDesk 诊断信息',
    '',
    '生成时间：' + new Date().toISOString(),
    '',
    '## 版本与系统',
    JSON.stringify(redact(info), null, 2),
    '',
    '## 连接配置（已去除密钥）',
    JSON.stringify(redact(config), null, 2),
    '',
    '## 当前连接状态',
    JSON.stringify(redact(state), null, 2),
    '',
    `## 最近日志（${logs.length} 行）`,
    ...logs,
    '',
  ].join('\n');
}

module.exports = { Logger, redact, diagnostics };
