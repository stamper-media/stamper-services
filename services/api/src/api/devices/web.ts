/**
 * WP-14 web capture (DESIGN §7.3, ADR-022): browser keys are non-extractable WebCrypto P-256 keys
 * (KT_P256_RAW) registered at level 0 with a proof of possession and no endorsement. Flag-gated by
 * WEB_CAPTURE=1. Captures from web keys use the ordinary /v1/captures flow with attestation "none";
 * this router only adds the enrolment endpoint and the strict daily quotas.
 */
import { encodeRegisterKey } from "@stamper/contracts-abi";
import {
  hashKeyPossession,
  type KeyEnrolment,
  KT,
  keyIdFromP256,
  PF,
  verifyDeviceSignature,
} from "@stamper/core";
import { and, eq, gte, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { attestationBundles, captures, deviceKeys } from "../../db/index.js";
import { hexToBytea } from "../../shared/index.js";
import { makeBundle } from "../attest/bundle.js";
import { consumeChallenge } from "../attest/challenge.js";
import { TxRevertedError } from "../chain.js";
import { seal } from "../crypto.js";
import { KEY_LIFETIME_S } from "../devices.js";
import { ApiError } from "../errors.js";
import { keyRow } from "../keys.js";
import { rateLimit, TokenBuckets } from "../ratelimit.js";
import { bytes32, hexStr } from "../schemas.js";
import type { Services } from "../services.js";
import { clientIp, lowerEq } from "../util.js";

/** Strictest quotas (DESIGN §7.3): per web key and per client IP, rolling 24 h. */
export const WEB_CAPTURES_PER_DAY = 10;
export const WEB_CAPTURES_PER_IP_PER_DAY = 30;
export const WEB_ENROLS_PER_IP_PER_DAY = 5;
const DAY_MS = 86_400_000;
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";

export const WebEnrolBody = z
  .object({
    keyId: bytes32,
    x: bytes32,
    y: bytes32,
    /** 64-byte r‖s (low-s) over sha256(KeyPossession digest), from WebCrypto ECDSA-SHA256. */
    popSig: hexStr,
    challengeId: z.string().uuid(),
    appInfo: z.object({
      id: z.string().max(200),
      version: z.string().max(50),
      build: z.string().max(50),
    }),
  })
  .strict();
export type WebEnrolInput = z.output<typeof WebEnrolBody>;

/** Rolling-window counter (in memory, per process). */
export class DailyCounter {
  private readonly m = new Map<string, number[]>();
  constructor(
    private readonly now: () => number,
    private readonly windowMs = DAY_MS,
  ) {}
  /** Records one hit when under `limit`; returns retry-after seconds when over it. */
  take(key: string, limit: number): { ok: boolean; retryAfterS: number } {
    const t = this.now();
    const hits = (this.m.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (hits.length >= limit) {
      this.m.set(key, hits);
      const oldest = hits[0] ?? t;
      return {
        ok: false,
        retryAfterS: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)),
      };
    }
    hits.push(t);
    this.m.set(key, hits);
    if (this.m.size > 50_000) {
      for (const [k, v] of this.m) if (v.every((h) => t - h >= this.windowMs)) this.m.delete(k);
    }
    return { ok: true, retryAfterS: 0 };
  }
}

function quotaError(retryAfterS: number): ApiError {
  return new ApiError(
    429,
    "QuotaExceeded",
    { retryAfter: retryAfterS },
    { "retry-after": String(retryAfterS) },
  );
}

