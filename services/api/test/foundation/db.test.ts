/**
 * DB-backed foundation tests: migrations on a fresh pgvector/pgvector:pg17, schema snapshot,
 * repos (knn), the pg-boss queue adapter, and the two-role boot integration test.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDb,
  type Db,
  deviceKeys,
  migrate,
  stamps as stampsT,
} from "../../src/db/index.js";
import { challenges, renditions, stamps } from "../../src/db/repo/index.js";
import { boot } from "../../src/main.js";
import { createQueue } from "../../src/queue/pgboss.js";
import { type Queue, QueueRoleError } from "../../src/queue/port.js";
import { hexToBytea } from "../../src/shared/index.js";
import { createLogger } from "../../src/shared/logger.js";
import { baseEnv, secretFiles } from "./env.js";
import { freshDatabase, skipReason, startPg, stopPg } from "./pg.js";

const admin = await startPg();
if (!admin) console.warn(`[skip] DB tests: ${skipReason}`);
afterAll(stopPg);

const EXPECTED_TABLES = [
  "attestation_bundles",
  "bindings",
  "captures",
  "chain_txs",
  "challenges",
  "data_sets",
  "derivatives",
  "device_keys",
  "moderation",
  "renditions",
  "reports",
  "stamp_events",
  "stamps",
  "uploads",
  "users",
  "verifications",
  "verify_jobs",
];
const sid = (b: string) => `0x${b.repeat(32)}` as const;
const silent = createLogger({ role: "test", level: "silent" });

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!admin)("schema + repos", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb(await freshDatabase());
  });
  afterAll(async () => db && closeDb(db));

  it("migrations apply on a fresh database and are idempotent", async () => {
    await migrate(db);
    await migrate(db);
    const t = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema='public' order by 1`,
    );
    expect(t.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    const idx = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname='renditions_pdq_hnsw'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(/USING hnsw \(pdq bit_hamming_ops\)/);
    const ext = await db.execute(sql`select 1 from pg_extension where extname='vector'`);
    expect(ext.rowCount).toBe(1);
  });

  it("status check constraint rejects unknown states", async () => {
    await expect(
      db.insert(stampsT).values({ stampId: hexToBytea(sid("01")), status: "bogus" }),
    ).rejects.toThrow();
  });

  it("stamps repo and setStatus guard", async () => {
    await db
      .insert(deviceKeys)
      .values({ keyId: hexToBytea(sid("aa")), platform: "android", keyType: 1, level: 1 });
    await db
      .insert(stampsT)
      .values({ stampId: hexToBytea(sid("02")), code: 123n, keyId: hexToBytea(sid("aa")) });
    expect((await stamps.byCode(db, 123n))?.status).toBe("received");
    expect(await stamps.setStatus(db, sid("02"), "registered", { from: ["marked"] })).toBe(false);
    expect(await stamps.setStatus(db, sid("02"), "registering", { from: ["received"] })).toBe(true);
    expect((await stamps.byId(db, sid("02")))?.status).toBe("registering");
  });

  it("renditions.knn returns nearest by Hamming distance", async () => {
    const base = Buffer.alloc(32, 0);
    const flip = (n: number) => {
      const b = Buffer.from(base);
      for (let i = 0; i < n; i++) b[i >> 3] = (b[i >> 3] as number) | (0x80 >> (i & 7));
      return `0x${b.toString("hex")}` as const;
    };
    for (const [n, s] of [
      [40, "03"],
      [3, "04"],
      [10, "05"],
      [0, "06"],
    ] as const) {
      await renditions.insertPdq(db, { stampId: sid(s), variant: 0, pdq: flip(n) });
    }
    const hits = await renditions.knn(db, flip(1), 3);
    expect(hits.map((h) => [h.stampId, h.distance])).toEqual([
      [sid("06"), 1],
      [sid("04"), 2],
      [sid("05"), 9],
    ]);
    expect(await renditions.knn(db, flip(1), 10, 5)).toHaveLength(2);
  });

  it("challenges.consume is single-use and honours expiry", async () => {
    const c = await challenges.create(db, { kind: "enrol", value: sid("09"), ttlMs: 60_000 });
    expect(await challenges.consume(db, c.id, "enrol")).toBeDefined();
    expect(await challenges.consume(db, c.id, "enrol")).toBeUndefined();
    const old = await challenges.create(db, { kind: "enrol", value: sid("09"), ttlMs: -1 });
    expect(await challenges.consume(db, old.id)).toBeUndefined();
  });
});

describe.skipIf(!admin)("pg-boss queue adapter", () => {
  let url: string;
  let api: Queue;
  let worker: Queue;
  let probe: pg.Client;
  beforeAll(async () => {
    url = await freshDatabase();
    const opts = { log: silent, pollingIntervalSeconds: 0.5 };
    api = await createQueue(url, "api", opts);
    worker = await createQueue(url, "worker", opts);
    probe = new pg.Client({ connectionString: url });
    await probe.connect();
  }, 60_000);
  afterAll(async () => {
    await api?.stop();
    await worker?.stop();
    await probe?.end();
  });

  it("enforces JOB_ROLE", async () => {
    await expect(worker.work("register", async () => {})).rejects.toThrow(QueueRoleError);
    await expect(api.work("ingest", async () => {})).rejects.toThrow(QueueRoleError);
    await expect(api.schedule("mirror-gc", "30 4 * * *")).rejects.toThrow(QueueRoleError);
  });

  it("dedupes queued jobs by singleton key", async () => {
    expect(await api.enqueue("mark", { stampId: sid("11") })).toBeTypeOf("string");
    expect(await api.enqueue("mark", { stampId: sid("11") })).toBeNull();
    expect(await api.enqueue("mark", { stampId: sid("11") }, { singletonKey: "other" })).toBeTypeOf(
      "string",
    );
  });

  it("round-trips a job and retries a failure", async () => {
    const seen: number[] = [];
    await worker.work("store", async (p, job) => {
      expect(p.stampId).toBe(sid("12"));
      seen.push(job.attempt);
      if (job.attempt === 1) throw new Error("transient");
    });
    await api.enqueue(
      "store",
      { stampId: sid("12") },
      { retryLimit: 2, retryDelayMs: 1000, retryBackoff: false },
    );
    await until(async () => (seen.length >= 2 ? true : undefined));
    expect(seen).toEqual([1, 2]);
  }, 30_000);

  it("stats reports the runnable backlog per queue, ignoring delayed jobs", async () => {
    await api.enqueue("pdp-monitor", {});
    await api.enqueue("probe-sample", {}, { delayMs: 3_600_000 });
    await new Promise((r) => setTimeout(r, 1100));
    const st = (await worker.stats?.()) ?? [];
    const pdp = st.find((s) => s.name === "pdp-monitor");
    expect(pdp?.waiting).toBe(1);
    expect(pdp?.oldestAgeSeconds).toBeGreaterThanOrEqual(1);
    expect(st.find((s) => s.name === "probe-sample")).toBeUndefined();
  });

  it("schedule registers a cron for the owning role", async () => {
    await worker.schedule("mirror-gc", "30 4 * * *");
    const r = await probe.query("select name, cron from pgboss.schedule where name = 'mirror-gc'");
    expect(r.rows).toEqual([{ name: "mirror-gc", cron: "30 4 * * *" }]);
  });
});

describe.skipIf(!admin)("boot (integration): both roles", () => {
  it("api migrates, worker does not; a job enqueued by the api is consumed by the worker", async () => {
    const url = await freshDatabase();
    const dirs = { STAGING_DIR: mkdtempSync(join(tmpdir(), "stamper-wp06-st-")) };
    const workerEnv = baseEnv("worker", { DATABASE_URL: url, SCHEMA_WAIT_MS: "300", ...dirs });
    const apiEnv = baseEnv("api", { DATABASE_URL: url, ...secretFiles(), ...dirs });

    // The worker never migrates: on an empty database it refuses to start.
    await expect(boot(workerEnv, { log: silent })).rejects.toThrow(/schema not ready/);

    const a = await boot(apiEnv, {
      log: silent,
      start: async (ctx) => {
        ctx.http.get("/v1/ping", (c) => c.text("pong"));
      },
    });
    const w = await boot(
      { ...workerEnv, SCHEMA_WAIT_MS: "5000" },
      {
        log: silent,
        start: async (ctx) => {
          await ctx.queue.work("ingest", async (p) => {
            await ctx.db.execute(
              sql`insert into stamp_events (stamp_id, kind, actor) values (${hexToBytea(p.stampId)}, 'ingested', 'worker')`,
            );
          });
        },
      },
    );
    try {
      for (const r of [a, w]) {
        const h = await fetch(`http://127.0.0.1:${r.port}/healthz`);
        expect(h.status).toBe(200);
        expect(await h.json()).toMatchObject({ ok: true, role: r.ctx.cfg.role });
        const m = await (await fetch(`http://127.0.0.1:${r.port}/metrics`)).text();
        expect(m).toContain(`role="${r.ctx.cfg.role}"`);
      }
      expect(await (await fetch(`http://127.0.0.1:${a.port}/v1/ping`)).text()).toBe("pong");

      await a.ctx.queue.enqueue("ingest", { stampId: sid("21") });
      const row = await until(async () => {
        const r = await a.ctx.db.execute<{ kind: string }>(
          sql`select kind from stamp_events where actor = 'worker'`,
        );
        return r.rows[0];
      });
      expect(row.kind).toBe("ingested");
      const m = await (await fetch(`http://127.0.0.1:${w.port}/metrics`)).text();
      expect(m).toMatch(/stamper_jobs_total\{name="ingest",outcome="ok",role="worker"\} 1/);
    } finally {
      await w.close();
      await a.close();
    }
  }, 60_000);
});
