/**
 * WP-14 web capture: POST /v1/devices/web (WebCrypto P-256, level 0), the 10/day web-key quota on
 * POST /v1/captures, and a level-0 claim with attestation "none" through validateClaim.
 * Needs Postgres (TEST_DATABASE_URL or docker); no chain: the relayer is replaced by a recorder.
 */
import { randomBytes, webcrypto } from "node:crypto";
import {
  type CaptureRecord,
  claimDeadline,
  encodeRecord,
  hashCaptureClaim,
  hashKeyPossession,
  KT,
  keyIdFromP256,
  PF,
  pieceCidHex,
  pieceCidOf,
  recordHash,
  verifyDeviceSignature,
} from "@stamper/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateClaim } from "../../src/api/captures/validate-claim.js";
import { DailyCounter, WEB_CAPTURES_PER_DAY, webCaptureRoutes } from "../../src/api/devices/web.js";
import { enrolledKey, keyRow } from "../../src/api/keys.js";
import { createRoutes, onError } from "../../src/api/routes.js";
import type { Services } from "../../src/api/services.js";
import { sha256Hex } from "../../src/api/util.js";
import { deviceKeys } from "../../src/db/index.js";
import { hexToBytea } from "../../src/shared/index.js";
import { freshDatabase, skipReason, startPg, stopPg } from "../foundation/pg.js";
import { apiEnv, type Harness, harness } from "./harness.js";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

/** Same algorithm as apps/web/lib/webkey.ts: WebCrypto ECDSA-SHA256 over the digest, low-s. */
async function webKey() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  const x = hex(raw.slice(1, 33));
  const y = hex(raw.slice(33, 65));
  const sign = async (digest: Hex): Promise<Hex> => {
    const sig = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        kp.privateKey,
        Buffer.from(digest.slice(2), "hex"),
      ),
    );
    const s = BigInt(hex(sig.slice(32)));
    if (s > N / 2n) sig.set(Buffer.from((N - s).toString(16).padStart(64, "0"), "hex"), 32);
    return hex(sig);
  };
  return { x, y, keyId: keyIdFromP256(x, y), sign };
}

const admin = await startPg();
const d = admin ? describe : describe.skip;
if (!admin) console.warn(`[skip] web capture tests: ${skipReason}`);

