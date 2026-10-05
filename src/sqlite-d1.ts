import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// The slice of Cloudflare's D1 API the data layer was written against, backed by Node's built-in SQLite,
// so db.ts / stats.ts / canvas.ts run unchanged.

type Row = Record<string, unknown>;

export class Statement {
  #db: DatabaseSync;
  #sql: string;
  #params: SQLInputValue[];

  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...params: unknown[]) {
    return new Statement(this.#db, this.#sql, params as SQLInputValue[]);
  }

  async all<T = Row>() {
    return this.allSync<T>();
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.#db.prepare(this.#sql).get(...this.#params) as T | undefined) ?? null;
  }

  async run() {
    return this.runSync();
  }

  allSync<T = Row>() {
    return { results: this.#db.prepare(this.#sql).all(...this.#params) as T[] };
  }

  runSync() {
    return { meta: { changes: Number(this.#db.prepare(this.#sql).run(...this.#params).changes) } };
  }

  returnsRows() {
    return this.#db.prepare(this.#sql).columns().length > 0;
  }
}

export class SqliteD1 {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  prepare(sql: string) {
    return new Statement(this.#db, sql);
  }

  exec(sql: string) {
    this.#db.exec(sql);
  }

  // D1 runs a batch as one transaction; so does this.
  async batch<T = Row>(statements: Statement[]): Promise<{ results: T[] }[]> {
    this.#db.exec("BEGIN");
    try {
      const out = statements.map((s) => (s.returnsRows() ? s.allSync<T>() : { results: [] as T[], ...s.runSync() }));
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
}
