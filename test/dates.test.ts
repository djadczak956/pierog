import assert from "node:assert/strict";
import { test } from "node:test";
import { mondayOf, nextDueDate } from "../src/dates.ts";

const week = (weekdays?: number[], interval = 1) => ({ freq: "week" as const, interval, weekdays });

test("nextDueDate: weekly and weekday rules", () => {
  // 2026-10-03 is a Saturday.
  assert.equal(nextDueDate(week(), "2026-10-02", "2026-10-03"), "2026-10-09");
  assert.equal(nextDueDate(week(), "2026-10-09", "2026-10-03"), "2026-10-16", "finished early");
  assert.equal(nextDueDate(week(), "2026-09-11", "2026-10-03"), "2026-10-09", "overdue skips to the next upcoming date");
  assert.equal(nextDueDate(week([1, 3, 5]), "2026-10-07", "2026-10-07"), "2026-10-09", "Wed -> Fri");
  assert.equal(nextDueDate(week([1, 3, 5]), "2026-10-09", "2026-10-09"), "2026-10-12", "Fri -> Mon");
  assert.equal(nextDueDate(week([2], 2), "2026-10-06", "2026-10-06"), "2026-10-20");
  assert.equal(nextDueDate(week([1, 4], 2), "2026-10-05", "2026-10-05"), "2026-10-08", "same week first");
  assert.equal(nextDueDate(week([1, 4], 2), "2026-10-08", "2026-10-08"), "2026-10-19", "then skips a week");
  assert.equal(nextDueDate(week(undefined, 2), "2026-10-02", "2026-10-03"), "2026-10-16");
  assert.equal(nextDueDate(week(), "2026-10-30", "2026-10-30"), "2026-11-06", "across a DST change");
});

test("nextDueDate: daily and monthly rules", () => {
  assert.equal(nextDueDate({ freq: "day", interval: 1 }, "2026-10-03", "2026-10-03"), "2026-10-04");
  assert.equal(nextDueDate({ freq: "day", interval: 1 }, "2026-09-01", "2026-10-03"), "2026-10-03");
  assert.equal(nextDueDate({ freq: "month", interval: 1 }, "2027-01-31", "2027-01-31"), "2027-02-28", "clamps to month end");
  assert.equal(nextDueDate({ freq: "month", interval: 1 }, "2027-01-31", "2027-03-01"), "2027-03-31", "no drift to the 28th");
  assert.equal(nextDueDate({ freq: "month", interval: 1 }, "2026-12-15", "2026-12-15"), "2027-01-15");
  assert.equal(nextDueDate({ freq: "month", interval: 1 }, "2028-01-29", "2028-01-29"), "2028-02-29", "leap year");
});

test("mondayOf", () => {
  assert.equal(mondayOf("2026-10-03"), "2026-09-28");
  assert.equal(mondayOf("2026-09-28"), "2026-09-28");
  assert.equal(mondayOf("2026-10-04"), "2026-09-28", "Sunday belongs to the week before");
});
