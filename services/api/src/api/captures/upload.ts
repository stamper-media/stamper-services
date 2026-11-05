import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parsePieceCid, pieceCidHasher, pieceCidHex, pieceCidString } from "@stamper/core";
import { eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { AppConfig } from "../../config.js";
import { captures as capturesT, type Db, uploads as uploadsT } from "../../db/index.js";
import { uploads } from "../../db/repo/index.js";
import { byteaToHex } from "../../shared/index.js";
import { ApiError } from "../errors.js";

export type UploadDone = { sha256: Hex; pieceCid: string; pieceCidHex: Hex; size: bigint };
export type PutResult =
  | { kind: "partial"; received: bigint; total: bigint }
  | ({ kind: "complete" } & UploadDone);

type HashState = { received: bigint; sha: Hash; piece: ReturnType<typeof pieceCidHasher> };

export function parseContentRange(h: string | undefined): {
  start: bigint;
  end: bigint;
  total: bigint;
} {
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(h?.trim() ?? "");
  if (!m)
    throw new ApiError(400, "BadRange", { reason: "Content-Range: bytes a-b/total required" });
  const [start, end, total] = [
    BigInt(m[1] as string),
    BigInt(m[2] as string),
    BigInt(m[3] as string),
  ];
  if (end < start || end >= total)
    throw new ApiError(416, "BadRange", { reason: "unsatisfiable range" });
  return { start, end, total };
}

const rangeHeader = (received: bigint): Record<string, string> =>
  received > 0n ? { range: `bytes=0-${received - 1n}` } : {};

/**
 * Sequential resumable uploads into STAGING_DIR. The sha256 and the PieceCID are teed while the
 * bytes are written; the hash state lives in memory and is rebuilt from the staged prefix after a
 * restart. One request per upload at a time (in-process lock + compare-and-set on `received`).
 */
export class UploadManager {
  private readonly states = new Map<string, HashState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly s: { db: Db; cfg: AppConfig }) {}

  private async row(uploadId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new ApiError(404, "NotFound");
    const [r] = await this.s.db
      .select({ u: uploadsT, mediaKind: capturesT.mediaKind, expectedSize: capturesT.expectedSize })
      .from(uploadsT)
      .innerJoin(capturesT, eq(capturesT.id, uploadsT.captureId))
      .where(eq(uploadsT.id, uploadId))
      .limit(1);
    if (!r) throw new ApiError(404, "NotFound");
    return r;
  }

  async head(
    uploadId: string,
  ): Promise<{ received: bigint; total: bigint | null; complete: boolean }> {
    const { u } = await this.row(uploadId);
    return { received: u.received, total: u.totalSize, complete: u.status === "complete" };
  }

  headers(h: { received: bigint; total: bigint | null }): Record<string, string> {
    return {
      ...rangeHeader(h.received),
      ...(h.total !== null ? { "upload-length": h.total.toString() } : {}),
    };
  }

  put(
    uploadId: string,
    contentRange: string | undefined,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PutResult> {
    const prev = this.locks.get(uploadId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.putLocked(uploadId, contentRange, body));
    const tail = run.catch(() => undefined);
    this.locks.set(uploadId, tail);
    void tail.then(() => {
      if (this.locks.get(uploadId) === tail) this.locks.delete(uploadId);
    });
    return run;
  }

  private async rebuild(path: string, received: bigint): Promise<HashState> {
    const st: HashState = { received: 0n, sha: createHash("sha256"), piece: pieceCidHasher() };
    if (received === 0n) return st;
    const size = await stat(path).then(
      (s) => BigInt(s.size),
      () => 0n,
    );
    if (size < received)
      throw new ApiError(409, "StagingLost", { reason: "staged prefix missing; restart upload" });
    for await (const chunk of createReadStream(path, { start: 0, end: Number(received) - 1 })) {
      const b = chunk as Buffer;
      st.sha.update(b);
      st.piece.write(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    }
    st.received = received;
    return st;
  }

  private async putLocked(
    uploadId: string,
    cr: string | undefined,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PutResult> {
    const { start, end, total } = parseContentRange(cr);
    const { u, mediaKind, expectedSize } = await this.row(uploadId);
    if (u.status === "complete") {
      if (end + 1n === u.totalSize && u.sha256 && u.pieceCid)
        return { kind: "complete", ...this.done(u.sha256, u.pieceCid, u.totalSize) };
      throw new ApiError(409, "UploadClosed", {}, rangeHeader(u.received));
    }
    if (u.status !== "open") throw new ApiError(409, "UploadClosed");
    const max = BigInt(
      mediaKind === 2 ? this.s.cfg.limits.maxVideoBytes : this.s.cfg.limits.maxImageBytes,
    );
    if (total > max) throw new ApiError(413, "LengthOutOfBounds", { max: max.toString() });
    if (expectedSize !== null && total !== expectedSize)
      throw new ApiError(400, "BadRange", { reason: "total differs from expectedSize" });
    if (u.totalSize !== null && u.totalSize !== total)
      throw new ApiError(400, "BadRange", { reason: "total changed" });
    if (start !== u.received) {
      throw new ApiError(
        409,
        "RangeGap",
        { received: u.received.toString() },
        rangeHeader(u.received),
      );
    }
    if (u.totalSize === null) {
      await this.s.db
        .update(uploadsT)
        .set({ totalSize: total, updatedAt: sql`now()` })
        .where(eq(uploadsT.id, uploadId));
    }

    let st = this.states.get(uploadId);
    if (!st || st.received !== u.received) st = await this.rebuild(u.path, u.received);
    this.states.delete(uploadId);

    await mkdir(dirname(u.path), { recursive: true });
    const fh = await open(u.path, u.received === 0n ? "w+" : "r+");
    const want = end - start + 1n;
    let got = 0n;
    try {
      await fh.truncate(Number(start));
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (got + BigInt(value.byteLength) > want) {
            await reader.cancel().catch(() => undefined);
            throw new ApiError(400, "BadRange", { reason: "body longer than Content-Range" });
          }
          await fh.write(value, 0, value.byteLength, Number(start + got));
          got += BigInt(value.byteLength);
        }
      }
      if (got !== want)
        throw new ApiError(400, "BadRange", { reason: "body shorter than Content-Range" });
    } catch (e) {
      await fh.truncate(Number(start)).catch(() => undefined);
      await fh.close();
      throw e;
    }
    await fh.close();

    // tee the hashes only after the chunk is fully on disk (a failed chunk leaves the state untouched)
    for await (const chunk of createReadStream(u.path, {
      start: Number(start),
      end: Number(end),
    })) {
      const b = chunk as Buffer;
      st.sha.update(b);
      st.piece.write(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    }
    st.received = end + 1n;
    if (!(await uploads.advance(this.s.db, uploadId, start, st.received))) {
      throw new ApiError(409, "RangeGap", {}, rangeHeader(start));
    }
    if (st.received < total) {
      this.states.set(uploadId, st);
      return { kind: "partial", received: st.received, total };
    }
    const sha256: Hex = `0x${st.sha.digest("hex")}`;
    const cid = st.piece.finalize();
    const cidHex = pieceCidHex(cid);
    await uploads.complete(this.s.db, uploadId, sha256, cidHex);
    await this.s.db
      .update(capturesT)
      .set({ status: "uploaded" })
      .where(eq(capturesT.id, u.captureId));
    return {
      kind: "complete",
      sha256,
      pieceCid: pieceCidString(cid),
      pieceCidHex: cidHex,
      size: total,
    };
  }

  private done(sha: Uint8Array, cid: Uint8Array, size: bigint): UploadDone {
    const cidHex = byteaToHex(cid);
    return {
      sha256: byteaToHex(sha),
      pieceCid: pieceCidStringFromHex(cidHex),
      pieceCidHex: cidHex,
      size,
    };
  }
}

export const pieceCidStringFromHex = (h: Hex): string => pieceCidString(parsePieceCid(h));
