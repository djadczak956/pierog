import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything personal (data, Canvas feed URL) lives here, outside the repo.
export const HOME = process.env.PIEROG_HOME ?? join(homedir(), ".pierog");
export const paths = {
  config: join(HOME, "config.json"),
  db: join(HOME, "pierog.db"),
  pid: join(HOME, "pierog.pid"),
  log: join(HOME, "pierog.log"),
};

export interface Config {
  port: number;
  canvasIcsUrl: string | null;
  canvasBoard: string;
  timezone: string | null; // null = system time zone
}

const DEFAULTS: Config = { port: 4747, canvasIcsUrl: null, canvasBoard: "School", timezone: null };

export function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  if (!existsSync(paths.config)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(paths.config, "utf8")) };
}

export function saveConfig(patch: Partial<Config>) {
  ensureHome();
  writeFileSync(paths.config, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(paths.config, 0o600); // the Canvas feed URL works like a password
}
