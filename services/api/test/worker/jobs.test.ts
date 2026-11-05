import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DataSetHealth, DataSetRole } from "@stamper/foc";
import { paramsHash, type RenderParams } from "@stamper/marking";
import { minimiseMp4 } from "@stamper/minimise";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import {
  bindings,
  closeDb,
  createDb,
  type Db,
  dataSets,
  derivatives,
  migrate,
  moderation,
  renditions,
  uploads,
} from "../../src/db/index.js";
import { stamps, verifyJobs } from "../../src/db/repo/index.js";
import { createMemoryQueue, type MemoryQueue } from "../../src/queue/memory.js";
import { byteaToHex, hexToBytea, stagingPath } from "../../src/shared/index.js";
import type { FocStore } from "../../src/worker/deps.js";
import { handleIngest } from "../../src/worker/jobs/ingest.js";
import { handleMark } from "../../src/worker/jobs/mark.js";
import { handleMirrorGc } from "../../src/worker/jobs/mirror-gc.js";
import { handlePdpMonitor } from "../../src/worker/jobs/pdp-monitor.js";
import { handleProbe } from "../../src/worker/jobs/probe.js";
import { handleProbeSample } from "../../src/worker/jobs/probe-sample.js";
import { handleStore } from "../../src/worker/jobs/store.js";
import { handleVerifyUpload } from "../../src/worker/jobs/verify-upload.js";
import { mirrorKey } from "../../src/worker/mirror.js";
import { freshDatabase, skipReason, startPg, stopPg } from "../foundation/pg.js";
import {
  fakeWatermark,
  fixture,
  makeDeps,
  makeJpeg,
  memoryMirror,
  seedStamp,
  tempDirs,
  workerConfig,
} from "./helpers.js";

const admin = await startPg();
const d = describe.skipIf(!admin);
if (!admin) console.warn(`[worker jobs] skipped: ${skipReason}`);

const dirs = tempDirs();
let db: Db;
let cfg: AppConfig;
let q: MemoryQueue;

async function freshDb(): Promise<void> {
  if (db) await closeDb(db);
  const url = await freshDatabase();
  db = await createDb(url);
  await migrate(db);
  cfg = workerConfig(url, dirs);
}
const deps = (over: Parameters<typeof makeDeps>[1] = {}) => makeDeps({ cfg, db, queue: q }, over);
const pendingOf = (name: string) => q.pending.filter((p) => p.name === name);

beforeAll(async () => {
  if (admin) await freshDb();
}, 120_000);
afterAll(async () => {
  if (db) await closeDb(db);
  await stopPg();
  dirs.cleanup();
});

d("ingest", () => {
  it("accepts a clean JPEG and enqueues mark + store", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(640, 480));
    const r = await handleIngest(deps(), { stampId: s.stampId });
    expect(r.outcome).toBe("accepted");
    expect(pendingOf("mark")).toHaveLength(1);
    expect(pendingOf("store")).toHaveLength(1);
    const [m] = await db
      .select()
      .from(moderation)
      .where(eq(moderation.stampId, hexToBytea(s.stampId)));
    expect(m?.decision).toBe("pass");
    expect((await stamps.byId(db, s.stampId))?.width).toBe(640);
  });

  it("rejects a GPS-bearing JPEG, enqueues flag(RejectedPrePublication) and never mark/store", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, fixture("gps-48x32.jpg"));
    const r = await handleIngest(deps(), { stampId: s.stampId });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reasons).toContain("gps_present");
    expect((await stamps.byId(db, s.stampId))?.status).toBe("rejected");
    expect(pendingOf("flag").map((p) => (p.data as { flag: number }).flag)).toEqual([4]);
    expect(pendingOf("mark")).toHaveLength(0);
    expect(pendingOf("store")).toHaveLength(0);
  });

  it("rejects a truncated JPEG", async () => {
    q = createMemoryQueue("worker");
    const b = await makeJpeg(640, 480, 2);
    const s = await seedStamp(db, cfg, b.slice(0, Math.floor(b.byteLength * 0.6)));
    const r = await handleIngest(deps(), { stampId: s.stampId });
    expect(r).toMatchObject({ outcome: "rejected" });
    if (r.outcome === "rejected") expect(r.reasons).toContain("undecodable");
  });

  it("rejects a 4-minute video (ffprobe mocked)", async () => {
    q = createMemoryQueue("worker");
    const clean = minimiseMp4(fixture("pixel.mp4")).bytes;
    const s = await seedStamp(db, cfg, clean, { mediaKind: 2 });
    const probeVideo = async () => ({
      durationMs: 240_000,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioCodecs: ["aac"],
    });
    const r = await handleIngest(deps({ probeVideo }), { stampId: s.stampId });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reasons).toEqual(["too_long"]);
  });

  it("notes a near-duplicate (PDQ ≤ 10 bits) without rejecting", async () => {
    q = createMemoryQueue("worker");
    const base = await makeJpeg(640, 480, 3);
    const a = await seedStamp(db, cfg, base);
    await handleMark(deps(), { stampId: a.stampId });
    const recompressed = new Uint8Array(
      await sharp(base)
        .jpeg({ quality: 70 })
        .withExif({ IFD0: { Orientation: "1" } })
        .toBuffer(),
    );
    const b = await seedStamp(db, cfg, recompressed);
    const r = await handleIngest(deps(), { stampId: b.stampId });
    expect(r.outcome).toBe("accepted");
    if (r.outcome === "accepted") {
      const near = r.notes.nearDup as Array<{ stampId: string; distance: number }>;
      expect(near.map((x) => x.stampId)).toContain(a.stampId);
    }
  });
});

