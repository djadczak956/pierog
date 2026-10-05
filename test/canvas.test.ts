import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.TZ = "America/New_York"; // deadlines are converted from UTC to a local date
const { parseIcs, toAssignment } = await import("../src/canvas.ts");

const events = parseIcs(readFileSync(new URL("fixtures/canvas.ics", import.meta.url), "utf8"));

test("parseIcs reads every event, unfolding long lines", () => {
  assert.equal(events.length, 4);
  assert.match(events[1].SUMMARY, /^Project proposal with a very long title that Canvas folds onto a second line/);
});

test("toAssignment keeps assignments only, with course code and local due date", () => {
  const assignments = events.map(toAssignment).filter((a) => a !== null);
  assert.equal(assignments.length, 3, "the lecture (calendar event) is dropped");
  assert.deepEqual(assignments[0], {
    uid: "event-assignment-1001",
    title: "HW 4: Backprop, by hand",
    course: "DS 541",
    due_date: "2026-10-09", // 03:59 UTC on the 10th is 11:59 pm Eastern on the 9th
    url: "https://canvas.example.edu/courses/1/assignments/1001",
  });
  assert.equal(assignments[1].due_date, "2026-10-15", "date-only DTSTART");
  assert.equal(assignments[1].course, "CS 4342");
});
