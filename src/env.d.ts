type D1Database = import("./sqlite-d1.ts").SqliteD1;

interface Env {
  DB: D1Database;
  CANVAS_ICS_URL: string | null;
  CANVAS_BOARD: string;
}
