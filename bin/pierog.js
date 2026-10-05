#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, loadConfig, paths, saveConfig } from "../src/config.ts";

const SERVER = join(import.meta.dirname, "..", "src", "server.ts");
const { port } = loadConfig();
const url = `http://localhost:${port}`;

async function health() {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function start() {
  if (await health()) return false;
  ensureHome();
  const log = openSync(paths.log, "a");
  // Detached with its own output, so it keeps running after this terminal closes.
  spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await health()) return true;
  }
  console.error(`pierog didn't start; see ${paths.log}`);
  process.exit(1);
}

async function syncNow() {
  try {
    const res = await fetch(`${url}/api/canvas/sync`, { method: "POST", signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    console.log(`Canvas: ${body.created} new, ${body.updated} updated`);
    return true;
  } catch (e) {
    console.error(`Canvas sync failed: ${e.message}`);
    return false;
  }
}

function openBrowser() {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function readSecretInput() {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" });
  console.error("Pipe the feed URL in, e.g.  pbpaste | pierog set-canvas");
  process.exit(1);
}

const commands = {
  async open() {
    const started = await start();
    console.log(`${started ? "Started" : "Already running"}: ${url}`);
    // Sync before opening so new assignments are already on the board.
    if (loadConfig().canvasIcsUrl) await syncNow();
    openBrowser();
  },
  async start() {
    console.log(`${(await start()) ? "Started" : "Already running"}: ${url}`);
    if (loadConfig().canvasIcsUrl) await syncNow();
  },
  async stop() {
    const h = await health();
    if (!h) return console.log("Not running.");
    process.kill(h.pid, "SIGTERM");
    rmSync(paths.pid, { force: true });
    console.log("Stopped.");
  },
  async status() {
    const h = await health();
    console.log(h ? `Running (pid ${h.pid}): ${url}\nData: ${paths.db}` : "Not running. Start it with: pierog");
  },
  async sync() {
    await start();
    if (!(await syncNow())) process.exitCode = 1;
  },
  async "set-canvas"() {
    // The feed URL acts as a password: read it from the clipboard or stdin, never from argv or the screen.
    const value = readSecretInput().trim();
    if (!/^https:\/\/\S+\.ics(\?\S*)?$/.test(value)) {
      console.error("That isn't a Canvas .ics feed link. Copy it from Canvas > Calendar > Calendar Feed, then rerun.");
      process.exit(1);
    }
    saveConfig({ canvasIcsUrl: value });
    console.log(`Saved the Canvas feed to ${paths.config}.`);
  },
  help() {
    console.log(`Usage: pierog [command]

  (none)       start if needed, sync Canvas, and open the board in your browser
  start        start in the background and sync Canvas, without opening the browser
  stop         stop the background server
  status       show whether it's running and where data lives
  sync         import upcoming Canvas assignments now
  set-canvas   save your Canvas calendar feed URL (copy it first; read from the clipboard or stdin)

Board: ${url}   Data: ${paths.db}`);
  },
};

const name = process.argv[2] ?? "open";
const command = commands[name] ?? (name === "--help" || name === "-h" ? commands.help : null);
if (!command) {
  console.error(`Unknown command "${name}".\n`);
  commands.help();
  process.exit(1);
}
await command();
