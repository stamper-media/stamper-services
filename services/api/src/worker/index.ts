import { createFocReader } from "@stamper/foc";
import { createMlClients, nullWatermark } from "@stamper/marking";
import type { AppContext } from "../shared/context.js";
import { registerWorker } from "./app.js";
import { createChainReads } from "./chain-reads.js";
import type { FocStore, WorkerDeps } from "./deps.js";
import { ffprobe, videoFrame } from "./media.js";
import { registerWorkerMetrics } from "./metrics.js";
import { createS3Mirror } from "./mirror.js";
import { createNotifier } from "./notify.js";

export const ML_TIMEOUT_MS = 60_000;

/** Build the key-free worker's dependencies from config (no secret is read here). */
export async function createWorkerDeps(ctx: AppContext): Promise<WorkerDeps> {
  const { cfg, log } = ctx;
  let foc: FocStore | null = null;
  if (cfg.foc.mode === "real") {
    foc = await createFocReader({
      chainId: cfg.foc.chainId as 314 | 314159,
      rpcUrl: cfg.foc.rpcUrl,
      payerAddress: cfg.foc.payerAddress,
      source: "stamper",
      dataSets: cfg.foc.dataSets,
    });
  }
  const ml = cfg.ml.url ? createMlClients(cfg.ml.url, { timeoutMs: ML_TIMEOUT_MS }) : null;
  if (!ml) log.warn("ML_URL unset: watermark skipped, no PDQ index (dev only)");
  if (!cfg.mirror) log.warn("MIRROR_S3_* unset: originals are not mirrored off-box (dev only)");
  return {
    cfg,
    db: ctx.db,
    queue: ctx.queue,
    log,
    foc,
    mirror: cfg.mirror ? createS3Mirror(cfg.mirror) : null,
    watermark: ml?.watermark ?? nullWatermark,
    watermarkEnabled: ml !== null,
    pdq: ml?.pdq ?? null,
    chain: createChainReads(cfg),
    notify: createNotifier(cfg.ntfyUrl, log),
    probeVideo: (p) => ffprobe(p),
    videoFrame: (p) => videoFrame(p),
    fetch: globalThis.fetch,
    now: () => new Date(),
  };
}

/** ROLE=worker: the key-free pipeline (ingest, mark, store, probe, verify-upload, monitors). */
export async function start(ctx: AppContext): Promise<void> {
  if (Object.values(ctx.cfg.secrets ?? {}).some((v) => v != null))
    throw new Error("ROLE=worker must not be configured with any secret");
  await registerWorker(ctx, await createWorkerDeps(ctx));
  registerWorkerMetrics(ctx);
  ctx.log.info({ foc: ctx.cfg.foc.mode, ml: Boolean(ctx.cfg.ml.url) }, "worker started");
}
