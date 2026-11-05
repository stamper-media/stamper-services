/**
 * pg-boss 10 adapter behind the queue port (Postgres only, no Redis). Queues use the `short`
 * policy: at most one *queued* job per (name, singletonKey); retries and active jobs are not
 * blocked. bullmq@6 lists `pg` as an optional peer, but pg-boss stays the backend (see README).
 */
import PgBoss from "pg-boss";
import type { Logger } from "../shared/logger.js";
import { jobMetrics, type Registry } from "../shared/metrics.js";
import {
  assertCron,
  assertOwner,
  canonicalKey,
  type EnqueueOptions,
  type Handler,
  isJobName,
  JOB_NAMES,
  type JobName,
  type JobPayload,
  parsePayload,
  type Queue,
  type QueueStat,
  type Role,
} from "./port.js";

export type PgBossQueueOptions = {
  log?: Logger;
  metrics?: Registry;
  /** pg-boss schema name (default "pgboss"). */
  schema?: string;
  pollingIntervalSeconds?: number;
  defaultRetryLimit?: number;
  defaultRetryDelayMs?: number;
};

export async function createQueue(
  databaseUrl: string,
  role: Role,
  opts: PgBossQueueOptions = {},
): Promise<Queue> {
  const schema = opts.schema ?? "pgboss";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new Error(`invalid pg-boss schema name: ${schema}`);
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema,
    application_name: `stamper-${role}-queue`,
    max: 5,
  });
  boss.on("error", (err: unknown) => opts.log?.error({ err }, "queue error"));
  await boss.start();
  const retryLimit = opts.defaultRetryLimit ?? 5;
  const retryDelay = Math.max(1, Math.round((opts.defaultRetryDelayMs ?? 5000) / 1000));
  for (const name of JOB_NAMES) {
    if (!(await boss.getQueue(name))) {
      try {
        await boss.createQueue(name, {
          name,
          policy: "short",
          retryLimit,
          retryDelay,
          retryBackoff: true,
        });
      } catch (err) {
        // Another process created it concurrently.
        if (!(await boss.getQueue(name))) throw err;
      }
    }
  }
  const m = opts.metrics ? jobMetrics(opts.metrics) : undefined;
  const polling = opts.pollingIntervalSeconds ?? 2;
  let stopped = false;

  return {
    role,
    async enqueue<N extends JobName>(name: N, payload: JobPayload[N], o: EnqueueOptions = {}) {
      const data = parsePayload(name, payload);
      const id = await boss.send(name, data as object, {
        singletonKey: o.singletonKey ?? canonicalKey(data as object),
        ...(o.delayMs ? { startAfter: Math.max(1, Math.ceil(o.delayMs / 1000)) } : {}),
        ...(o.retryLimit !== undefined ? { retryLimit: o.retryLimit } : {}),
        ...(o.retryDelayMs !== undefined
          ? { retryDelay: Math.max(1, Math.round(o.retryDelayMs / 1000)) }
          : {}),
        ...(o.retryBackoff !== undefined ? { retryBackoff: o.retryBackoff } : {}),
      });
      return id;
    },
    async work<N extends JobName>(name: N, handler: Handler<N>, o: { concurrency?: number } = {}) {
      assertOwner(role, name, "work");
      const n = Math.max(1, Math.min(32, o.concurrency ?? 1));
      for (let i = 0; i < n; i++) {
        await boss.work<object>(
          name,
          { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: polling },
          async (jobs) => {
            for (const job of jobs) {
              const end = m?.jobSeconds.startTimer({ name });
              try {
                await handler(parsePayload(name, job.data), {
                  id: job.id,
                  attempt: job.retryCount + 1,
                });
                m?.jobs.inc({ name, outcome: "ok" });
              } catch (err) {
                m?.jobs.inc({ name, outcome: "error" });
                opts.log?.warn(
                  { err, job: name, id: job.id, attempt: job.retryCount + 1 },
                  "job failed",
                );
                throw err;
              } finally {
                end?.();
              }
            }
          },
        );
      }
    },
    async schedule(name: JobName, cron: string) {
      assertOwner(role, name, "schedule");
      assertCron(cron);
      await boss.schedule(name, cron, {}, { tz: "UTC" });
    },
    async stats(): Promise<QueueStat[]> {
      // runnable = queued or retrying with its start time reached; age counts from then
      const { rows } = await boss.getDb().executeSql(
        `select name, count(*)::int as waiting,
                extract(epoch from now() - min(start_after))::float8 as age
           from "${schema}".job
          where state in ('created', 'retry') and start_after <= now()
          group by name`,
        [],
      );
      return (rows as { name: string; waiting: number; age: number | null }[])
        .filter((r) => isJobName(r.name))
        .map((r) => ({
          name: r.name as JobName,
          waiting: Number(r.waiting),
          oldestAgeSeconds: Math.max(0, Number(r.age ?? 0)),
        }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await boss.stop({ graceful: true, close: true, wait: true, timeout: 10_000 });
    },
  };
}
