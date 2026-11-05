import { DEFAULT_SCHEDULES, type JobName } from "../queue/port.js";
import type { AppContext } from "../shared/context.js";
import type { WorkerDeps } from "./deps.js";
import { handleIngest } from "./jobs/ingest.js";
import { handleMark } from "./jobs/mark.js";
import { handleMirrorGc } from "./jobs/mirror-gc.js";
import { handlePdpMonitor } from "./jobs/pdp-monitor.js";
import { handleProbe } from "./jobs/probe.js";
import { handleProbeSample } from "./jobs/probe-sample.js";
import { handleStore } from "./jobs/store.js";
import { handleVerifyUpload } from "./jobs/verify-upload.js";

/** Repeat jobs this role owns (DESIGN §9.4); finality and runway belong to the api. */
export const WORKER_SCHEDULED: readonly JobName[] = ["pdp-monitor", "probe-sample", "mirror-gc"];

/** Register every worker-owned handler and schedule the monitors. */
export async function registerWorker(ctx: Pick<AppContext, "queue">, d: WorkerDeps): Promise<void> {
  const q = ctx.queue;
  await q.work("ingest", async (p) => void (await handleIngest(d, p)), { concurrency: 2 });
  await q.work("mark", async (p) => void (await handleMark(d, p)), { concurrency: 2 });
  await q.work("store", async (p) => void (await handleStore(d, p)), { concurrency: 2 });
  await q.work("probe", async (p) => void (await handleProbe(d, p)), { concurrency: 4 });
  await q.work("verify-upload", async (p) => void (await handleVerifyUpload(d, p)), {
    concurrency: 4,
  });
  await q.work("pdp-monitor", async () => void (await handlePdpMonitor(d)));
  await q.work("probe-sample", async () => void (await handleProbeSample(d)));
  await q.work("mirror-gc", async () => void (await handleMirrorGc(d)));
  for (const name of WORKER_SCHEDULED) {
    const cron = DEFAULT_SCHEDULES[name];
    if (cron) await q.schedule(name, cron);
  }
}
