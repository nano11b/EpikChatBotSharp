"use strict";

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial-state-storage",
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE INDEX IF NOT EXISTS records_namespace_updated ON records(namespace, updated_at);
    `,
  }),
]);

function applyMigrations(db, logger = console) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version),
  );
  const insert = db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, Date.now());
      db.exec("COMMIT");
      logger.log("[database] Applied migration", { version: migration.version, name: migration.name });
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed: ${error.message}`, {
        cause: error,
      });
    }
  }

  return MIGRATIONS.at(-1)?.version || 0;
}

module.exports = { MIGRATIONS, applyMigrations };
