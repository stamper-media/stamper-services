import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCode, type PieceCID, pieceCidBytes, pieceCidHex, pieceCidOf } from "@stamper/core";
import { nullWatermark, type PdqClient, type WatermarkClient } from "@stamper/marking";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import type { Hex } from "viem";
import { type AppConfig, loadConfig } from "../../src/config.js";
import {
  captures,
  type Db,
  derivatives,
  deviceKeys,
  stamps as stampsT,
  uploads,
} from "../../src/db/index.js";
import { stamps } from "../../src/db/repo/index.js";
import type { Queue } from "../../src/queue/port.js";
import { byteaToHex, hexToBytea } from "../../src/shared/index.js";
import { createLogger } from "../../src/shared/logger.js";
import type { ChainReads, Notice, WorkerDeps } from "../../src/worker/deps.js";
import { sha256Hex } from "../../src/worker/media.js";
import type { Mirror, MirrorBody } from "../../src/worker/mirror.js";
import { baseEnv } from "../foundation/env.js";

export const ZERO32 = `0x${"00".repeat(32)}` as Hex;
export const silentLog = createLogger({ role: "worker", level: "silent" });

export function tempDirs(): { staging: string; cache: string; root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "stamper-wp08-"));
  const staging = join(root, "staging");
  const cache = join(root, "cache");
  mkdirSync(staging);
  mkdirSync(cache);
  return { root, staging, cache, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function workerConfig(
  databaseUrl: string,
  dirs: { staging: string; cache: string },
  extra: Record<string, string> = {},
): AppConfig {
  return loadConfig(
    baseEnv("worker", {
      DATABASE_URL: databaseUrl,
      STAGING_DIR: dirs.staging,
      CACHE_DIR: dirs.cache,
      ...extra,
    }),
  );
}

/** A textured, EXIF-minimised JPEG (Orientation only) that decodes cleanly and has PDQ quality. */
export async function makeJpeg(
  w: number,
  h: number,
  seed = 1,
  orientation = 1,
): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const blk = (((x >> 5) * 7 + (y >> 5) * 13 + seed * 31) % 17) * 15;
      raw[i] = (x * 255) / w;
      raw[i + 1] = (y * 255) / h;
      raw[i + 2] = blk;
    }
  const b = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Orientation: String(orientation) } })
    .toBuffer();
  return new Uint8Array(b);
}

export const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A random 40-bit code that core can encode (some values need a reserved check symbol). */
export function randomCode(): bigint {
  for (;;) {
    const c = BigInt(`0x${randomBytes(5).toString("hex")}`);
    try {
      encodeCode(c);
      return c;
    } catch {
      /* draw again */
    }
  }
}

export type Seeded = {
  stampId: Hex;
  code: bigint;
  sha256: Hex;
  pieceCid: PieceCID;
  pieceCidHex: Hex;
  path: string;
};

/** Insert device key, capture, complete upload (file in staging) and a registered stamp. */
export async function seedStamp(
  db: Db,
  cfg: AppConfig,
  bytes: Uint8Array,
  o: {
    mediaKind?: 1 | 2;
    mime?: string;
    level?: number;
    status?: string;
    code?: bigint;
    completedAt?: Date;
  } = {},
): Promise<Seeded> {
  const stampId = `0x${randomBytes(32).toString("hex")}` as Hex;
  const keyId = randomBytes(32);
  const code = o.code ?? randomCode();
  const sha256 = sha256Hex(bytes);
  const cid = await pieceCidOf(bytes);
  const path = join(cfg.paths.staging, randomUUID());
  writeFileSync(path, bytes);
  await db.insert(deviceKeys).values({ keyId, platform: "ios", keyType: 1, level: o.level ?? 1 });
  const [cap] = await db
    .insert(captures)
    .values({ keyId, mediaKind: o.mediaKind ?? 1, stampId: hexToBytea(stampId), status: "claimed" })
    .returning({ id: captures.id });
  await db.insert(uploads).values({
    captureId: (cap as { id: string }).id,
    path,
    status: "complete",
    sha256: hexToBytea(sha256),
    totalSize: BigInt(bytes.byteLength),
    received: BigInt(bytes.byteLength),
    completedAt: o.completedAt ?? new Date(),
  });
  await db.insert(stampsT).values({
    stampId: hexToBytea(stampId),
    code,
    keyId,
    mediaKind: o.mediaKind ?? 1,
    mime: o.mime ?? (o.mediaKind === 2 ? "video/mp4" : "image/jpeg"),
    contentSha256: hexToBytea(sha256),
    pieceCid: Buffer.from(pieceCidBytes(cid)),
    status: o.status ?? "registered",
    level: o.level ?? 1,
    registeredEpoch: 10n,
  });
  return { stampId, code, sha256, pieceCid: cid, pieceCidHex: pieceCidHex(cid), path };
}

