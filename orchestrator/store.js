const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS records (
        bucket TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(bucket, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL, document TEXT NOT NULL
      );
    `);
  }

  get(bucket, id) {
    const row = this.db.prepare('SELECT document FROM records WHERE bucket=? AND id=?').get(bucket, id);
    return row && JSON.parse(row.document);
  }

  put(bucket, id, document) {
    this.db.prepare(`
      INSERT INTO records VALUES (?, ?, ?)
      ON CONFLICT(bucket, id) DO UPDATE SET document=excluded.document
    `).run(bucket, id, JSON.stringify(document));
  }

  delete(bucket, id) {
    this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id);
  }

  pruneMessages(cutoff) {
    this.db.prepare("DELETE FROM records WHERE bucket IN ('received', 'sent') AND id < ?").run(cutoff);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  // Drop old task records together with their events. The caller decides which tasks are safe to drop.
  deleteTasks(ids) {
    const list = [...new Set(ids)].filter((id) => typeof id === 'string');
    if (!list.length) return 0;
    const removeTask = this.db.prepare("DELETE FROM records WHERE bucket='tasks' AND id=?");
    const removeEvents = this.db.prepare('DELETE FROM events WHERE task_id=?');
    this.db.exec('BEGIN');
    try {
      for (const id of list) { removeEvents.run(id); removeTask.run(id); }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return list.length;
  }

  // SQLite keeps the pages of deleted rows until a VACUUM. Run it only after a history prune, not hourly.
  vacuum() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
  }

  all(bucket) {
    return this.db.prepare('SELECT document FROM records WHERE bucket=? ORDER BY rowid')
      .all(bucket).map((row) => JSON.parse(row.document));
  }

  saveTask(task, event) {
    this.db.exec('BEGIN');
    try {
      this.put('tasks', task.id, task);
      this.db.prepare('INSERT INTO events(task_id, document) VALUES (?, ?)')
        .run(task.id, JSON.stringify({ ...event, time: new Date().toISOString() }));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  events(taskId, after = 0) {
    return this.db.prepare('SELECT sequence, document FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 100')
      .all(taskId, after).map((row) => ({ ...JSON.parse(row.document), sequence: row.sequence }));
  }

  close() {
    this.db.close();
  }
}

module.exports = Store;
