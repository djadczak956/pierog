import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

// End to end: the real server, on a free port, with a throwaway data directory and a fake Canvas feed.

const home = mkdtempSync(join(tmpdir(), "pierog-test-"));
let server: ChildProcess;
let base = "";
let feed: Server;
let feedBody = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ok(method: string, path: string, body?: unknown) {
  const res = await api(method, path, body);
  assert.equal(res.status, 200, `${method} ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA");
};
const icsDate = (day: string) => day.replaceAll("-", "");

function canvasFeed(assignments: { uid: string; title: string; due: string }[]) {
  const events = assignments.map((a) =>
    ["BEGIN:VEVENT", `DTSTART;VALUE=DATE:${icsDate(a.due)}`, `SUMMARY:${a.title} [MATH 201-A01]`, `UID:${a.uid}`, "END:VEVENT"].join("\r\n"),
  );
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
}

before(async () => {
  // A slow feed, so concurrent syncs genuinely overlap.
  feed = createServer((_req, res) => setTimeout(() => res.end(feedBody), 150)).listen(0, "127.0.0.1");
  await new Promise((r) => feed.once("listening", r));
  const port = await freePort();
  base = `http://localhost:${port}`;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ port, canvasIcsUrl: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed.ics` }),
  );
  server = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "server.ts")], {
    env: { ...process.env, PIEROG_HOME: home },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server didn't start");
});

after(() => {
  server?.kill();
  feed?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("static files and request checks", () => {
  test("serves the app and blocks path traversal", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Pierog<\/title>/);
    assert.equal((await fetch(base + "/vendor/sortable.min.js")).status, 200);
    assert.equal((await fetch(base + "/../package.json")).status, 404);
  });

  test("rejects foreign Host and Origin, allows same origin", async () => {
    // fetch() won't send a custom Host header, so this one goes through node:http.
    const hostStatus = await new Promise<number>((resolve, reject) =>
      request(`${base}/api/boards`, { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode!); })
        .on("error", reject)
        .end(),
    );
    assert.equal(hostStatus, 403);
    assert.equal((await api("POST", "/api/boards", { name: "x" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await api("GET", "/api/boards", undefined, { Origin: base })).status, 200);
  });
});

describe("boards and tasks", () => {
  let cols: Record<string, string>;

  test("new boards get the default columns", async () => {
    const board = await ok("POST", "/api/boards", { name: "School" });
    cols = Object.fromEntries(board.columns.map((c: { name: string; id: string }) => [c.name, c.id]));
    assert.deepEqual(Object.keys(cols), ["To do", "Do today", "Doing", "Done"]);
  });

  test("create, reorder, label, subtasks, validation, delete", async () => {
    const a = await ok("POST", `/api/columns/${cols["To do"]}/tasks`, { title: "A", labels: ["x", "Y"], subtasks: ["s1", "s2"], color: "plum" });
    const b = await ok("POST", `/api/columns/${cols["To do"]}/tasks`, { title: "B" });
    const c = await ok("POST", `/api/columns/${cols["To do"]}/tasks`, { title: "C" });
    assert.deepEqual(a.labels, ["x", "Y"]);
    assert.equal(a.color, "plum");

    await ok("POST", `/api/tasks/${c.id}/move`, { column_id: cols["To do"], index: 0 });
    const board = (await ok("GET", "/api/boards"))[0];
    const todo = (await ok("GET", `/api/boards/${board.id}`)).columns[0].tasks.map((t: { title: string }) => t.title);
    assert.deepEqual(todo, ["C", "A", "B"]);

    const relabeled = await ok("PATCH", `/api/tasks/${a.id}`, { labels: ["y", "z"] });
    assert.deepEqual(relabeled.labels, ["Y", "z"], "label names match case-insensitively");
    const sub = await ok("PATCH", `/api/subtasks/${relabeled.subtasks[0].id}`, { done: true });
    assert.equal(sub.subtasks[0].done, true);

    assert.equal((await api("PATCH", `/api/tasks/${b.id}`, { due_date: "10/5" })).status, 400);
    assert.equal((await api("GET", "/api/tasks/missing")).status, 404);
    await ok("DELETE", `/api/tasks/${b.id}`);
  });

  test("moving into Done records the finish time; leaving clears it", async () => {
    const t = await ok("POST", `/api/columns/${cols["Doing"]}/tasks`, { title: "finish me" });
    const doneAt = () => {
      const db = new DatabaseSync(join(home, "pierog.db"));
      const row = db.prepare("SELECT done_at FROM tasks WHERE id = ?").get(t.id) as { done_at: string | null };
      db.close();
      return row.done_at;
    };
    await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Done"] });
    const first = doneAt();
    assert.ok(first);
    await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Done"], index: 0 });
    assert.equal(doneAt(), first, "reordering within Done keeps it");
    await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Doing"] });
    assert.equal(doneAt(), null);
  });

  test("finishing a recurring task creates the next one, once", async () => {
    const t = await ok("POST", `/api/columns/${cols["Doing"]}/tasks`, {
      title: "Weekly report",
      due_date: localDay(-1),
      subtasks: ["draft"],
      repeat: { freq: "week", interval: 1 },
    });
    await ok("PATCH", `/api/subtasks/${t.subtasks[0].id}`, { done: true });
    const moved = await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Done"] });
    assert.equal(moved.next.due_date, localDay(6));
    assert.equal(moved.next.column_id, cols["To do"]);
    assert.equal(moved.next.subtasks[0].done, false, "subtasks start unchecked");

    await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Doing"] });
    assert.equal((await ok("POST", `/api/tasks/${t.id}/move`, { column_id: cols["Done"] })).next, null);
  });

  test("stats reflect open and finished work", async () => {
    const stats = await ok("GET", "/api/stats");
    assert.ok(stats.open.total >= 2);
    assert.ok(stats.streak.current >= 1);
    assert.equal(stats.weeks.length, 12);
  });
});

describe("MCP", () => {
  const headers = { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
  const rpc = async (method: string, params?: unknown, extra: Record<string, string> = {}) => {
    const res = await api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params }, { ...headers, ...extra }).catch(() => null);
    return res;
  };
  const call = async (method: string, params?: unknown) => {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  };

  test("lists the tools and creates a task", async () => {
    const tools = (await call("tools/list")).result.tools.map((t: { name: string }) => t.name);
    assert.equal(tools.length, 14);
    const created = await call("tools/call", { name: "create_task", arguments: { board: "School", title: "via MCP", labels: ["Research"] } });
    assert.notEqual(created.result.isError, true, JSON.stringify(created));
    assert.match(created.result.content[0].text, /via MCP/);
  });

  test("rejects a foreign Origin", async () => {
    assert.equal((await rpc("tools/list", undefined, { Origin: "https://evil.example" }))?.status, 403);
  });
});