export type MemMirror = Mirror & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  log: string[];
};

export function memoryMirror(opts: { delayMs?: number; events?: string[] } = {}): MemMirror {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const log = opts.events ?? [];
  return {
    objects,
    log,
    async put(key: string, body: MirrorBody, contentType: string) {
      log.push(`mirror.put:start:${key}`);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(readFileSync(body.path));
      objects.set(key, { bytes, contentType });
      log.push(`mirror.put:done:${key}`);
      return { etag: "x" };
    },
    async head(key: string) {
      const o = objects.get(key);
      return o ? { size: o.bytes.byteLength, etag: null } : null;
    },
  };
}

/** aHash-style 256-bit stand-in for PDQ (16×16 grey vs mean) — only for tests without the ml sidecar. */
export const fakePdq: PdqClient = {
  async hash(image) {
    const px = await sharp(image)
      .autoOrient()
      .greyscale()
      .resize(16, 16, { fit: "fill" })
      .raw()
      .toBuffer();
    const mean = px.reduce((a, b) => a + b, 0) / px.length;
    const bits = new Uint8Array(32);
    for (let i = 0; i < 256; i++)
      if ((px[i] ?? 0) > mean) bits[i >> 3] = (bits[i >> 3] ?? 0) | (0x80 >> (i & 7));
    return { bits, quality: 100 };
  },
};

export function fakeWatermark(payload: bigint | null): WatermarkClient {
  return {
    encode: nullWatermark.encode,
    async decode() {
      return { ok: payload !== null, payload40: payload, schema: "BCH_SUPER" };
    },
  };
}

/** Registry reads answered from the DB rows (stands in for the chain in tests). */
export function chainFromDb(db: Db): ChainReads {
  return {
    async firstStampOf(sha) {
      const s = await stamps.bySha256(db, sha);
      return s ? byteaToHex(s.stampId) : ZERO32;
    },
    async stampByDerivativeHash(sha) {
      const [r] = await db
        .select({ stampId: derivatives.stampId })
        .from(derivatives)
        .where(and(eq(derivatives.sha256, hexToBytea(sha)), inArray(derivatives.kind, [1, 2])))
        .limit(1);
      return r ? byteaToHex(r.stampId) : ZERO32;
    },
    async stampByCode(code) {
      const s = await stamps.byCode(db, code);
      return s ? byteaToHex(s.stampId) : ZERO32;
    },
    async getStamp(id) {
      const s = await stamps.byId(db, id);
      if (!s?.contentSha256 || !s.pieceCid || s.code == null) return null;
      return {
        contentHash: byteaToHex(s.contentSha256),
        pieceCid: byteaToHex(s.pieceCid),
        code: s.code,
      };
    },
    blockNumber: async () => 1000n,
  };
}

export function makeDeps(
  base: { cfg: AppConfig; db: Db; queue: Queue },
  over: Partial<WorkerDeps> = {},
): WorkerDeps & { notices: Notice[] } {
  const notices: Notice[] = [];
  return {
    log: silentLog,
    foc: null,
    mirror: null,
    watermark: nullWatermark,
    watermarkEnabled: false,
    pdq: fakePdq,
    chain: chainFromDb(base.db),
    notify: async (n) => void notices.push(n),
    probeVideo: async () => {
      throw new Error("probeVideo not faked");
    },
    videoFrame: async () => makeJpeg(320, 240),
    fetch: globalThis.fetch,
    now: () => new Date(),
    ...base,
    ...over,
    notices,
  };
}
