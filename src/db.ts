import { localDate, nextDueDate } from "./dates.ts";
import type { Color, ColumnPatch, NewTask, Repeat, Search, SubtaskPatch, TaskPatch } from "./schemas.ts";

export class NotFoundError extends Error {}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}
export interface Task {
  id: string;
  column_id: string;
  title: string;
  notes: string;
  due_date: string | null;
  color: Color | null;
  repeat: Repeat | null;
  labels: string[];
  subtasks: Subtask[];
  created_at: string;
  updated_at: string;
}
export interface Board {
  id: string;
  name: string;
  columns: { id: string; name: string; tasks: Task[] }[];
  labels: string[];
}

type TaskRow = Omit<Task, "labels" | "subtasks" | "repeat"> & { repeat: string | null };

const DEFAULT_COLUMNS = ["To do", "Do today", "Doing", "Done"];
export const isDoneColumn = (name: string) => /^done$/i.test(name.trim());
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

function found<T>(row: T | null, what: string): T {
  if (row === null) throw new NotFoundError(`${what} not found`);
  return row;
}

type Ordered = "boards" | "columns" | "tasks" | "subtasks";
const PARENT: Record<Ordered, string | null> = {
  boards: null,
  columns: "board_id",
  tasks: "column_id",
  subtasks: "task_id",
};

