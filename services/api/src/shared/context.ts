import type { Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Queue } from "../queue/port.js";
import type { Logger } from "./logger.js";
import type { Registry } from "./metrics.js";

/**
 * What api.start / worker.start receive. `http` already serves /healthz and /metrics; a role
 * adds its routes to it during start(), and main.ts begins listening after start() resolves.
 */
export type AppContext = {
  cfg: AppConfig;
  db: Db;
  queue: Queue;
  log: Logger;
  metrics: Registry;
  http: Hono;
};

export type RoleStart = (ctx: AppContext) => Promise<void>;
