import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  migrate(db);
  return db;
}

/** Additive migrations for databases created by older versions (CREATE TABLE IF NOT EXISTS won't add columns). */
function migrate(db: DB): void {
  const addColumn = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  addColumn("judgments", "escalated_from", "TEXT");
  addColumn("judgments", "rationales", "TEXT");
  addColumn("evaluators", "kind", "TEXT NOT NULL DEFAULT 'jev'");
  addColumn("traces", "source", "TEXT NOT NULL DEFAULT 'local'");
  addColumn("traces", "external_url", "TEXT");
  addColumn("scores", "synced_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_scores_unsynced ON scores(source, synced_at) WHERE synced_at IS NULL");
}

export const nowIso = (): string => new Date().toISOString();
export const j = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
export function pj<T = unknown>(s: unknown): T | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== "string") return s as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return s as unknown as T;
  }
}
