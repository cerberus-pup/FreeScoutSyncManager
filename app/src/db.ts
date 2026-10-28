import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DATA_DIR, DB_FILE } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE instances (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
     ssh_user TEXT NOT NULL DEFAULT 'fsagent', notes TEXT NOT NULL DEFAULT '',
     last_info TEXT, last_stats TEXT, last_seen_at TEXT, last_error TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('backup','sync','migrate')),
     source_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
     target_id INTEGER REFERENCES instances(id) ON DELETE CASCADE,
     schedule TEXT NOT NULL DEFAULT '{"kind":"manual"}', retention INTEGER NOT NULL DEFAULT 7,
     options TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
     type TEXT NOT NULL, source_id INTEGER REFERENCES instances(id) ON DELETE SET NULL,
     target_id INTEGER REFERENCES instances(id) ON DELETE SET NULL, snapshot_id INTEGER,
     status TEXT NOT NULL DEFAULT 'queued', trigger TEXT NOT NULL DEFAULT 'manual',
     options TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '{}',
     error TEXT, queued_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT);
   CREATE TABLE snapshots (
     id INTEGER PRIMARY KEY, instance_id INTEGER REFERENCES instances(id) ON DELETE SET NULL,
     instance_name TEXT NOT NULL, job_id INTEGER, run_id INTEGER, path TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'partial', freescout_version TEXT, app_url TEXT,
     db_bytes INTEGER, files_bytes INTEGER, stats TEXT, pinned INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE INDEX runs_status ON runs(status);
   CREATE INDEX snaps_instance ON snapshots(instance_id, created_at);`,
];

const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export type Row = Record<string, any>;
export const one = (sql: string, ...p: any[]): Row | undefined => db.prepare(sql).get(...p) as Row | undefined;
export const all = (sql: string, ...p: any[]): Row[] => db.prepare(sql).all(...p) as Row[];
export const exec = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

export function getSetting(key: string, def = ''): string {
  return (one('SELECT value FROM settings WHERE key = ?', key)?.value as string) ?? def;
}
export function setSetting(key: string, value: string) {
  exec('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
export const parse = <T = any>(s: string | null | undefined, def: T): T => {
  if (!s) return def;
  try { return JSON.parse(s) as T; } catch { return def; }
};
