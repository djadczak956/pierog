import { ZodError } from "zod";
import { syncCanvas } from "./canvas.ts";
import * as db from "./db.ts";
import { getStats } from "./stats.ts";
import * as s from "./schemas.ts";

type Handler = (env: Env, id: string, body: unknown, url: URL) => Promise<unknown>;

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/boards$/, ({ DB }) => db.listBoards(DB)],
  ["POST", /^\/api\/boards$/, ({ DB }, _, b) => { const { name, columns } = s.NewBoard.parse(b); return db.createBoard(DB, name, columns); }],
  ["GET", /^\/api\/boards\/([^/]+)$/, ({ DB }, id) => db.getBoard(DB, id)],
  ["PATCH", /^\/api\/boards\/([^/]+)$/, ({ DB }, id, b) => db.renameBoard(DB, id, s.Named.parse(b).name)],
  ["DELETE", /^\/api\/boards\/([^/]+)$/, ({ DB }, id) => db.deleteBoard(DB, id)],
  ["POST", /^\/api\/boards\/([^/]+)\/columns$/, ({ DB }, id, b) => db.addColumn(DB, id, s.Named.parse(b).name)],
  ["PATCH", /^\/api\/columns\/([^/]+)$/, ({ DB }, id, b) => db.updateColumn(DB, id, s.ColumnPatch.parse(b))],
  ["DELETE", /^\/api\/columns\/([^/]+)$/, ({ DB }, id) => db.deleteColumn(DB, id)],
  ["POST", /^\/api\/columns\/([^/]+)\/tasks$/, ({ DB }, id, b) => db.createTask(DB, id, s.NewTask.parse(b))],
  ["GET", /^\/api\/stats$/, ({ DB }) => getStats(DB)],
  ["GET", /^\/api\/tasks$/, ({ DB }, _, __, url) => db.searchTasks(DB, s.Search.parse(Object.fromEntries(url.searchParams)))],
  ["GET", /^\/api\/tasks\/([^/]+)$/, ({ DB }, id) => db.getTask(DB, id)],
  ["PATCH", /^\/api\/tasks\/([^/]+)$/, ({ DB }, id, b) => db.updateTask(DB, id, s.TaskPatch.parse(b))],
  ["POST", /^\/api\/tasks\/([^/]+)\/move$/, ({ DB }, id, b) => { const { column_id, index } = s.Move.parse(b); return db.moveTask(DB, id, column_id, index); }],
  ["DELETE", /^\/api\/tasks\/([^/]+)$/, ({ DB }, id) => db.deleteTask(DB, id)],
  ["POST", /^\/api\/tasks\/([^/]+)\/subtasks$/, ({ DB }, id, b) => db.addSubtask(DB, id, s.NewSubtask.parse(b).title)],
  ["PATCH", /^\/api\/subtasks\/([^/]+)$/, ({ DB }, id, b) => db.updateSubtask(DB, id, s.SubtaskPatch.parse(b))],
  ["DELETE", /^\/api\/subtasks\/([^/]+)$/, ({ DB }, id) => db.deleteSubtask(DB, id)],
  ["POST", /^\/api\/canvas\/sync$/, ({ DB, CANVAS_ICS_URL, CANVAS_BOARD }) => syncCanvas(DB, CANVAS_ICS_URL, CANVAS_BOARD)],
];

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match || method !== request.method) continue;
    try {
      const text = await request.text();
      const body = text ? JSON.parse(text) : undefined;
      return Response.json(await handler(env, decodeURIComponent(match[1] ?? ""), body, url));
    } catch (e) {
      if (e instanceof db.NotFoundError) return Response.json({ error: e.message }, { status: 404 });
      if (e instanceof ZodError || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: 400 });
      console.error(e);
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