describe("Canvas sync", () => {
  test("imports upcoming assignments once, follows date changes, never re-creates deleted ones", async () => {
    feedBody = canvasFeed([
      { uid: "event-assignment-1", title: "Problem set 1", due: localDay(3) },
      { uid: "event-assignment-2", title: "Problem set 2", due: localDay(10) },
      { uid: "event-assignment-0", title: "Old problem set", due: localDay(-5) },
    ]);
    assert.deepEqual(await ok("POST", "/api/canvas/sync"), { created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(await ok("POST", "/api/canvas/sync"), { created: 0, updated: 0, skipped: 2 });

    const [ps1] = await ok("GET", "/api/tasks?query=Problem%20set%201");
    assert.deepEqual(ps1.labels, ["MATH 201"]);

    feedBody = feedBody.replace(icsDate(localDay(3)), icsDate(localDay(4)));
    assert.equal((await ok("POST", "/api/canvas/sync")).updated, 1);
    assert.equal((await ok("GET", `/api/tasks/${ps1.id}`)).due_date, localDay(4));

    await ok("DELETE", `/api/tasks/${ps1.id}`);
    assert.equal((await ok("POST", "/api/canvas/sync")).created, 0);
  });

  test("overlapping syncs don't duplicate", async () => {
    feedBody = canvasFeed([{ uid: "event-assignment-9", title: "Essay", due: localDay(2) }]);
    const results = await Promise.all(Array.from({ length: 5 }, () => ok("POST", "/api/canvas/sync")));
    assert.deepEqual(results.map((r) => r.created), [1, 1, 1, 1, 1], "all five share one sync");
    assert.equal((await ok("GET", "/api/tasks?query=Essay")).length, 1);
  });
});
