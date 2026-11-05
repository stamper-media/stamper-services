/**
 * Integration (IMPLEMENTATION-PLAN §WP-08): Postgres (docker) + MockFoc (@stamper/foc) + the ml
 * sidecar (services/ml venv, or ML_URL) → ingest → mark → store → verify-upload.
 * Without the sidecar it falls back to nullWatermark + a stand-in hash, and says so.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { pieceCidString } from "@stamper/core";
import { createMockFoc, type DataSetRole, type MockFoc } from "@stamper/foc";
import {
  badgeGeometry,
  createMlClients,
  nullWatermark,
  type PdqClient,
  type WatermarkClient,
} from "@stamper/marking";
import { eq } from "drizzle-orm";
import pino from "pino";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import {
  closeDb,
  createDb,
  type Db,
  derivatives,
  migrate,
  renditions,
} from "../../src/db/index.js";
import { verifyJobs } from "../../src/db/repo/index.js";
import { boot } from "../../src/main.js";
import { createMemoryQueue } from "../../src/queue/memory.js";
import { byteaToHex, hexToBytea, stagingPath } from "../../src/shared/index.js";
import { registerWorker } from "../../src/worker/app.js";
import type { FocStore } from "../../src/worker/deps.js";
import { handleVerifyUpload } from "../../src/worker/jobs/verify-upload.js";
import { sha256Hex } from "../../src/worker/media.js";
import { mirrorKey } from "../../src/worker/mirror.js";
import { baseEnv } from "../foundation/env.js";
import { freshDatabase, skipReason, startPg, stopPg } from "../foundation/pg.js";
import {
  fakePdq,
  makeDeps,
  makeJpeg,
  memoryMirror,
  seedStamp,
  tempDirs,
  workerConfig,
} from "./helpers.js";

const admin = await startPg();
if (!admin) console.warn(`[worker pipeline] skipped: ${skipReason}`);
const d = describe.skipIf(!admin);
const ML_DIR = fileURLToPath(new URL("../../../ml/", import.meta.url));
const dirs = tempDirs();
let db: Db;
let url: string;
let cfg: AppConfig;
let mock: MockFoc;
let ml: ChildProcess | null = null;
let wm: WatermarkClient = nullWatermark;
let pdq: PdqClient = fakePdq;
let mlMode = "none";

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function startMl(): Promise<string | null> {
  if (process.env.ML_URL) return process.env.ML_URL;
  const py = `${ML_DIR}.venv/bin/python`;
  if (!existsSync(py)) return null;
  const port = await freePort();
  ml = spawn(py, ["-m", "app.main"], {
    cwd: ML_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      ML_PORT: String(port),
      MODELS_DIR: `${ML_DIR}models`,
      STAGING_DIR: dirs.staging,
      ML_WATERMARK: "auto",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (ml.exitCode !== null) return null;
    try {
      if ((await fetch(`${base}/health`)).ok) return base;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

beforeAll(async () => {
  if (!admin) return;
  url = await freshDatabase();
  db = await createDb(url);
  await migrate(db);
  cfg = workerConfig(url, dirs);
  mock = await createMockFoc({
    dir: dirs.root,
    port: 0,
    onCommit: async () => {
      throw new Error("commit belongs to the api");
    },
  });
  const mlUrl = await startMl();
  if (mlUrl) {
    const c = createMlClients(mlUrl, { timeoutMs: 120_000 });
    const h = await c.health();
    pdq = c.pdq;
    if (h.models.length > 0) wm = c.watermark;
    mlMode =
      h.models.length > 0
        ? "ml sidecar (TrustMark + PDQ)"
        : "ml sidecar (PDQ only; no weights → nullWatermark)";
  } else mlMode = "no ml sidecar: nullWatermark + stand-in hash";
  console.info(`[worker pipeline] ${mlMode}`);
}, 180_000);

afterAll(async () => {
  ml?.kill("SIGTERM");
  await mock?.close();
  if (db) await closeDb(db);
  await stopPg();
  dirs.cleanup();
});

d("pipeline: ingest → mark → store → verify-upload", () => {
  it("produces the derivative, 12 PDQ rows, mirror objects, both FOC stores, commit ×2 + attach ×1", async () => {
    const q = createMemoryQueue("worker");
    const stored: DataSetRole[] = [];
    const foc: FocStore = {
      storeOriginal: async (ds, data, cid, o) => {
        stored.push(ds);
        return mock.storeOriginal(ds, data, cid, o);
      },
      retrievalUrls: (c) => mock.retrievalUrls(c),
      dataSetHealth: (ds) => mock.dataSetHealth(ds),
    };
    const mirror = memoryMirror();
    const deps = makeDeps(
      { cfg, db, queue: q },
      { foc, mirror, watermark: wm, watermarkEnabled: wm !== nullWatermark, pdq },
    );
    await registerWorker({ queue: q }, deps);
    const original = await makeJpeg(1024, 768, 21);
    const s = await seedStamp(db, cfg, original);
    await q.enqueue("ingest", { stampId: s.stampId });
    await q.drain();
    expect(q.failed).toEqual([]);

    const [der] = await db.select().from(derivatives).where(eq(derivatives.kind, 1));
    expect(der).toBeDefined();
    const file = new Uint8Array(readFileSync(der?.path as string));
    expect(byteaToHex(der?.sha256 as Buffer)).toBe(sha256Hex(file));

    // pixels change only inside the pill (pixelmatch at the default perceptual threshold)
    const g = badgeGeometry(1024, 768, "F1");
    const a = await sharp(original).ensureAlpha().raw().toBuffer();
    const b = await sharp(file).ensureAlpha().raw().toBuffer();
    const diff = Buffer.alloc(a.length);
    pixelmatch(a, b, diff, 1024, 768, { threshold: 0.1, diffMask: true });
    let outside = 0;
    let inside = 0;
    for (let y = 0; y < 768; y++)
      for (let x = 0; x < 1024; x++) {
        const i = (y * 1024 + x) * 4;
        const changed = (diff[i + 3] ?? 0) > 0;
        const inPill =
          x >= g.x - 8 && x < g.x + g.width + 8 && y >= g.y - 8 && y < g.y + g.pillH + 8;
        if (changed && inPill) inside++;
        else if (changed) outside++;
      }
    expect(outside).toBe(0);
    expect(inside).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(renditions)
      .where(eq(renditions.stampId, hexToBytea(s.stampId)));
    expect(rows).toHaveLength(12);
    expect([...mirror.objects.keys()].sort()).toEqual(
      [
        mirrorKey.original(s.sha256),
        mirrorKey.derivative(byteaToHex(der?.sha256 as Buffer)),
      ].sort(),
    );
    expect(stored).toEqual(["A", "B"]);
    const got = await fetch(`${mock.baseUrl}/piece/${pieceCidString(s.pieceCid)}`);
    expect(got.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await got.arrayBuffer()))).toBe(s.sha256);
    expect(
      q.pending
        .filter((p) => p.name === "commit")
        .map((p) => (p.data as { dataSet: string }).dataSet)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(q.pending.filter((p) => p.name === "attach")).toHaveLength(1);

    if (wm !== nullWatermark) {
      const dec = await wm.decode(file);
      expect(dec.payload40).toBe(s.code);
    }

    // verify-upload of the derivative (chain lookups answered from the derivatives row)
    const jobId = crypto.randomUUID();
    const path = stagingPath(cfg, jobId);
    await import("node:fs/promises").then((f) => f.writeFile(path, file));
    await verifyJobs.create(db, { id: jobId, path });
    const r = await handleVerifyUpload(deps, { jobId });
    expect(r).toMatchObject({
      verdict: "STAMPER_MARKED_COPY",
      stampId: s.stampId,
      path: "derivative",
    });
  }, 180_000);
});

d("boot", () => {
  it("ROLE=worker boots with FOC_MODE=mock and ML_URL unset (watermark skipped, logged)", async () => {
    const lines: string[] = [];
    const log = pino({ level: "info" }, { write: (l: string) => void lines.push(l) });
    const running = await boot(
      baseEnv("worker", {
        DATABASE_URL: url,
        STAGING_DIR: dirs.staging,
        CACHE_DIR: dirs.cache,
        SCHEMA_WAIT_MS: "20000",
      }),
      { log },
    );
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/healthz`);
      expect(res.status).toBe(200);
      expect(lines.some((l) => l.includes("ML_URL unset"))).toBe(true);
    } finally {
      await running.close();
    }
  }, 60_000);
});
