// SQLite database management — connection setup + lightweight additive migrations.
// Extracted from src/backend/server.js so it can be tested in isolation.

const Database = require('better-sqlite3');
const fs = require('fs');

/**
 * Open a better-sqlite3 connection at dbPath. Creates the file if missing.
 * Applies the four standard pragmas (WAL, foreign_keys ON, busy_timeout, synchronous NORMAL).
 *
 * @param {string} dbPath  Absolute path to .db file
 * @returns {{ db: Database, isFresh: boolean }} Connection + flag for whether the file was newly created
 * @throws Error if the path cannot be opened (read-only filesystem, permission, etc.)
 */
function openDatabase(dbPath) {
  const isFresh = !fs.existsSync(dbPath);

  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    throw new Error(`Cannot open DB at ${dbPath}: ${e.message}`);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return { db, isFresh };
}

/**
 * Load + execute a schema.sql file. Idempotent (uses CREATE TABLE IF NOT EXISTS).
 *
 * @param {Database} db
 * @param {string} schemaPath  Absolute path to schema.sql
 */
function loadSchema(db, schemaPath) {
  if (!fs.existsSync(schemaPath)) return;
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
}

/**
 * Apply a list of additive column migrations. Each migration is checked
 * against PRAGMA table_info — if the column already exists, it's a no-op.
 * If an individual migration fails (bad definition, table missing, etc.),
 * logs the error and continues with the rest.
 *
 * @param {Database} db
 * @param {Array<{table: string, column: string, definition: string}>} migrations
 */
function applyMigrations(db, migrations) {
  for (const m of migrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
      if (cols.find(c => c.name === m.column)) continue;
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
      console.log(`[migration] added ${m.table}.${m.column}`);
    } catch (e) {
      console.error(`[migration] ${m.table}.${m.column} failed:`, e.message);
    }
  }
}

module.exports = { openDatabase, loadSchema, applyMigrations };
