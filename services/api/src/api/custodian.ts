import type { Readable } from "node:stream";
import { stamperDomain } from "@stamper/core";
import { createFocCustodian, type FocCustodian } from "@stamper/foc";
import type { Hex } from "viem";
import type { AppContext } from "../shared/context.js";
import { txLatencyMetric } from "../shared/metrics.js";
import { type AttestDeps, createAttestation } from "./attest/index.js";
import { UploadManager } from "./captures/upload.js";
import { createChainClient, Relayer } from "./chain.js";
import { registerJobs } from "./jobs.js";
import { startMockFoc } from "./mock-foc.js";
import { createRegistrar } from "./registrar.js";
import { createRoutes, onError, type RouteOpts } from "./routes.js";
import type { Services } from "./services.js";

export type CustodianOpts = {
  attest?: AttestDeps;
  now?: () => number;
  finalityIntervalMs?: number;
  routes?: RouteOpts;
  /** inject a FOC custodian (tests); otherwise real (session key) or MockFoc by FOC_MODE. */
  foc?: FocCustodian;
};

export type Custodian = { services: Services; close(): Promise<void> };

/** Mirror bucket proxy: object key `originals/<sha256 hex>` (contract with the worker's mirror writer). */
function s3Mirror(ctx: AppContext): RouteOpts["mirrorGet"] {
  const m = ctx.cfg.mirror;
  if (!m) return undefined;
  let client: import("@aws-sdk/client-s3").S3Client | null = null;
  return async (sha: Hex) => {
    const s3 = await import("@aws-sdk/client-s3");
    client ??= new s3.S3Client({
      endpoint: m.endpoint,
      region: m.region,
      forcePathStyle: true,
      ...(m.accessKeyId && m.secretAccessKey
        ? { credentials: { accessKeyId: m.accessKeyId, secretAccessKey: m.secretAccessKey } }
        : {}),
    });
    try {
      const r = await client.send(
        new s3.GetObjectCommand({
          Bucket: m.bucket,
          Key: `originals/${sha.slice(2).toLowerCase()}`,
        }),
      );
      if (!r.Body) return null;
      return {
        body: r.Body as Readable,
        ...(r.ContentLength !== undefined ? { size: r.ContentLength } : {}),
      };
    } catch {
      return null;
    }
  };
}

/** Builds the custodian (keys, chain, FOC, attestation), registers api-role jobs and /v1 routes. */
export async function startCustodian(ctx: AppContext, o: CustodianOpts = {}): Promise<Custodian> {
  const { cfg } = ctx;
  if (cfg.role !== "api") throw new Error("the custodian runs only in ROLE=api");
  const sec = cfg.secrets;
  if (!sec.relayerPk || !sec.registrarPk || !sec.recordWrapKey) {
    throw new Error("RELAYER_PK_FILE, REGISTRAR_PK_FILE and RECORD_WRAP_KEY_FILE are required");
  }
  const domain = stamperDomain(cfg.chain.id, cfg.chain.registry);
  const pub = createChainClient(cfg);
  const latency = txLatencyMetric(ctx.metrics);
  const relayer = new Relayer({ pk: sec.relayerPk, cfg, pub, db: ctx.db, log: ctx.log, latency });
  const resolverOwner = sec.resolverOwnerPk
    ? new Relayer({ pk: sec.resolverOwnerPk, cfg, pub, db: ctx.db, log: ctx.log, latency })
    : null;

  let foc: FocCustodian;
  let closeFoc: () => Promise<void> = async () => {};
  if (o.foc) foc = o.foc;
  else if (cfg.foc.mode === "mock") {
    const m = await startMockFoc(cfg, relayer);
    foc = m;
    closeFoc = () => m.close();
  } else {
    if (!sec.focSessionPk) throw new Error("FOC_SESSION_PK_FILE is required when FOC_MODE=real");
    // throws FocError("session_key") when the key lacks AddPieces permission or has expired
    foc = await createFocCustodian({
      chainId: cfg.foc.chainId as 314 | 314159,
      rpcUrl: cfg.foc.rpcUrl,
      payerAddress: cfg.foc.payerAddress,
      source: "stamper",
      dataSets: cfg.foc.dataSets,
      sessionKeyPk: sec.focSessionPk,
    });
  }

  const services: Services = {
    ctx,
    cfg,
    db: ctx.db,
    queue: ctx.queue,
    log: ctx.log,
    domain: domain as Services["domain"],
    pub,
    relayer,
    resolverOwner,
    registrar: createRegistrar(sec.registrarPk, domain),
    attest: createAttestation(cfg, o.attest),
    foc,
    uploads: new UploadManager({ db: ctx.db, cfg }),
    now: o.now ?? Date.now,
    finalityIntervalMs: o.finalityIntervalMs ?? 30_000,
  };

  await registerJobs(services);
  const mirrorGet = o.routes?.mirrorGet ?? s3Mirror(ctx);
  ctx.http.onError(onError(ctx.log));
  ctx.http.route("/", createRoutes(services, { ...o.routes, ...(mirrorGet ? { mirrorGet } : {}) }));
  ctx.log.info(
    {
      relayer: relayer.address,
      registrar: services.registrar.address,
      attest: cfg.attest.mode,
      foc: cfg.foc.mode,
    },
    "custodian started",
  );
  return { services, close: closeFoc };
}
