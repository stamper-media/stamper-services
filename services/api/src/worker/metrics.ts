import { gt, sql } from "drizzle-orm";
import { bindings } from "../db/index.js";
import { JOB_NAMES } from "../queue/port.js";
import type { AppContext } from "../shared/context.js";
import { probeFailuresGauge, queueAgeGauge } from "../shared/metrics.js";

/**
 * Worker-side ops gauges read by infra/scripts/healthcheck.sh: queue lag over every queue (the
 * pg-boss tables are shared, so this covers the api's queues too) and bindings whose last probe
 * failed. Both are recomputed from Postgres at scrape time (at most every 10 s).
 */
export function registerWorkerMetrics(
  ctx: Pick<AppContext, "db" | "queue" | "metrics" | "log">,
): void {
  const { queue } = ctx;
  if (queue.stats) {
    queueAgeGauge(ctx.metrics, {
      stats: () => queue.stats?.() ?? Promise.resolve([]),
      queues: JOB_NAMES,
      log: ctx.log,
    });
  } else
    ctx.log.warn("queue adapter reports no stats: stamper_queue_oldest_age_seconds not exported");
  probeFailuresGauge(ctx.metrics, {
    failing: () =>
      ctx.db
        .select({ slot: bindings.slot, count: sql<number>`count(*)::int` })
        .from(bindings)
        .where(gt(bindings.probeFailures, 0))
        .groupBy(bindings.slot),
    slots: [0, 1],
    log: ctx.log,
  });
}
