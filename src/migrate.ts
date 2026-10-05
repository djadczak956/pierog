import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "./sqlite-d1.ts";

const DIR = join(import.meta.dirname, "..", "migrations");

// Applies migrations/*.sql in name order, each once, each in its own transaction.
export function migrate(db: SqliteD1) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM _migrations").allSync<{ name: string }>().results.map((r) => r.name));
  for (const name of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(DIR, name), "utf8"));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").bind(name, new Date().toISOString()).runSync();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
  }
}
