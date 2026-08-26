const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("./database-migrations");

class StateDatabase {
  static applyPendingRestore(filePath, logger = console) {
    const resolved = path.resolve(filePath); const pending = `${resolved}.restore-pending`;
    if (!fs.existsSync(pending)) return false;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (fs.existsSync(resolved)) fs.copyFileSync(resolved, `${resolved}.pre-restore.bak`);
    fs.renameSync(pending, resolved);
    logger.warn("[database] Applied pending restore; previous database saved with .pre-restore.bak");
    return true;
  }

  constructor({ filePath, logger = console }) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.schemaVersion = applyMigrations(this.db, this.logger);
    this.readDocumentStatement = this.db.prepare("SELECT value,updated_at FROM documents WHERE key = ?");
    this.writeDocumentStatement = this.db.prepare("INSERT INTO documents(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    this.getRecordStatement = this.db.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?");
    this.setRecordStatement = this.db.prepare("INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    this.deleteRecordStatement = this.db.prepare("DELETE FROM records WHERE namespace = ? AND key = ?");
    this.listRecordStatement = this.db.prepare("SELECT key,value,updated_at FROM records WHERE namespace = ? ORDER BY updated_at ASC");
  }

  documentKey(filePath) { return path.resolve(filePath).toLowerCase(); }

  readDocument(filePath, fallback) {
    const key = this.documentKey(filePath);
    const row = this.readDocumentStatement.get(key);
    if (row) {
      const fileUpdatedAt = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
      if (fileUpdatedAt > row.updated_at + 1000) {
        try {
          const restored = JSON.parse(fs.readFileSync(filePath, "utf8"));
          this.writeDocument(filePath, restored);
          this.logger.log("[database] Imported newer restored JSON", path.basename(filePath));
          return restored;
        } catch (error) { this.logger.error("[database] Unable to import restored JSON", { filePath, error: error.message }); }
      }
      try { return JSON.parse(row.value); } catch (error) { this.logger.error("[database] Invalid stored document", { key, error: error.message }); return fallback; }
    }
    if (!fs.existsSync(filePath)) return fallback;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      this.writeDocument(filePath, value);
      this.logger.log("[database] Imported legacy JSON", path.basename(filePath));
      return value;
    } catch (error) {
      this.logger.error("[database] Unable to import legacy JSON", { filePath, error: error.message });
      return fallback;
    }
  }

  writeDocument(filePath, value) {
    this.writeDocumentStatement.run(this.documentKey(filePath), JSON.stringify(value), Date.now());
  }

  get(namespace, key, fallback = null) {
    const row = this.getRecordStatement.get(String(namespace), String(key));
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  set(namespace, key, value) {
    this.setRecordStatement.run(String(namespace), String(key), JSON.stringify(value), Date.now());
    return value;
  }

  delete(namespace, key) { return this.deleteRecordStatement.run(String(namespace), String(key)).changes > 0; }

  list(namespace) {
    return this.listRecordStatement.all(String(namespace)).flatMap((row) => {
      try { return [{ key: row.key, value: JSON.parse(row.value), updatedAt: row.updated_at }]; } catch { return []; }
    });
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  checkpoint() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  getSchemaVersion() { return this.schemaVersion; }
  close() { this.checkpoint(); this.db.close(); }
}

module.exports = { StateDatabase };
