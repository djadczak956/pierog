import { rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { getRequestListener } from "@hono/node-server";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { handleApi } from "./api.ts";
import { syncCanvas } from "./canvas.ts";
import { ensureHome, loadConfig, paths } from "./config.ts";
import { createServer as createMcpServer } from "./mcp.ts";
import { migrate } from "./migrate.ts";
import { SqliteD1 } from "./sqlite-d1.ts";

const PUBLIC = join(import.meta.dirname, "..", "public");
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const config = loadConfig();
if (config.timezone) process.env.TZ = config.timezone; // dates.ts reads "today" in the process time zone

ensureHome();
const DB = new SqliteD1(paths.db);
migrate(DB);

const env: Env = {
  DB,
  // Read on each use so `pierog set-canvas` takes effect without a restart.
  get CANVAS_ICS_URL() {
    return loadConfig().canvasIcsUrl;
  },
  CANVAS_BOARD: config.canvasBoard,
};
const mcp = createMcpHandler(() => createMcpServer(env));

async function serveStatic(pathname: string) {
  const file = normalize(join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC)) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(file), { headers: { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handle(request: Request) {
  // The server only listens on loopback, but a website open in the browser can still send requests to
  // localhost; rejecting foreign Host and Origin headers stops it (DNS rebinding, cross-site requests).
  const rejected =
    hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) return rejected;
  const { pathname } = new URL(request.url);
  if (pathname === "/mcp") return mcp.fetch(request);
  if (pathname === "/api/health") return Response.json({ ok: true, pid: process.pid });
  if (pathname.startsWith("/api/")) return handleApi(request, env);
  return serveStatic(pathname);
}

async function scheduledSync() {
  if (!env.CANVAS_ICS_URL) return;
  try {
    console.log(new Date().toISOString(), "canvas sync", await syncCanvas(DB, env.CANVAS_ICS_URL, env.CANVAS_BOARD));
  } catch (e) {
    console.error(new Date().toISOString(), "canvas sync failed:", (e as Error).message);
  }
}

const server = createHttpServer(getRequestListener(handle));
server.listen(config.port, "127.0.0.1", () => {
  writeFileSync(paths.pid, String(process.pid));
  console.log(`${new Date().toISOString()} pierog listening on http://localhost:${config.port}`);
  setInterval(scheduledSync, SYNC_EVERY_MS);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    rmSync(paths.pid, { force: true });
    server.close();
    process.exit(0);
  });
}
