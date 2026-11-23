// Per-device direct-chat metadata (D17): one SQLite file per device under
// <state>/direct-chat/<deviceId>/state.sqlite. Metadata only: no message text, no file contents, no tokens.
// Several chat-server processes of the same device (one per provider) share the file; WAL plus a busy
// timeout lets them write without stepping on each other.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { deviceStateDir } = require('./device-registry');

const AUDIT_DAYS = 60;

class DirectChatStore {
  constructor(stateRoot, deviceId) {
    this.deviceId = deviceId;
    this.directory = deviceStateDir(stateRoot, deviceId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of ['attachments', 'threads', 'native', 'codex-workspace']) {
      fs.mkdirSync(path.join(this.directory, name), { recursive: true, mode: 0o700 });
    }
    this.filename = path.join(this.directory, 'state.sqlite');
    this.db = new DatabaseSync(this.filename);
    try { fs.chmodSync(this.filename, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_hash TEXT, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_provider ON sessions(provider);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        state TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0, file TEXT, created_at INTEGER NOT NULL,
        received_at INTEGER, expires_at INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS attachments_session ON attachments(session_id);
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  close() { try { this.db.close(); } catch {} }

  /* sessions: the chat-server's thread metadata, one row per thread */
  loadSessions(provider) {
    const threads = {};
    for (const row of this.db.prepare('SELECT id, body FROM sessions WHERE provider = ?').all(provider)) {
      try { threads[row.id] = JSON.parse(row.body); } catch {}
    }
    return threads;
  }

  saveSessions(provider, threads) {
    const now = Date.now();
    const upsert = this.db.prepare(`INSERT INTO sessions (id, provider, project_hash, body, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body, project_hash = excluded.project_hash, updated_at = excluded.updated_at`);
    const ids = Object.keys(threads);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        const thread = threads[id];
        upsert.run(id, provider, thread.projectHash || null, JSON.stringify(thread), thread.updatedAt || now);
      }
      const existing = this.db.prepare('SELECT id FROM sessions WHERE provider = ?').all(provider).map((row) => row.id);
      const remove = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      for (const id of existing) if (!Object.hasOwn(threads, id)) remove.run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  purgeSession(id) {
    fs.rmSync(path.join(this.directory, 'attachments', id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM attachments WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM audit WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }

  migrated(name) {
    return Boolean(this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name));
  }

  markMigrated(name) {
    this.db.prepare('INSERT OR IGNORE INTO migrations (name, at) VALUES (?, ?)').run(name, Date.now());
  }

  /* attachments (D9) */
  putAttachment(item) {
    this.db.prepare(`INSERT INTO attachments (id, session_id, name, size, sha256, state, received, file, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(item.id, item.sessionId, item.name, item.size, item.sha256, 'uploading',
      item.file, item.createdAt, item.expiresAt);
  }

  updateAttachment(id, fields) {
    const current = this.attachment(id);
    if (!current) return null;
    const next = { ...current, ...fields };
    this.db.prepare(`UPDATE attachments SET state = ?, received = ?, received_at = ?, error = ? WHERE id = ?`)
      .run(next.state, next.received, next.receivedAt ?? null, next.error ?? null, id);
    return this.attachment(id);
  }

  attachment(id) {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    return row ? {
      id: row.id, sessionId: row.session_id, name: row.name, size: row.size, sha256: row.sha256, state: row.state,
      received: row.received, file: row.file, createdAt: row.created_at, receivedAt: row.received_at ?? undefined,
      expiresAt: row.expires_at, error: row.error ?? undefined,
    } : null;
  }

  attachments(sessionId) {
    return this.db.prepare('SELECT id FROM attachments WHERE session_id = ? ORDER BY created_at').all(sessionId)
      .map((row) => this.attachment(row.id));
  }

  deleteAttachment(id) { this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id); }

  expiredAttachments(now = Date.now()) {
    return this.db.prepare('SELECT id FROM attachments WHERE expires_at <= ?').all(now).map((row) => this.attachment(row.id));
  }

  /* audit (§11): metadata only, kept for 60 days */
  audit(kind, sessionId, detail) {
    const text = detail === undefined ? null : JSON.stringify(detail).slice(0, 4000);
    this.db.prepare('INSERT INTO audit (at, kind, session_id, detail) VALUES (?, ?, ?, ?)').run(Date.now(), String(kind).slice(0, 64),
      sessionId ?? null, text);
  }

  auditEntries(limit = 100) {
    return this.db.prepare('SELECT seq, at, kind, session_id AS sessionId, detail FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
      .map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : undefined }));
  }

  pruneAudit(now = Date.now()) {
    this.db.prepare('DELETE FROM audit WHERE at < ?').run(now - AUDIT_DAYS * 86_400_000);
  }
}

module.exports = { DirectChatStore, AUDIT_DAYS };