// Positions are floats so a move writes one row: the new position is the midpoint of its neighbours.
async function positionAt(db: D1Database, table: Ordered, parentId: string | null, index?: number, excludeId = "") {
  const parent = PARENT[table];
  const { results } = await db
    .prepare(`SELECT position FROM ${table} WHERE id != ?${parent ? ` AND ${parent} = ?` : ""} ORDER BY position`)
    .bind(...(parent ? [excludeId, parentId] : [excludeId]))
    .all<{ position: number }>();
  const pos = results.map((r) => r.position);
  const i = index === undefined ? pos.length : Math.min(index, pos.length);
  const [before, after] = [pos[i - 1], pos[i]];
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

async function hydrate(db: D1Database, rows: TaskRow[]): Promise<Task[]> {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const [subs, labels] = await db.batch<Record<string, string | number>>([
    db
      .prepare("SELECT id, task_id, title, done FROM subtasks WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY position")
      .bind(ids),
    db
      .prepare(
        `SELECT tl.task_id, l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE tl.task_id IN (SELECT value FROM json_each(?)) ORDER BY l.name COLLATE NOCASE`,
      )
      .bind(ids),
  ]);
  return rows.map(({ id, column_id, title, notes, due_date, color, repeat, created_at, updated_at }) => ({
    id,
    column_id,
    title,
    notes,
    due_date,
    color,
    repeat: repeat ? JSON.parse(repeat) : null,
    labels: labels.results.filter((l) => l.task_id === id).map((l) => String(l.name)),
    subtasks: subs.results
      .filter((s) => s.task_id === id)
      .map((s) => ({ id: String(s.id), title: String(s.title), done: s.done === 1 })),
    created_at,
    updated_at,
  }));
}

const TASK_COLUMNS = "t.id, t.column_id, t.title, t.notes, t.due_date, t.color, t.repeat, t.created_at, t.updated_at";

// Boards

export async function listBoards(db: D1Database) {
  const { results } = await db.prepare("SELECT id, name FROM boards ORDER BY position").all<{ id: string; name: string }>();
  return results;
}

export async function getBoard(db: D1Database, boardId: string): Promise<Board> {
  const board = found(await db.prepare("SELECT id, name FROM boards WHERE id = ?").bind(boardId).first<{ id: string; name: string }>(), "board");
  const [cols, tasks, labels] = await db.batch<Record<string, string>>(
    [
      "SELECT id, name FROM columns WHERE board_id = ? ORDER BY position",
      `SELECT ${TASK_COLUMNS} FROM tasks t JOIN columns c ON c.id = t.column_id WHERE c.board_id = ? ORDER BY t.position`,
      "SELECT name FROM labels WHERE board_id = ? ORDER BY name COLLATE NOCASE",
    ].map((sql) => db.prepare(sql).bind(boardId)),
  );
  const hydrated = await hydrate(db, tasks.results as unknown as TaskRow[]);
  return {
    ...board,
    columns: cols.results.map((c) => ({ id: c.id, name: c.name, tasks: hydrated.filter((t) => t.column_id === c.id) })),
    labels: labels.results.map((l) => l.name),
  };
}

export async function createBoard(db: D1Database, name: string, columns = DEFAULT_COLUMNS) {
  const id = newId();
  const position = await positionAt(db, "boards", null);
  await db.batch([
    db.prepare("INSERT INTO boards (id, name, position, created_at) VALUES (?, ?, ?, ?)").bind(id, name, position, now()),
    ...columns.map((col, i) =>
      db.prepare("INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)").bind(newId(), id, col, i + 1),
    ),
  ]);
  return getBoard(db, id);
}

export async function renameBoard(db: D1Database, id: string, name: string) {
  const r = await db.prepare("UPDATE boards SET name = ? WHERE id = ?").bind(name, id).run();
  if (!r.meta.changes) throw new NotFoundError("board not found");
  return getBoard(db, id);
}

export async function deleteBoard(db: D1Database, id: string) {
  const r = await db.prepare("DELETE FROM boards WHERE id = ?").bind(id).run();
  if (!r.meta.changes) throw new NotFoundError("board not found");
  return { deleted: id };
}

// Accept either an id or a case-insensitive name, since that's how people (and Claude) refer to things.
export async function resolveBoard(db: D1Database, ref: string) {
  const row = await db
    .prepare("SELECT id FROM boards WHERE id = ?1 OR name = ?1 COLLATE NOCASE ORDER BY id = ?1 DESC LIMIT 1")
    .bind(ref)
    .first<{ id: string }>();
  return found(row, `board "${ref}"`).id;
}

// Columns

export async function addColumn(db: D1Database, boardId: string, name: string, index?: number) {
  found(await db.prepare("SELECT id FROM boards WHERE id = ?").bind(boardId).first(), "board");
  const position = await positionAt(db, "columns", boardId, index);
  await db.prepare("INSERT INTO columns (id, board_id, name, position) VALUES (?, ?, ?, ?)").bind(newId(), boardId, name, position).run();
  return getBoard(db, boardId);
}

export async function updateColumn(db: D1Database, id: string, patch: ColumnPatch) {
  const col = found(await db.prepare("SELECT board_id FROM columns WHERE id = ?").bind(id).first<{ board_id: string }>(), "column");
  if (patch.name !== undefined) await db.prepare("UPDATE columns SET name = ? WHERE id = ?").bind(patch.name, id).run();
  if (patch.index !== undefined) {
    const position = await positionAt(db, "columns", col.board_id, patch.index, id);
    await db.prepare("UPDATE columns SET position = ? WHERE id = ?").bind(position, id).run();
  }
  return getBoard(db, col.board_id);
}

export async function deleteColumn(db: D1Database, id: string) {
  const col = found(await db.prepare("SELECT board_id FROM columns WHERE id = ?").bind(id).first<{ board_id: string }>(), "column");
  await db.prepare("DELETE FROM columns WHERE id = ?").bind(id).run();
  return getBoard(db, col.board_id);
}

export async function resolveColumn(db: D1Database, boardId: string, ref?: string) {
  const row = ref
    ? await db
        .prepare("SELECT id FROM columns WHERE board_id = ?1 AND (id = ?2 OR name = ?2 COLLATE NOCASE) ORDER BY id = ?2 DESC LIMIT 1")
        .bind(boardId, ref)
        .first<{ id: string }>()
    : await db.prepare("SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1").bind(boardId).first<{ id: string }>();
  return found(row, `column "${ref ?? "(first)"}"`).id;
}

// Tasks

export async function getTask(db: D1Database, id: string) {
  const row = found(await db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ?`).bind(id).first<TaskRow>(), "task");
  return (await hydrate(db, [row]))[0];
}

export async function taskBoardId(db: D1Database, taskId: string) {
  const row = await db
    .prepare("SELECT c.board_id FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?")
    .bind(taskId)
    .first<{ board_id: string }>();
  return found(row, "task").board_id;
}

export async function createTask(db: D1Database, columnId: string, task: NewTask) {
  const col = found(await db.prepare("SELECT name FROM columns WHERE id = ?").bind(columnId).first<{ name: string }>(), "column");
  const id = newId();
  const ts = now();
  const position = await positionAt(db, "tasks", columnId);
  await db.batch([
    db
      .prepare("INSERT INTO tasks (id, column_id, title, notes, due_date, color, repeat, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, columnId, task.title, task.notes ?? "", task.due_date ?? null, task.color ?? null, task.repeat ? JSON.stringify(task.repeat) : null, position, ts, ts, isDoneColumn(col.name) ? ts : null),
    ...(task.subtasks ?? []).map((title, i) =>
      db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)").bind(newId(), id, title, i + 1),
    ),
  ]);
  if (task.labels?.length) await setTaskLabels(db, id, task.labels);
  return getTask(db, id);
}

export async function updateTask(db: D1Database, id: string, patch: TaskPatch) {
  const fields = (["title", "notes", "due_date", "color", "repeat"] as const).filter((k) => patch[k] !== undefined);
  const value = (k: (typeof fields)[number]) => (k === "repeat" ? (patch.repeat ? JSON.stringify(patch.repeat) : null) : (patch[k] ?? null));
  const r = await db
    .prepare(`UPDATE tasks SET ${fields.map((k) => `${k} = ?, `).join("")}updated_at = ? WHERE id = ?`)
    .bind(...fields.map(value), now(), id)
    .run();
  if (!r.meta.changes) throw new NotFoundError("task not found");
  if (patch.labels) await setTaskLabels(db, id, patch.labels);
  return getTask(db, id);
}

export async function moveTask(db: D1Database, id: string, columnId: string, index?: number) {
  const target = found(
    await db.prepare("SELECT board_id, name FROM columns WHERE id = ?").bind(columnId).first<{ board_id: string; name: string }>(),
    "column",
  );
  const position = await positionAt(db, "tasks", columnId, index, id);
  const done = isDoneColumn(target.name);
  const ts = now();
  // Reordering within Done keeps the original finish time; leaving Done clears it.
  const r = await db
    .prepare("UPDATE tasks SET column_id = ?, position = ?, updated_at = ?, done_at = CASE WHEN ? THEN coalesce(done_at, ?) ELSE NULL END WHERE id = ?")
    .bind(columnId, position, ts, Number(done), ts, id)
    .run();
  if (!r.meta.changes) throw new NotFoundError("task not found");
  const next = done ? await spawnNext(db, id, target.board_id) : null;
  return { ...(await getTask(db, id)), next };
}

// Finishing a recurring task creates its next occurrence, once. Claiming spawned_id first makes a
// double move (two tabs, or Claude and the UI at once) produce a single copy.
async function spawnNext(db: D1Database, id: string, boardId: string) {
  const claim = await db.prepare("UPDATE tasks SET spawned_id = '' WHERE id = ? AND repeat IS NOT NULL AND spawned_id IS NULL").bind(id).run();
  if (!claim.meta.changes) return null;
  const task = await getTask(db, id);
  const today = localDate();
  const next = await createTask(db, await resolveColumn(db, boardId), {
    title: task.title,
    notes: task.notes,
    due_date: nextDueDate(task.repeat!, task.due_date ?? today, today),
    color: task.color,
    repeat: task.repeat,
    labels: task.labels,
    subtasks: task.subtasks.map((s) => s.title),
  });
  await db.prepare("UPDATE tasks SET spawned_id = ? WHERE id = ?").bind(next.id, id).run();
  return next;
}

export async function deleteTask(db: D1Database, id: string) {
  const r = await db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  if (!r.meta.changes) throw new NotFoundError("task not found");
  return { deleted: id };
}

async function setTaskLabels(db: D1Database, taskId: string, names: string[]) {
  const boardId = await taskBoardId(db, taskId);
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  await db.batch([
    ...clean.map((n) =>
      db.prepare("INSERT INTO labels (id, board_id, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(newId(), boardId, n),
    ),
    db.prepare("DELETE FROM task_labels WHERE task_id = ?").bind(taskId),
    db
      .prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT ?1, id FROM labels WHERE board_id = ?2 AND name COLLATE NOCASE IN (SELECT value FROM json_each(?3))`,
      )
      .bind(taskId, boardId, JSON.stringify(clean)),
  ]);
}

