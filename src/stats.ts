import { addDays, daysBetween, localDate, mondayOf } from "./dates.ts";
import { isDoneColumn } from "./db.ts";

const WEEKS = 12;

type Row = { due_date: string | null; done_at: string | null; column_name: string; course: string | null };
type Count = Record<string, number>;

export async function getStats(db: D1Database) {
  // A task's course is its first label (alphabetically), matching how cards list labels.
  const { results } = await db
    .prepare(
      `SELECT t.due_date, t.done_at, c.name AS column_name,
         (SELECT l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id
          WHERE tl.task_id = t.id ORDER BY l.name COLLATE NOCASE LIMIT 1) AS course
       FROM tasks t JOIN columns c ON c.id = t.column_id`,
    )
    .all<Row>();

  const today = localDate();
  const start = addDays(mondayOf(today), -7 * (WEEKS - 1));
  const course = (r: Row) => r.course ?? "No label";
  const bump = (o: Count, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);

  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(start, 7 * i), total: 0, byCourse: {} as Count }));
  const onTime = { onTime: 0, total: 0, byCourse: {} as Record<string, { onTime: number; total: number }> };
  const finishDays = new Set<string>();
  const finishedPerCourse: Count = {};

  for (const r of results) {
    if (!r.done_at || !isDoneColumn(r.column_name)) continue;
    const day = localDate(new Date(r.done_at));
    finishDays.add(day);
    if (day < start) continue;
    const week = weeks[Math.floor(daysBetween(start, day) / 7)];
    if (!week) continue; // finished "in the future" if a clock was off
    week.total++;
    bump(week.byCourse, course(r));
    bump(finishedPerCourse, course(r));
    if (r.due_date) {
      const c = (onTime.byCourse[course(r)] ??= { onTime: 0, total: 0 });
      const ok = Number(day <= r.due_date);
      onTime.total++;
      onTime.onTime += ok;
      c.total++;
      c.onTime += ok;
    }
  }

  // The current streak survives until the end of today, so it counts back from yesterday if nothing is done yet today.
  let current = 0;
  for (let d = finishDays.has(today) ? today : addDays(today, -1); finishDays.has(d); d = addDays(d, -1)) current++;
  let longest = 0;
  let run = 0;
  let prev = "";
  for (const d of [...finishDays].sort()) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  const soon = addDays(today, 7);
  const open = { total: 0, overdue: 0, dueSoon: 0, byCourse: {} as Record<string, { open: number; overdue: number; dueSoon: number }> };
  for (const r of results) {
    if (isDoneColumn(r.column_name)) continue;
    const c = (open.byCourse[course(r)] ??= { open: 0, overdue: 0, dueSoon: 0 });
    const overdue = Number(!!r.due_date && r.due_date < today);
    const dueSoon = Number(!!r.due_date && r.due_date >= today && r.due_date <= soon);
    open.total++;
    open.overdue += overdue;
    open.dueSoon += dueSoon;
    c.open++;
    c.overdue += overdue;
    c.dueSoon += dueSoon;
  }

  return {
    today,
    weeks,
    // Courses ordered by finished count, then open count, so chart stacks and legends are stable and meaningful.
    courses: [...new Set([...Object.keys(finishedPerCourse), ...Object.keys(open.byCourse)])].sort(
      (a, b) => (finishedPerCourse[b] ?? 0) - (finishedPerCourse[a] ?? 0) || (open.byCourse[b]?.open ?? 0) - (open.byCourse[a]?.open ?? 0) || a.localeCompare(b),
    ),
    onTime: { ...onTime, rate: onTime.total ? onTime.onTime / onTime.total : null },
    streak: { current, longest },
    open,
  };
}
