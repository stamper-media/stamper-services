/** Shared constants and helpers for both roles (no secrets, no role-specific code). */
import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import type { Hex } from "viem";

/** Stamp lifecycle (DESIGN §9.3 stamps.status). */
export const STATUS = [
  "received",
  "registering",
  "registered",
  "rejected",
  "marked",
  "stored",
  "withdrawn",
  "takedown",
] as const;
export type Status = (typeof STATUS)[number];

/** Chain finality of a stamp's registration (mirrors core finalityState). */
export const FINALITY = ["pending", "included", "safe", "final"] as const;
export type Finality = (typeof FINALITY)[number];

export const isStatus = (v: unknown): v is Status =>
  typeof v === "string" && (STATUS as readonly string[]).includes(v);
export const isFinality = (v: unknown): v is Finality =>
  typeof v === "string" && (FINALITY as readonly string[]).includes(v);

/** Rate limits of DESIGN §11.2, requests per minute per IP. Mirrored in the mobile back-off. */
export const CODE_LOOKUP_RATE = 60;
export const VERIFY_UPLOAD_RATE = 10;
export const RATE_WINDOW_MS = 60_000;
/** Enrolment cap: at most this many device keys per account per ENROL_WINDOW_DAYS. */
export const ENROL_MAX_KEYS = 3;
export const ENROL_WINDOW_DAYS = 30;

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isHex(v: unknown): v is Hex {
  return typeof v === "string" && HEX_RE.test(v);
}
export function isBytes32(v: unknown): v is Hex {
  return typeof v === "string" && BYTES32_RE.test(v);
}

/** 0x-prefixed even-length hex → Buffer for bytea columns. Throws on malformed input. */
export function hexToBytea(h: Hex): Buffer {
  if (!isHex(h)) throw new TypeError(`not an even-length 0x hex string: ${String(h).slice(0, 20)}`);
  return Buffer.from(h.slice(2), "hex");
}

/** bytea Buffer → lowercase 0x hex. */
export function byteaToHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex")}`;
}

/** PDQ hash (32 bytes, 0x hex) → pgvector bit(256) literal ('0101…', MSB first). */
export function pdqHexToBits(h: Hex): string {
  if (!isBytes32(h)) throw new TypeError("PDQ hash must be 32 bytes of 0x hex");
  let out = "";
  for (const byte of hexToBytea(h)) out += byte.toString(2).padStart(8, "0");
  return out;
}

/** pgvector bit(256) literal → 0x hex. */
export function pdqBitsToHex(bits: string): Hex {
  if (!/^[01]{256}$/.test(bits)) throw new TypeError("expected 256 bits");
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return byteaToHex(bytes);
}

type PathCfg = { paths: { staging: string; cache: string } };

/** STAGING_DIR/<uploadId>; uploadId must be a UUID (no traversal). */
export function stagingPath(cfg: PathCfg, uploadId: string): string {
  if (!UUID_RE.test(uploadId)) throw new TypeError("uploadId must be a UUID");
  return join(resolve(cfg.paths.staging), uploadId.toLowerCase());
}

/** CACHE_DIR/<aa>/<stampId hex>/<variant>, e.g. variant "share.jpg" or "original". */
export function cachePath(cfg: PathCfg, stampId: Hex, variant: string): string {
  if (!isBytes32(stampId)) throw new TypeError("stampId must be bytes32 hex");
  if (!VARIANT_RE.test(variant) || variant.includes("..")) {
    throw new TypeError(`bad cache variant: ${variant}`);
  }
  const h = stampId.slice(2).toLowerCase();
  return join(resolve(cfg.paths.cache), h.slice(0, 2), h, variant);
}

export type Sha256Tee = {
  /** Pass-through stream; pipe the bytes through it. */
  stream: Transform;
  /** Digest as 0x hex; throws if the stream has not finished. */
  digest(): Hex;
  /** Bytes seen so far. */
  bytes(): number;
};

/** A pass-through Transform that hashes everything flowing through it. */
export function sha256Stream(): Sha256Tee {
  const h = createHash("sha256");
  let n = 0;
  let done: Hex | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      h.update(chunk);
      n += chunk.length;
      cb(null, chunk);
    },
    flush(cb: TransformCallback) {
      done = `0x${h.digest("hex")}`;
      cb();
    },
  });
  return {
    stream,
    digest() {
      if (done === null) throw new Error("sha256Stream: stream not finished");
      return done;
    },
    bytes: () => n,
  };
}

/**
 * Open a byte range [start, end] (inclusive, HTTP Range semantics) of a file.
 * `end` defaults to the last byte. Throws RangeError when unsatisfiable.
 */
export async function readRange(
  path: string,
  start = 0,
  end?: number,
): Promise<{ stream: ReadStream; start: number; end: number; size: number }> {
  const { size } = await stat(path);
  const last = end ?? size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start < 0) {
    throw new RangeError("range bounds must be non-negative integers");
  }
  if (size === 0 || start > last || last >= size) {
    throw new RangeError(`unsatisfiable range ${start}-${last} of ${size}`);
  }
  return { stream: createReadStream(path, { start, end: last }), start, end: last, size };
}
