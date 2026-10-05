import { localDate } from "./dates.ts";
import { NotFoundError, createBoard, createTask, resolveBoard, resolveColumn, updateTask } from "./db.ts";

export function parseIcs(text: string) {
  // RFC 5545 folds long lines by starting the continuation with a space or tab.
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      const colon = line.indexOf(":");
      if (colon > 0) current[line.slice(0, colon).split(";")[0]] = line.slice(colon + 1);
    }
  }
  return events;
}

const unescape = (v: string) => v.replace(/\\([,;\\nN])/g, (_, c: string) => (c.toLowerCase() === "n" ? "\n" : c));

function dueDate(value: string) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, utc] = m;
  // Canvas sends deadlines in UTC; 11:59 pm Eastern is already the next day in UTC.
  return utc ? localDate(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))) : `${y}-${mo}-${d}`;
}

export function toAssignment(event: Record<string, string>) {
  const uid = event.UID;
  // Canvas also exports class meetings and other calendar events; only assignments become tasks.
  if (!uid?.startsWith("event-assignment-") || !event.SUMMARY || !event.DTSTART) return null;
  const due_date = dueDate(event.DTSTART);
  if (!due_date) return null;
  const summary = unescape(event.SUMMARY);
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]$/);
  // "CS541-F26-F01" -> "CS541": the section suffix only adds noise to the label.
  const course = m ? (m[2].match(/^[A-Z]{2,4} ?\d{3,4}[A-Z]?/)?.[0] ?? m[2]) : null;
  return { uid, title: m ? m[1] : summary, course, due_date, url: event.URL ? unescape(event.URL) : "" };
}

async function boardColumn(db: D1Database, board: string) {
  let boardId: string;
  try {
    boardId = await resolveBoard(db, board);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    boardId = (await createBoard(db, board)).id;
  }
  return resolveColumn(db, boardId);
}

type SyncResult = { created: number; updated: number; skipped: number };
let inFlight: Promise<SyncResult> | null = null;

// Overlapping syncs (startup, timer, button, CLI) could each import the same new assignment,
// so a sync that starts while another runs gets that one's result instead.
export function syncCanvas(db: D1Database, feedUrl: string | null, board: string) {
  inFlight ??= runSync(db, feedUrl, board).finally(() => (inFlight = null));
  return inFlight;
}

async function runSync(db: D1Database, feedUrl: string | null, board: string): Promise<SyncResult> {
  if (!feedUrl) throw new Error("No Canvas feed set; run `pierog set-canvas`");
  // Canvas answers 403 to requests without a User-Agent.
  const res = await fetch(feedUrl, { headers: { "User-Agent": "kanban-canvas-sync" } });
  if (!res.ok) throw new Error(`Canvas feed returned HTTP ${res.status}`);
  const today = localDate();
  const assignments = parseIcs(await res.text()).flatMap((e) => {
    const a = toAssignment(e);
    return a && a.due_date >= today ? [a] : [];
  });

  const { results } = await db.prepare("SELECT uid, task_id, due_date FROM canvas_items").all<{ uid: string; task_id: string | null; due_date: string }>();
  const known = new Map(results.map((r) => [r.uid, r]));
  const counts = { created: 0, updated: 0, skipped: 0 };
  let columnId: string | undefined;

  for (const a of assignments) {
    const seen = known.get(a.uid);
    if (!seen) {
      columnId ??= await boardColumn(db, board);
      const task = await createTask(db, columnId, { title: a.title, notes: a.url, due_date: a.due_date, labels: a.course ? [a.course] : [] });
      await db.prepare("INSERT INTO canvas_items (uid, task_id, due_date) VALUES (?, ?, ?)").bind(a.uid, task.id, a.due_date).run();
      counts.created++;
    } else if (seen.task_id && seen.due_date !== a.due_date) {
      await updateTask(db, seen.task_id, { due_date: a.due_date });
      await db.prepare("UPDATE canvas_items SET due_date = ? WHERE uid = ?").bind(a.due_date, a.uid).run();
      counts.updated++;
    } else counts.skipped++;
  }
  return counts;
}