d("mark", () => {
  it("renders the derivative (paramsHash = marking.paramsHash), share card, previews, 12 PDQ rows, attach", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(800, 600, 4));
    const mirror = memoryMirror();
    const r = await handleMark(deps({ mirror }), { stampId: s.stampId });
    expect(r.outcome).toBe("marked");
    if (r.outcome !== "marked") return;
    const rows = await db
      .select()
      .from(derivatives)
      .where(eq(derivatives.stampId, hexToBytea(s.stampId)));
    const marked = rows.find((x) => x.kind === 1);
    expect(marked).toBeDefined();
    expect(byteaToHex(marked?.paramsHash as Buffer)).toBe(
      paramsHash(marked?.params as RenderParams),
    );
    expect((marked?.params as RenderParams | undefined)?.family).toBe("F1");
    expect(existsSync(marked?.path as string)).toBe(true);
    const card = rows.find((x) => x.kind === 3);
    expect(card?.path && existsSync(card.path)).toBe(true);
    const meta = await sharp(readFileSync(card?.path as string)).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    for (const f of ["preview.jpg", "thumb.webp"])
      expect(existsSync(String(card?.path).replace("share-card.png", f))).toBe(true);
    const pdq = await db
      .select()
      .from(renditions)
      .where(eq(renditions.stampId, hexToBytea(s.stampId)));
    expect(pdq).toHaveLength(12);
    expect(pdq.filter((p) => p.derivativeId === r.derivativeId)).toHaveLength(1);
    expect(mirror.objects.has(mirrorKey.derivative(r.sha256))).toBe(true);
    expect(pendingOf("attach").map((p) => p.data)).toEqual([
      { stampId: s.stampId, derivativeId: r.derivativeId },
    ]);
    expect((await stamps.byId(db, s.stampId))?.status).toBe("marked");
  });

  it("a retry after a partial failure resumes instead of skipping (mirror put failed)", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(400, 300, 31));
    const mirror = memoryMirror();
    const failing = { ...mirror, put: async () => Promise.reject(new Error("s3 down")) };
    await expect(handleMark(deps({ mirror: failing }), { stampId: s.stampId })).rejects.toThrow();
    const r = await handleMark(deps({ mirror }), { stampId: s.stampId });
    expect(r.outcome).toBe("marked");
    if (r.outcome !== "marked") return;
    expect(mirror.objects.has(mirrorKey.derivative(r.sha256))).toBe(true);
    const again = await handleMark(deps({ mirror }), { stampId: s.stampId });
    expect(again).toEqual({ outcome: "skipped", reason: "already marked" });
  });

  it("uses family F0 for a level-0 stamp", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(400, 300, 5), { level: 0 });
    await handleMark(deps({ pdq: null }), { stampId: s.stampId });
    const [row] = await db
      .select()
      .from(derivatives)
      .where(eq(derivatives.stampId, hexToBytea(s.stampId)));
    expect((row?.params as RenderParams | undefined)?.family).toBe("F0");
  });
});

