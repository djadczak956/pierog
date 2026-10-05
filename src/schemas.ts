import { z } from "zod";

const name = z.string().trim().min(1);
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .nullable()
  .describe("Due date as YYYY-MM-DD, or null to clear");
const labels = z.array(z.string()).describe("Label names; replaces the task's labels. Unknown labels are created.");
export const COLORS = ["wine", "rust", "ochre", "olive", "spruce", "ink", "plum"] as const;
const color = z.enum(COLORS).nullable().describe("Card color, or null for none");
export const Repeat = z
  .object({
    freq: z.enum(["day", "week", "month"]),
    interval: z.number().int().min(1).max(12).default(1).describe("Every N days/weeks/months"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).optional().describe("For weekly: days of week, 0 = Sunday"),
  })
  .describe("Recurrence: when the task is moved to Done, a copy is created with the next due date");
const repeat = Repeat.nullable();
const index = z.number().int().min(0).describe("0-based position; omit to place at the end");

export const NewBoard = z.object({
  name,
  columns: z.array(name).min(1).optional().describe("Column names; defaults to To do / Do today / Doing / Done"),
});
export const Named = z.object({ name });
export const ColumnPatch = z.object({ name: name.optional(), index: index.optional() });

export const NewTask = z.object({
  title: name,
  notes: z.string().optional(),
  due_date: dueDate.optional(),
  color: color.optional(),
  repeat: repeat.optional(),
  labels: labels.optional(),
  subtasks: z.array(name).optional().describe("Subtask titles"),
});
export const TaskPatch = z.object({
  title: name.optional(),
  notes: z.string().optional(),
  due_date: dueDate.optional(),
  color: color.optional(),
  repeat: repeat.optional(),
  labels: labels.optional(),
});
export const Move = z.object({ column_id: z.string(), index: index.optional() });

export const NewSubtask = z.object({ title: name });
export const SubtaskPatch = z.object({ title: name.optional(), done: z.boolean().optional() });

export const Search = z.object({
  query: z.string().optional().describe("Substring matched against title and notes"),
  due_before: z.string().optional().describe("Only tasks due on or before this YYYY-MM-DD date"),
  board_id: z.string().optional(),
});

export type Color = (typeof COLORS)[number];
export type Repeat = z.infer<typeof Repeat>;
export type NewTask = z.infer<typeof NewTask>;
export type TaskPatch = z.infer<typeof TaskPatch>;
export type ColumnPatch = z.infer<typeof ColumnPatch>;
export type SubtaskPatch = z.infer<typeof SubtaskPatch>;
export type Search = z.infer<typeof Search>;
