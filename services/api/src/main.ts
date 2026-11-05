/**
 * Process entry: loadConfig → createDb → migrate (api only) / waitForSchema (worker) →
 * createQueue → role start(ctx) → listen. /healthz and /metrics are served by both roles.
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { start as apiStart } from "./api/index.js";
import { type AppConfig, loadConfig } from "./config.js";
import { closeDb, createDb, migrate, ping, waitForSchema } from "./db/index.js";
import { createQueue } from "./queue/pgboss.js";
import type { AppContext, RoleStart } from "./shared/context.js";
import { createLogger, type Logger } from "./shared/logger.js";
import { createMetrics } from "./shared/metrics.js";
import { start as workerStart } from "./worker/index.js";

export type Running = { ctx: AppContext; port: number; close(): Promise<void> };

export type BootOptions = {
  /** Replace the role's start function (tests). */
  start?: RoleStart;
  log?: Logger;
};

export function createBaseApp(ctx: Omit<AppContext, "http">): Hono {
  const app = new Hono();
  app.get("/healthz", async (c) => {
    const db = await ping(ctx.db);
    return c.json({ ok: db, role: ctx.cfg.role, db }, db ? 200 : 503);
  });
  app.get("/metrics", async (c) => {
    const body = await ctx.metrics.metrics();
    return c.body(body, 200, { "content-type": ctx.metrics.contentType });
  });
  return app;
}

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<Running> {
  const cfg: AppConfig = loadConfig(env);
  const log = opts.log ?? createLogger({ role: cfg.role, level: cfg.logLevel });
  const metrics = createMetrics(cfg.role);
  const db = await createDb(cfg.databaseUrl);
  let server: ServerType | undefined;
  let queue: AppContext["queue"] | undefined;
  try {
    if (cfg.role === "api") {
      await migrate(db);
      log.info("migrations applied");
    } else {
      await waitForSchema(db, cfg.schemaWaitMs);
    }
    queue = await createQueue(cfg.databaseUrl, cfg.role, { log, metrics });
    const base = { cfg, db, queue, log, metrics };
    const ctx: AppContext = { ...base, http: createBaseApp(base) };
    const start = opts.start ?? (cfg.role === "api" ? apiStart : workerStart);
    await start(ctx);
    const srv = await new Promise<ServerType>((resolve, reject) => {
      const s = serve({ fetch: ctx.http.fetch, port: cfg.port, hostname: cfg.host }, () =>
        resolve(s),
      );
      s.once("error", reject);
    });
    server = srv;
    const port = (srv.address() as AddressInfo).port;
    log.info(
      { port, chain: cfg.chain.id, foc: cfg.foc.mode, attest: cfg.attest.mode },
      "listening",
    );
    let closing: Promise<void> | undefined;
    return {
      ctx,
      port,
      close() {
        closing ??= (async () => {
          await new Promise<void>((r) => srv.close(() => r()));
          await ctx.queue.stop();
          await closeDb(db);
        })();
        return closing;
      },
    };
  } catch (err) {
    server?.close();
    await queue?.stop().catch(() => {});
    await closeDb(db).catch(() => {});
    throw err;
  }
}

async function cli(): Promise<void> {
  const fallbackLog = createLogger({ role: process.env.ROLE ?? "unknown" });
  let running: Running;
  try {
    running = await boot(process.env);
  } catch (err) {
    fallbackLog.fatal({ err }, "boot failed");
    process.exit(1);
  }
  const shutdown = (sig: string) => {
    running.ctx.log.info({ sig }, "shutting down");
    const t = setTimeout(() => process.exit(1), 15_000);
    t.unref();
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        running.ctx.log.error({ err }, "shutdown error");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void cli();
}