d("store", () => {
  it("stores on A then B only after the mirror put resolved, then enqueues commit ×2", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(400, 300, 6));
    const events: string[] = [];
    const mirror = memoryMirror({ delayMs: 50, events });
    const foc = {
      async storeOriginal(ds: DataSetRole, data: Uint8Array | ReadableStream<Uint8Array>) {
        let n = 0;
        if (!(data instanceof Uint8Array))
          for await (const c of data as unknown as AsyncIterable<Uint8Array>) n += c.byteLength;
        events.push(`foc.store:${ds}:${n}`);
        return { pieceCid: s.pieceCid, size: n };
      },
    } as unknown as FocStore;
    const r = await handleStore(deps({ mirror, foc }), { stampId: s.stampId });
    expect(r).toMatchObject({ outcome: "stored", focStored: ["A", "B"] });
    const size = readFileSync(s.path).byteLength;
    const key = mirrorKey.original(s.sha256);
    expect(events).toEqual([
      `mirror.put:start:${key}`,
      `mirror.put:done:${key}`,
      `foc.store:A:${size}`,
      `foc.store:B:${size}`,
    ]);
    expect(pendingOf("commit").map((p) => p.data)).toEqual([
      { stampId: s.stampId, dataSet: "A" },
      { stampId: s.stampId, dataSet: "B" },
    ]);
  });

  it("does not store when the mirror put fails", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(400, 300, 7));
    let stored = 0;
    const mirror = { ...memoryMirror(), put: async () => Promise.reject(new Error("bucket down")) };
    const foc = { storeOriginal: async () => void stored++ } as unknown as FocStore;
    await expect(handleStore(deps({ mirror, foc }), { stampId: s.stampId })).rejects.toThrow(
      "bucket down",
    );
    expect(stored).toBe(0);
    expect(pendingOf("commit")).toHaveLength(0);
  });
});