/** Enrols a browser key at level 0 (KT_P256_RAW, PF.WEB, no endorsement). */
export async function enrolWebKey(
  s: Services,
  b: WebEnrolInput,
  userAgent: string | undefined,
): Promise<{ keyId: Hex; level: 0; txHash: Hex; status: "registering" }> {
  if (!lowerEq(keyIdFromP256(b.x, b.y), b.keyId)) throw new ApiError(400, "KeyIdMismatch");
  const popDigest = hashKeyPossession(s.domain, {
    keyId: b.keyId,
    keyType: KT.P256_RAW,
    platform: PF.WEB,
    x: b.x,
    y: b.y,
    addr: ZERO_ADDR,
  });
  let popOk = false;
  try {
    popOk = verifyDeviceSignature(
      { keyType: KT.P256_RAW, x: b.x, y: b.y },
      popDigest,
      b.popSig,
      "0x",
      0n,
    );
  } catch {
    popOk = false;
  }
  if (!popOk) throw new ApiError(400, "BadSig", { reason: "proof of possession" });
  if (await keyRow(s.db, b.keyId)) throw new ApiError(409, "KeyExists");
  if (!(await consumeChallenge(s.db, b.challengeId, "enrol")))
    throw new ApiError(400, "ChallengeInvalid");

  const wrap = s.cfg.secrets.recordWrapKey;
  if (!wrap) throw new ApiError(503, "NotConfigured", { reason: "RECORD_WRAP_KEY" });
  const { bundle, bundleHash } = makeBundle({
    kind: "none",
    platform: "web",
    appInfo: b.appInfo,
    userAgent: (userAgent ?? "").slice(0, 300),
  });
  const enc = seal(
    wrap,
    new TextEncoder().encode(
      JSON.stringify({ bundle: Buffer.from(bundle).toString("base64"), appInfo: b.appInfo }),
    ),
  );

  const enrolment: KeyEnrolment = {
    keyId: b.keyId,
    keyType: KT.P256_RAW,
    platform: PF.WEB,
    level: 0,
    x: b.x,
    y: b.y,
    addr: ZERO_ADDR,
    rpIdHash: ZERO32,
    attestationHash: bundleHash,
    expiresAt: BigInt(Math.floor(s.now() / 1000)) + KEY_LIFETIME_S,
  };
  let sent: Awaited<ReturnType<typeof s.relayer.send>>;
  try {
    sent = await s.relayer.send("registerKey", {
      to: s.cfg.chain.registry,
      data: encodeRegisterKey({ enrolment, popSig: b.popSig, endorsement: "0x" }),
    });
  } catch (e) {
    if (e instanceof TxRevertedError)
      throw new ApiError(422, "EnrolRejected", { reason: e.reason });
    throw e;
  }

  await s.db.transaction(async (tx) => {
    await tx.insert(deviceKeys).values({
      keyId: hexToBytea(b.keyId),
      platform: "web",
      keyType: KT.P256_RAW,
      level: 0,
      addr: null,
      pubX: hexToBytea(b.x),
      pubY: hexToBytea(b.y),
      rpIdHash: null,
      attestationHash: hexToBytea(bundleHash),
      registeredTx: hexToBytea(sent.hash),
      expiresAt: new Date(Number(enrolment.expiresAt) * 1000),
    });
    await tx.insert(attestationBundles).values({
      keyId: hexToBytea(b.keyId),
      kind: "enrol",
      platform: "web",
      sha256: hexToBytea(bundleHash),
      iv: enc.iv,
      ciphertext: enc.ciphertext,
    });
  });

  void sent
    .wait()
    .then((r) =>
      s.db
        .update(deviceKeys)
        .set({ registeredEpoch: r.blockNumber })
        .where(eq(deviceKeys.keyId, hexToBytea(b.keyId))),
    )
    .catch((e: unknown) => s.log.error({ err: e, keyId: b.keyId }, "web registerKey failed"));

  return { keyId: b.keyId, level: 0, txHash: sent.hash, status: "registering" };
}

/** Number of captures opened by `keyId` in the last 24 h. */
export async function capturesLastDay(s: Services, keyId: Hex): Promise<number> {
  const since = new Date(s.now() - DAY_MS);
  const [r] = await s.db
    .select({ n: sql<number>`count(*)::int` })
    .from(captures)
    .where(and(eq(captures.keyId, hexToBytea(keyId)), gte(captures.createdAt, since)));
  return r?.n ?? 0;
}

async function peekKeyId(c: Context): Promise<Hex | null> {
  try {
    const raw = (await c.req.json()) as { keyId?: unknown };
    return typeof raw?.keyId === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw.keyId)
      ? (raw.keyId as Hex)
      : null;
  } catch {
    return null; // the capture route answers BadJson / BadRequest itself
  }
}

export type WebRouteOpts = {
  /** defaults to WEB_CAPTURE=1 in the environment. */
  enabled?: boolean;
  buckets?: TokenBuckets;
};

/**
 * Mounted by routes.ts with `app.route("/", webCaptureRoutes(s, { buckets: rl }))`, before the
 * `/v1/devices/:platform` route. Adds POST /v1/devices/web and the web-key quota in front of
 * POST /v1/captures (the request body is cached by Hono, so the capture route still parses it).
 */
export function webCaptureRoutes(s: Services, o: WebRouteOpts = {}): Hono {
  const enabled = o.enabled ?? process.env.WEB_CAPTURE === "1";
  const rl = o.buckets ?? new TokenBuckets(s.now);
  const daily = new DailyCounter(s.now);
  const app = new Hono();
  const ip = (c: Context) => clientIp((n) => c.req.header(n));

  const quota: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "POST") return next();
    const keyId = await peekKeyId(c);
    if (!keyId) return next();
    const key = await keyRow(s.db, keyId);
    if (key?.platform !== "web") return next();
    if (!enabled) throw new ApiError(403, "WebCaptureDisabled");
    const n = await capturesLastDay(s, keyId);
    if (n >= WEB_CAPTURES_PER_DAY)
      throw quotaError(Math.ceil(DAY_MS / 1000 / WEB_CAPTURES_PER_DAY));
    const r = daily.take(`webcap:${ip(c)}`, WEB_CAPTURES_PER_IP_PER_DAY);
    if (!r.ok) throw quotaError(r.retryAfterS);
    return next();
  };
  app.use("/v1/captures", quota);

  app.post("/v1/devices/web", rateLimit(rl, "devices"), async (c) => {
    if (!enabled) throw new ApiError(404, "NotFound");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "BadJson");
    }
    const body = WebEnrolBody.parse(raw);
    const r = daily.take(`webenrol:${ip(c)}`, WEB_ENROLS_PER_IP_PER_DAY);
    if (!r.ok) throw quotaError(r.retryAfterS);
    return c.json(await enrolWebKey(s, body, c.req.header("user-agent")), 201);
  });
  return app;
}
