import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { syncCanvas } from "./canvas.ts";
import * as db from "./db.ts";
import { getStats } from "./stats.ts";
import * as s from "./schemas.ts";

const ref = (what: string) => z.string().describe(`${what} id or name (case-insensitive)`);

export function createServer(env: Env) {
  const { DB } = env;
  const server = new McpServer({ name: "pierog", version: "1.0.0" });

  function tool<S extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<S>) => Promise<unknown>,
    destructive = false,
  ) {
    server.registerTool(name, { description, inputSchema: inputSchema as unknown as StandardSchemaWithJSON, annotations: { destructiveHint: destructive } }, async (args) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await run(args as z.infer<S>)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
      }
    });
  }

  tool("list_boards", "List all kanban boards.", z.object({}), () => db.listBoards(DB));

  tool("get_board", "Get a board with its columns, tasks (labels, subtasks, due dates) and labels.", z.object({ board: ref("Board") }), async ({ board }) =>
    db.getBoard(DB, await db.resolveBoard(DB, board)),
  );

  tool("create_board", "Create a board.", s.NewBoard, ({ name, columns }) => db.createBoard(DB, name, columns));

  tool("add_column", "Add a column to a board.", z.object({ board: ref("Board"), name: z.string().min(1), index: s.Move.shape.index }), async ({ board, name, index }) =>
    db.addColumn(DB, await db.resolveBoard(DB, board), name, index),
  );

  tool(
    "search_tasks",
    "Find tasks across boards by text and/or due date, soonest due first. Each result includes its board and column.",
    s.Search.omit({ board_id: true }).extend({ board: ref("Board").optional() }),
    async ({ board, ...filters }) => db.searchTasks(DB, { ...filters, board_id: board && (await db.resolveBoard(DB, board)) }),
  );

  tool(
    "create_task",
    "Create a task at the bottom of a column.",
    s.NewTask.extend({ board: ref("Board"), column: ref("Column").optional().describe("Column id or name; defaults to the first column") }),
    async ({ board, column, ...task }) => {
      const boardId = await db.resolveBoard(DB, board);
      return db.createTask(DB, await db.resolveColumn(DB, boardId, column), task);
    },
  );

  tool("update_task", "Edit a task's title, notes, due date or labels. Omitted fields are unchanged.", s.TaskPatch.extend({ task_id: z.string() }), ({ task_id, ...patch }) =>
    db.updateTask(DB, task_id, patch),
  );

  tool(
    "move_task",
    "Move a task to a column on its board, optionally at a position.",
    z.object({ task_id: z.string(), column: ref("Column"), index: s.Move.shape.index }),
    async ({ task_id, column, index }) => {
      const columnId = await db.resolveColumn(DB, await db.taskBoardId(DB, task_id), column);
      return db.moveTask(DB, task_id, columnId, index);
    },
  );

  tool("delete_task", "Permanently delete a task and its subtasks.", z.object({ task_id: z.string() }), ({ task_id }) => db.deleteTask(DB, task_id), true);

  tool("add_subtasks", "Append subtasks to a task.", z.object({ task_id: z.string(), titles: z.array(z.string().min(1)).min(1) }), async ({ task_id, titles }) => {
    let task;
    for (const title of titles) task = await db.addSubtask(DB, task_id, title);
    return task;
  });

  tool("update_subtask", "Rename a subtask or mark it done/undone.", s.SubtaskPatch.extend({ subtask_id: z.string() }), ({ subtask_id, ...patch }) =>
    db.updateSubtask(DB, subtask_id, patch),
  );

  tool("delete_subtask", "Delete a subtask.", z.object({ subtask_id: z.string() }), ({ subtask_id }) => db.deleteSubtask(DB, subtask_id), true);

  tool(
    "get_stats",
    "Progress stats: tasks finished per week for the last 12 weeks (by course label), on-time rate, completion streaks, and open workload (open/overdue/due within 7 days per course).",
    z.object({}),
    () => getStats(DB),
  );

  tool("sync_canvas", "Import upcoming Canvas assignments into the Canvas board now (also runs every 6 hours while the app is running).", z.object({}), () =>
    syncCanvas(DB, env.CANVAS_ICS_URL, env.CANVAS_BOARD),
  );

  return server;
}