d("probe", () => {
  let srv: Server;
  let body: Uint8Array = new Uint8Array();
  beforeAll(async () => {
    srv = createServer((_req, res) => res.end(body));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it("updates last_ok_at only on a hash match", async () => {
    q = createMemoryQueue("worker");
    const bytes = await makeJpeg(320, 240, 8);
    const s = await seedStamp(db, cfg, bytes);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/piece/x`;
    await db.insert(bindings).values({
      stampId: hexToBytea(s.stampId),
      slot: 1,
      asset: 0,
      serviceUrl: url,
      providerId: 2n,
    });
    body = bytes;
    const ok = await handleProbe(deps(), { stampId: s.stampId, slot: 1 });
    expect(ok).toMatchObject({ outcome: "probed", ok: true });
    const [b1] = await db
      .select()
      .from(bindings)
      .where(eq(bindings.stampId, hexToBytea(s.stampId)));
    expect(b1?.lastOkAt).toBeInstanceOf(Date);
    body = await makeJpeg(320, 240, 9);
    const dep = deps({ now: () => new Date(Date.now() + 4 * 24 * 3600 * 1000) });
    const bad = await handleProbe(dep, { stampId: s.stampId, slot: 1 });
    expect(bad).toMatchObject({ outcome: "probed", ok: false });
    const [b2] = await db
      .select()
      .from(bindings)
      .where(eq(bindings.stampId, hexToBytea(s.stampId)));
    expect(b2?.lastOkAt?.getTime()).toBe(b1?.lastOkAt?.getTime());
    expect(b2?.probeFailures).toBe(1);
    expect(dep.notices.map((n) => n.title)).toEqual(["repair needed"]);
  });
});

d("verify-upload ladder", () => {
  async function verify(bytes: Uint8Array, over: Parameters<typeof makeDeps>[1] = {}) {
    const id = randomUUID();
    const path = stagingPath(cfg, id);
    writeFileSync(path, bytes);
    await verifyJobs.create(db, { id, path });
    const r = await handleVerifyUpload(deps(over), { jobId: id });
    expect((await verifyJobs.get(db, id))?.status).toBe("done");
    return r;
  }
  const base = () => makeJpeg(640, 480, 11);

  it("exact ⇒ ORIGINAL, derivative ⇒ STAMPER_MARKED_COPY, watermark ⇒ RELATED via code, PDQ ⇒ RELATED, random ⇒ NOT_REGISTERED", async () => {
    await freshDb();
    q = createMemoryQueue("worker");
    const orig = await base();
    const s = await seedStamp(db, cfg, orig);
    const m = await handleMark(deps(), { stampId: s.stampId });
    if (m.outcome !== "marked") throw new Error("mark failed");
    expect(await verify(orig)).toMatchObject({
      verdict: "ORIGINAL",
      stampId: s.stampId,
      path: "exact",
    });
    const [der] = await db.select().from(derivatives).where(eq(derivatives.id, m.derivativeId));
    expect(await verify(new Uint8Array(readFileSync(der?.path as string)))).toMatchObject({
      verdict: "STAMPER_MARKED_COPY",
      stampId: s.stampId,
    });
    const noise = new Uint8Array(
      await sharp(Buffer.from(Array.from({ length: 320 * 240 * 3 }, (_, i) => (i * 7919) % 251)), {
        raw: { width: 320, height: 240, channels: 3 },
      })
        .jpeg()
        .toBuffer(),
    );
    const wm = await verify(noise, { watermark: fakeWatermark(s.code), watermarkEnabled: true });
    expect(wm).toMatchObject({ verdict: "RELATED_COMPARE", path: "watermark", stampId: s.stampId });
    const resized = new Uint8Array(await sharp(orig).resize(480).jpeg({ quality: 60 }).toBuffer());
    const p = await verify(resized);
    expect(p).toMatchObject({ verdict: "RELATED_COMPARE", path: "perceptual" });
    expect(p?.candidates?.[0]?.stampId).toBe(s.stampId);
    expect(p?.diff?.path && existsSync(p.diff.path)).toBe(true);
    expect(await verify(noise)).toMatchObject({ verdict: "NOT_REGISTERED", path: "none" });
  }, 60_000);

  it("never auto-picks among candidates within 5 bits", async () => {
    q = createMemoryQueue("worker");
    const img = await makeJpeg(640, 480, 12);
    const twin = new Uint8Array(
      await sharp(img)
        .jpeg({ quality: 85 })
        .withExif({ IFD0: { Orientation: "1" } })
        .toBuffer(),
    );
    const a = await seedStamp(db, cfg, img);
    const b = await seedStamp(db, cfg, twin);
    await handleMark(deps(), { stampId: a.stampId });
    await handleMark(deps(), { stampId: b.stampId });
    const r = await verify(
      new Uint8Array(await sharp(img).resize(500).jpeg({ quality: 50 }).toBuffer()),
    );
    expect(r?.verdict).toBe("RELATED_COMPARE");
    expect(r?.stampId).toBeUndefined();
    expect(r?.candidates?.map((c) => c.stampId).sort()).toEqual(
      expect.arrayContaining([a.stampId, b.stampId].sort()),
    );
  }, 60_000);
});

d("monitors", () => {
  it("pdp-monitor upserts data_sets and posts ntfy on pdpEndEpoch≠0 and overdue proving", async () => {
    q = createMemoryQueue("worker");
    const h = (id: bigint, o: Partial<DataSetHealth>): DataSetHealth => ({
      dataSetId: id,
      live: true,
      listenerIsFwss: true,
      lastProvenEpoch: 900n,
      nextChallengeEpoch: 1100n,
      provenThisPeriod: true,
      provingDeadline: 1200n,
      pdpEndEpoch: 0n,
      lifecycleReserve: 5n,
      providerId: id,
      viewOk: true,
      ...o,
    });
    const foc = {
      dataSetHealth: async (ds: DataSetRole) =>
        ds === "A"
          ? h(1n, { pdpEndEpoch: 7n })
          : h(2n, { provenThisPeriod: false, provingDeadline: 10n }),
    } as unknown as FocStore;
    const dep = deps({ foc });
    await handlePdpMonitor(dep);
    const r2 = await handlePdpMonitor(dep);
    const msgs = dep.notices.map((n) => `${n.title}: ${n.message}`);
    expect(msgs.some((m) => m.includes("data set A") && m.includes("pdpEndEpoch is 7"))).toBe(true);
    expect(msgs.some((m) => m.includes("data set B") && m.includes("proving overdue"))).toBe(true);
    expect(r2[1]?.alerts.some((a) => a.includes("2 consecutive faults"))).toBe(true);
    const rows = await db.select().from(dataSets);
    expect(rows.map((r) => r.role).sort()).toEqual(["A", "B"]);
  });

  it("probe-sample enqueues probes for a 2 % sample (at least one)", async () => {
    q = createMemoryQueue("worker");
    const s = await seedStamp(db, cfg, await makeJpeg(200, 200, 13));
    await db
      .insert(bindings)
      .values({ stampId: hexToBytea(s.stampId), slot: 0, asset: 0, bindTx: hexToBytea(s.sha256) });
    expect(await handleProbeSample(deps())).toBeGreaterThanOrEqual(1);
    expect(pendingOf("probe").length).toBeGreaterThanOrEqual(1);
  });

  it("mirror-gc deletes local originals older than 30 d only when mirrored", async () => {
    q = createMemoryQueue("worker");
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const a = await seedStamp(db, cfg, await makeJpeg(200, 200, 14), { completedAt: old });
    const b = await seedStamp(db, cfg, await makeJpeg(200, 200, 15), { completedAt: old });
    const mirror = memoryMirror();
    await mirror.put(mirrorKey.original(a.sha256), readFileSync(a.path), "image/jpeg");
    const r = await handleMirrorGc(deps({ mirror }));
    expect(r.originals).toBe(1);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    void uploads;
  });
});