export async function searchTasks(db: D1Database, { query, due_before, board_id }: Search) {
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS}, c.name AS column_name, b.id AS board_id, b.name AS board_name
       FROM tasks t JOIN columns c ON c.id = t.column_id JOIN boards b ON b.id = c.board_id
       WHERE (?1 IS NULL OR t.title LIKE ?1 OR t.notes LIKE ?1)
         AND (?2 IS NULL OR t.due_date <= ?2)
         AND (?3 IS NULL OR b.id = ?3)
       ORDER BY t.due_date IS NULL, t.due_date, b.position, c.position, t.position
       LIMIT 200`,
    )
    .bind(query ? `%${query}%` : null, due_before ?? null, board_id ?? null)
    .all<TaskRow & { column_name: string; board_id: string; board_name: string }>();
  const tasks = await hydrate(db, results);
  return tasks.map((t, i) => ({ ...t, column: results[i].column_name, board_id: results[i].board_id, board: results[i].board_name }));
}

// Subtasks (each returns the parent task, which is what callers re-render)

export async function addSubtask(db: D1Database, taskId: string, title: string) {
  found(await db.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId).first(), "task");
  const position = await positionAt(db, "subtasks", taskId);
  await db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)").bind(newId(), taskId, title, position).run();
  return getTask(db, taskId);
}

export async function updateSubtask(db: D1Database, id: string, patch: SubtaskPatch) {
  const sub = found(await db.prepare("SELECT task_id FROM subtasks WHERE id = ?").bind(id).first<{ task_id: string }>(), "subtask");
  await db
    .prepare("UPDATE subtasks SET title = coalesce(?, title), done = coalesce(?, done) WHERE id = ?")
    .bind(patch.title ?? null, patch.done === undefined ? null : Number(patch.done), id)
    .run();
  return getTask(db, sub.task_id);
}

export async function deleteSubtask(db: D1Database, id: string) {
  const sub = found(await db.prepare("SELECT task_id FROM subtasks WHERE id = ?").bind(id).first<{ task_id: string }>(), "subtask");
  await db.prepare("DELETE FROM subtasks WHERE id = ?").bind(id).run();
  return getTask(db, sub.task_id);
}
