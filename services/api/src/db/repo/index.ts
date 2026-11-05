/**
 * Thin typed queries shared by both roles. Every function takes the Db (or a transaction)
 * first. Hex in, Hex out at the boundary; bytea stays internal.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  byteaToHex,
  hexToBytea,
  pdqBitsToHex,
  pdqHexToBits,
  type Status,
} from "../../shared/index.js";
import type { Db } from "../index.js";
import {
  bindings as bindingsT,
  chainTxs as chainTxsT,
  challenges as challengesT,
  renditions as renditionsT,
  stampEvents as stampEventsT,
  stamps as stampsT,
  uploads as uploadsT,
  verifyJobs as verifyJobsT,
} from "../schema.js";

export type Tx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export type StampRow = typeof stampsT.$inferSelect;
export type BindingRow = typeof bindingsT.$inferSelect;
export type ChainTxRow = typeof chainTxsT.$inferSelect;
export type ChallengeRow = typeof challengesT.$inferSelect;
export type UploadRow = typeof uploadsT.$inferSelect;
export type VerifyJobRow = typeof verifyJobsT.$inferSelect;

export const stamps = {
  async byId(db: Tx, stampId: Hex): Promise<StampRow | undefined> {
    const [r] = await db
      .select()
      .from(stampsT)
      .where(eq(stampsT.stampId, hexToBytea(stampId)))
      .limit(1);
    return r;
  },
  async byCode(db: Tx, code: bigint): Promise<StampRow | undefined> {
    const [r] = await db.select().from(stampsT).where(eq(stampsT.code, code)).limit(1);
    return r;
  },
  async bySha256(db: Tx, sha256: Hex): Promise<StampRow | undefined> {
    const [r] = await db
      .select()
      .from(stampsT)
      .where(eq(stampsT.contentSha256, hexToBytea(sha256)))
      .limit(1);
    return r;
  },
  /** Transition status; with `from`, only when the current status is one of them. Returns true if a row changed. */
  async setStatus(
    db: Tx,
    stampId: Hex,
    to: Status,
    opts: { from?: readonly Status[] } = {},
  ): Promise<boolean> {
    const where = opts.from?.length
      ? and(eq(stampsT.stampId, hexToBytea(stampId)), inArray(stampsT.status, [...opts.from]))
      : eq(stampsT.stampId, hexToBytea(stampId));
    const r = await db
      .update(stampsT)
      .set({ status: to })
      .where(where)
      .returning({ s: stampsT.stampId });
    return r.length > 0;
  },
};

export const bindings = {
  async upsert(db: Tx, row: typeof bindingsT.$inferInsert): Promise<void> {
    const { stampId: _s, slot: _l, ...rest } = row;
    await db
      .insert(bindingsT)
      .values(row)
      .onConflictDoUpdate({ target: [bindingsT.stampId, bindingsT.slot], set: rest });
  },
  async forStamp(db: Tx, stampId: Hex): Promise<BindingRow[]> {
    return db
      .select()
      .from(bindingsT)
      .where(eq(bindingsT.stampId, hexToBytea(stampId)))
      .orderBy(asc(bindingsT.slot));
  },
};

export type KnnHit = { id: number; stampId: Hex; variant: number; pdq: Hex; distance: number };

export const renditions = {
  async insertPdq(
    db: Tx,
    r: {
      stampId: Hex;
      derivativeId?: number | null;
      variant: number;
      pdq: Hex;
      quality?: number | null;
    },
  ): Promise<number> {
    if (!Number.isInteger(r.variant) || r.variant < 0 || r.variant > 9)
      throw new RangeError("variant must be 0-9");
    const [row] = await db
      .insert(renditionsT)
      .values({
        stampId: hexToBytea(r.stampId),
        derivativeId: r.derivativeId ?? null,
        variant: r.variant,
        pdq: pdqHexToBits(r.pdq),
        pdqQuality: r.quality ?? null,
      })
      .returning({ id: renditionsT.id });
    if (!row) throw new Error("insert returned no row");
    return row.id;
  },
  /** k nearest renditions by Hamming distance (pgvector `<~>`, HNSW bit_hamming_ops). */
  async knn(db: Tx, pdq: Hex, k: number, maxDistance?: number): Promise<KnnHit[]> {
    if (!Number.isInteger(k) || k < 1 || k > 1000) throw new RangeError("k must be 1-1000");
    const bits = pdqHexToBits(pdq);
    const dist = sql<number>`(${renditionsT.pdq} <~> ${bits}::bit(256))`;
    const rows = await db
      .select({
        id: renditionsT.id,
        stampId: renditionsT.stampId,
        variant: renditionsT.variant,
        pdq: renditionsT.pdq,
        distance: dist.mapWith(Number),
      })
      .from(renditionsT)
      .where(maxDistance === undefined ? undefined : lte(dist, maxDistance))
      .orderBy(dist)
      .limit(k);
    return rows.map((r) => ({
      id: r.id,
      stampId: byteaToHex(r.stampId),
      variant: r.variant,
      pdq: pdqBitsToHex(r.pdq),
      distance: r.distance,
    }));
  },
};