d("web capture (WP-14)", () => {
  let h: Harness;
  let s: Services;
  let app: Hono;
  const sent: { kind: string; data: Hex }[] = [];
  const appInfo = { id: "media.stamper.web", version: "1.0.0", build: "web" };

  beforeAll(async () => {
    h = await harness(await apiEnv({ DATABASE_URL: await freshDatabase() }));
    const relayer = {
      async send(kind: string, tx: { data: Hex }) {
        sent.push({ kind, data: tx.data });
        return { hash: hex(randomBytes(32)), wait: async () => ({ blockNumber: 7n }) };
      },
    } as unknown as Services["relayer"];
    s = { ...h.services, relayer };
    process.env.WEB_CAPTURE = "1";
    app = createRoutes(s);
  }, 120_000);
  afterAll(async () => {
    delete process.env.WEB_CAPTURE;
    await h?.close();
    await stopPg();
  });

  const post = (path: string, body: unknown, a: Hono = app) =>
    a.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    });
  async function enrolBody(k: Awaited<ReturnType<typeof webKey>>, a: Hono = app) {
    const ch = (await (await a.request("/v1/attest/challenge")).json()) as { challengeId: string };
    const pop = hashKeyPossession(s.domain, {
      keyId: k.keyId,
      keyType: KT.P256_RAW,
      platform: PF.WEB,
      x: k.x,
      y: k.y,
      addr: "0x0000000000000000000000000000000000000000",
    });
    return {
      keyId: k.keyId,
      x: k.x,
      y: k.y,
      popSig: await k.sign(pop),
      challengeId: ch.challengeId,
      appInfo,
    };
  }

  it("a WebCrypto P-256 signature passes core verifyDeviceSignature(KT_P256_RAW)", async () => {
    const k = await webKey();
    const digest = sha256Hex(randomBytes(32));
    for (let i = 0; i < 8; i++) {
      const sig = await k.sign(digest);
      expect(verifyDeviceSignature({ keyType: 1, x: k.x, y: k.y }, digest, sig, "0x", 0n)).toBe(
        true,
      );
    }
  });

  let key: Awaited<ReturnType<typeof webKey>>;
  it("enrols a browser key at level 0 with no endorsement", async () => {
    key = await webKey();
    const r = await post("/v1/devices/web", await enrolBody(key));
    expect(r.status).toBe(201);
    const j = (await r.json()) as { level: number; keyId: string; status: string };
    expect(j).toMatchObject({ level: 0, keyId: key.keyId, status: "registering" });
    expect(sent.at(-1)?.kind).toBe("registerKey");
    const row = await keyRow(s.db, key.keyId);
    expect(row).toMatchObject({ platform: "web", keyType: 1, level: 0 });
    expect((await post("/v1/devices/web", await enrolBody(key))).status).toBe(409);
  });

  it("rejects a bad proof of possession, a wrong keyId and unknown fields", async () => {
    const k = await webKey();
    const b = await enrolBody(k);
    const other = await webKey();
    const bad = await post("/v1/devices/web", {
      ...b,
      popSig: await other.sign(sha256Hex(randomBytes(8))),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("BadSig");
    const mism = await post("/v1/devices/web", { ...(await enrolBody(k)), keyId: other.keyId });
    expect(((await mism.json()) as { error: string }).error).toBe("KeyIdMismatch");
    expect((await post("/v1/devices/web", { ...b, platform: "web" })).status).toBe(400);
  });

  it("is a 404 when WEB_CAPTURE is off", async () => {
    const off = new Hono();
    off.onError(onError(s.log));
    off.route("/", webCaptureRoutes(s, { enabled: false }));
    const r = await post("/v1/devices/web", {}, off);
    expect(r.status).toBe(404);
  });

  it(`allows ${WEB_CAPTURES_PER_DAY} captures per web key per day, then 429`, async () => {
    for (let i = 0; i < WEB_CAPTURES_PER_DAY; i++) {
      const r = await post("/v1/captures", { keyId: key.keyId, mediaKind: 1 });
      expect(r.status).toBe(201);
    }
    const r = await post("/v1/captures", { keyId: key.keyId, mediaKind: 1 });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toBe("QuotaExceeded");
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("a web claim with attestation none validates at level 0", async () => {
    const bytes = new Uint8Array(randomBytes(4096));
    const cid = await pieceCidOf(bytes);
    const challenge = sha256Hex(randomBytes(8));
    const capturedAt = BigInt(Date.now());
    const rec: CaptureRecord = {
      v: 1,
      stampDomain: { chainId: s.domain.chainId, registry: s.domain.verifyingContract },
      contentHash: sha256Hex(bytes),
      pieceCid: pieceCidHex(cid),
      contentLength: bytes.length,
      mediaType: "image/jpeg",
      dims: { w: 64, h: 48 },
      capturedAt: Number(capturedAt),
      monotonicNs: "1",
      platform: "web",
      app: appInfo,
      capture: {
        source: "in-app-camera",
        facing: "front",
        lensId: "web",
        physicalCameraIds: [],
        physicalOnly: true,
      },
      serverChallenge: challenge,
      offline: false,
      sanitised: { removed: [], kept: [] },
      publicExif: {},
      attestation: { kind: "none", bundleHash: `0x${"00".repeat(32)}` },
      privateHash: null,
    };
    const record = encodeRecord(rec);
    const claim = {
      contentHash: rec.contentHash,
      pieceCid: rec.pieceCid,
      contentLength: BigInt(bytes.length),
      mediaKind: 1 as const,
      capturedAt,
      recordHash: recordHash(record),
      keyId: key.keyId,
      nonce: 42n,
      flags: 0,
      deadline: claimDeadline(capturedAt, false),
    };
    const sig = await key.sign(hashCaptureClaim(s.domain, claim));
    const row = await keyRow(s.db, key.keyId);
    const v = await validateClaim(
      { claim, sig, authData: "0x", record, attestation: { kind: "none", challengeId: "c" } },
      {
        staged: { sha256: rec.contentHash, pieceCidHex: rec.pieceCid, size: BigInt(bytes.length) },
        capture: { keyId: key.keyId, mediaKind: 1, challengeId: "c" },
        key: enrolledKey(row as NonNullable<typeof row>),
        domain: s.domain,
        nowMs: Date.now(),
        nonceUsed: async () => false,
        consumeChallenge: async () => challenge,
        attest: s.attest,
      },
    );
    expect(v.level).toBe(0);
    expect(v.stampId).toBe(hashCaptureClaim(s.domain, claim));
    const after = await h.ctx.db
      .select()
      .from(deviceKeys)
      .where(eq(deviceKeys.keyId, hexToBytea(key.keyId)));
    expect(after[0]?.registeredEpoch).toBe(7n);
  });

  it("DailyCounter windows roll", () => {
    let t = 0;
    const c = new DailyCounter(() => t, 1000);
    expect(c.take("a", 2).ok).toBe(true);
    expect(c.take("a", 2).ok).toBe(true);
    expect(c.take("a", 2).ok).toBe(false);
    t = 1001;
    expect(c.take("a", 2).ok).toBe(true);
  });
});