export const chainTxs = {
  async outboxInsert(
    db: Tx,
    t: {
      hash: Hex;
      kind: string;
      stampId?: Hex | null;
      sender?: Hex | null;
      nonce?: bigint | null;
    },
  ): Promise<void> {
    await db
      .insert(chainTxsT)
      .values({
        hash: hexToBytea(t.hash),
        kind: t.kind,
        stampId: t.stampId ? hexToBytea(t.stampId) : null,
        sender: t.sender ? hexToBytea(t.sender) : null,
        nonce: t.nonce ?? null,
      })
      .onConflictDoNothing();
  },
  /** Transactions not yet final, oldest first (consumed by the api's receipt/finality loops). */
  async outboxPending(db: Tx, limit = 100): Promise<ChainTxRow[]> {
    return db
      .select()
      .from(chainTxsT)
      .where(inArray(chainTxsT.status, ["submitted", "included", "safe"]))
      .orderBy(asc(chainTxsT.submittedAt))
      .limit(limit);
  },
  async outboxUpdate(
    db: Tx,
    hash: Hex,
    patch: Partial<Pick<ChainTxRow, "status" | "includedEpoch" | "safeAt" | "finalAt" | "error">>,
  ): Promise<void> {
    await db
      .update(chainTxsT)
      .set(patch)
      .where(eq(chainTxsT.hash, hexToBytea(hash)));
  },
};

export const challenges = {
  async create(
    db: Tx,
    c: { kind: string; value: Hex; keyId?: Hex | null; ttlMs: number },
  ): Promise<ChallengeRow> {
    const [row] = await db
      .insert(challengesT)
      .values({
        kind: c.kind,
        value: hexToBytea(c.value),
        keyId: c.keyId ? hexToBytea(c.keyId) : null,
        expiresAt: new Date(Date.now() + c.ttlMs),
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  },
  /** Atomically mark a live, unused challenge as used; undefined if expired, used or unknown. */
  async consume(db: Tx, id: string, kind?: string): Promise<ChallengeRow | undefined> {
    const conds = [
      eq(challengesT.id, id),
      isNull(challengesT.usedAt),
      sql`${challengesT.expiresAt} > now()`,
    ];
    if (kind) conds.push(eq(challengesT.kind, kind));
    const [row] = await db
      .update(challengesT)
      .set({ usedAt: sql`now()` })
      .where(and(...conds))
      .returning();
    return row;
  },
};

export const uploads = {
  async create(
    db: Tx,
    u: { captureId: string; path: string; totalSize?: bigint | null; id?: string },
  ): Promise<UploadRow> {
    const [row] = await db
      .insert(uploadsT)
      .values({
        ...(u.id ? { id: u.id } : {}),
        captureId: u.captureId,
        path: u.path,
        totalSize: u.totalSize ?? null,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  },
  async get(db: Tx, id: string): Promise<UploadRow | undefined> {
    const [r] = await db.select().from(uploadsT).where(eq(uploadsT.id, id)).limit(1);
    return r;
  },
  /** Advance `received` only if it still equals `expectedReceived` (sequential writes). */
  async advance(
    db: Tx,
    id: string,
    expectedReceived: bigint,
    newReceived: bigint,
  ): Promise<boolean> {
    const r = await db
      .update(uploadsT)
      .set({ received: newReceived, updatedAt: sql`now()` })
      .where(
        and(
          eq(uploadsT.id, id),
          eq(uploadsT.received, expectedReceived),
          eq(uploadsT.status, "open"),
        ),
      )
      .returning({ id: uploadsT.id });
    return r.length > 0;
  },
  async complete(db: Tx, id: string, sha256: Hex, pieceCid: Hex): Promise<boolean> {
    const r = await db
      .update(uploadsT)
      .set({
        status: "complete",
        sha256: hexToBytea(sha256),
        pieceCid: hexToBytea(pieceCid),
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(uploadsT.id, id), eq(uploadsT.status, "open")))
      .returning({ id: uploadsT.id });
    return r.length > 0;
  },
};

export const verifyJobs = {
  async create(
    db: Tx,
    j: {
      path: string;
      mime?: string | null;
      size?: bigint | null;
      ipHash?: Hex | null;
      id?: string;
    },
  ): Promise<VerifyJobRow> {
    const [row] = await db
      .insert(verifyJobsT)
      .values({
        ...(j.id ? { id: j.id } : {}),
        path: j.path,
        mime: j.mime ?? null,
        size: j.size ?? null,
        ipHash: j.ipHash ? hexToBytea(j.ipHash) : null,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  },
  async get(db: Tx, id: string): Promise<VerifyJobRow | undefined> {
    const [r] = await db.select().from(verifyJobsT).where(eq(verifyJobsT.id, id)).limit(1);
    return r;
  },
  async start(db: Tx, id: string): Promise<boolean> {
    const r = await db
      .update(verifyJobsT)
      .set({ status: "running", startedAt: sql`now()` })
      .where(and(eq(verifyJobsT.id, id), inArray(verifyJobsT.status, ["queued", "running"])))
      .returning({ id: verifyJobsT.id });
    return r.length > 0;
  },
  async finish(db: Tx, id: string, out: { result: unknown } | { error: string }): Promise<void> {
    await db
      .update(verifyJobsT)
      .set(
        "error" in out
          ? { status: "failed", error: out.error, finishedAt: sql`now()` }
          : { status: "done", result: out.result, finishedAt: sql`now()` },
      )
      .where(eq(verifyJobsT.id, id));
  },
};

export const stampEvents = {
  async append(
    db: Tx,
    e: { stampId?: Hex | null; kind: string; actor: string; data?: unknown },
  ): Promise<void> {
    await db.insert(stampEventsT).values({
      stampId: e.stampId ? hexToBytea(e.stampId) : null,
      kind: e.kind,
      actor: e.actor,
      data: e.data ?? null,
    });
  },
};
