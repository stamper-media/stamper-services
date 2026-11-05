import { randomBytes } from "node:crypto";
import { encodeCode, formatCode, pieceCidHex, pieceCidOf } from "@stamper/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/api/util.js";
import { bindings, captures, challenges, deviceKeys, stamps } from "../../src/db/index.js";
import { hexToBytea } from "../../src/shared/index.js";
import { freshDatabase, skipReason, startPg, stopPg } from "../foundation/pg.js";
import { apiEnv, type Harness, harness, newDevice } from "./harness.js";

const admin = await startPg();
const d = admin ? describe : describe.skip;
if (!admin) console.warn(`[skip] api http tests: ${skipReason}`);

d("api http (Postgres, no chain)", () => {
  let h: Harness;
  const req = (path: string, init?: RequestInit) => h.ctx.http.request(path, init);
  const dev = newDevice();
  const bytes = new Uint8Array(randomBytes(70_000));

  beforeAll(async () => {
    h = await harness(await apiEnv({ DATABASE_URL: await freshDatabase() }));
    await h.ctx.db.insert(deviceKeys).values({
      keyId: hexToBytea(dev.keyId),
      platform: "android",
      keyType: 0,
      level: 1,
      addr: hexToBytea(dev.addr),
    });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    await stopPg();
  });

  let captureId = "";
  let uploadId = "";
  it("opens a capture with a challenge", async () => {
    const r = await req("/v1/captures", {
      method: "POST",
      body: JSON.stringify({ keyId: dev.keyId, mediaKind: 1 }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { captureId: string; uploadId: string; challenge: string };
    expect(j.challenge).toMatch(/^0x[0-9a-f]{64}$/);
    ({ captureId, uploadId } = j);
  });

  it("capture challenges outlive a slow upload; enrolment challenges stay at 5 min", async () => {
    const [cap] = await h.ctx.db.select().from(captures).where(eq(captures.id, captureId));
    const [ch] = await h.ctx.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, cap?.challengeId as string));
    expect(h.cfg.limits.captureChallengeTtlMs).toBe(3_600_000);
    const capLeft = (ch?.expiresAt.getTime() ?? 0) - Date.now();
    expect(capLeft).toBeGreaterThan(55 * 60_000);
    expect(capLeft).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    const r = await req("/v1/attest/challenge");
    expect(r.status).toBe(200);
    const enrolLeft =
      Date.parse(((await r.json()) as { expiresAt: string }).expiresAt) - Date.now();
    expect(enrolLeft).toBeGreaterThan(4 * 60_000);
    expect(enrolLeft).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });

  it("resumable upload: sequential ranges, gap → 409, HEAD resume, completion equals core", async () => {
    const total = bytes.length;
    const cuts = [0, 25_000, 50_000, total];
    const put = (i: number) =>
      req(`/v1/uploads/${uploadId}`, {
        method: "PUT",
        headers: { "content-range": `bytes ${cuts[i]}-${(cuts[i + 1] as number) - 1}/${total}` },
        body: bytes.slice(cuts[i], cuts[i + 1]),
      });
    let r = await put(0);
    expect(r.status).toBe(308);
    expect(r.headers.get("range")).toBe("bytes=0-24999");
    r = await put(2);
    expect(r.status).toBe(409);
    expect(r.headers.get("range")).toBe("bytes=0-24999");
    r = await req(`/v1/uploads/${uploadId}`, { method: "HEAD" });
    expect(r.headers.get("range")).toBe("bytes=0-24999");
    // a fresh manager (as after a restart) rebuilds the hash state from the staged prefix
    (h.services.uploads as unknown as { states: Map<string, unknown> }).states.clear();
    expect((await put(1)).status).toBe(308);
    r = await put(2);
    expect(r.status).toBe(201);
    const j = (await r.json()) as {
      sha256: string;
      pieceCidHex: string;
      pieceCid: string;
      size: string;
    };
    const cid = await pieceCidOf(bytes);
    expect(j.sha256).toBe(sha256Hex(bytes));
    expect(j.pieceCidHex).toBe(pieceCidHex(cid));
    expect(j.pieceCid).toMatch(/^bafkzcib/);
    expect(j.size).toBe(String(total));
    // idempotent retry of the last chunk
    expect((await put(2)).status).toBe(201);
  });

  it("rejects a claim whose bytes hash differently before checking the signature", async () => {
    const zero = `0x${"00".repeat(32)}`;
    const r = await req(`/v1/captures/${captureId}/claim`, {
      method: "POST",
      body: JSON.stringify({
        claim: {
          contentHash: zero,
          pieceCid: "0x01",
          contentLength: "1",
          mediaKind: 1,
          capturedAt: "1",
          recordHash: zero,
          keyId: dev.keyId,
          nonce: "1",
          flags: 0,
          deadline: "1",
        },
        sig: "0x00",
        record: "",
        attestation: {
          kind: "stub",
          token: "stub:android:00",
          challengeId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "HashMismatch" });
  });

  it("serves the original from staging with ETag, then redirects once bound and probed", async () => {
    const stampId = `0x${randomBytes(32).toString("hex")}` as const;
    const code = 0x1234567890n;
    const cid = await pieceCidOf(bytes);
    await h.ctx.db.insert(stamps).values({
      stampId: hexToBytea(stampId),
      code,
      keyId: hexToBytea(dev.keyId),
      mediaKind: 1,
      mime: "image/jpeg",
      size: BigInt(bytes.length),
      contentSha256: hexToBytea(sha256Hex(bytes)),
      pieceCid: hexToBytea(pieceCidHex(cid)),
      claim: { flags: 0 },
      status: "registered",
      level: 1,
      registeredEpoch: 5n,
      countersig: Buffer.alloc(66, 1),
    });
    await h.ctx.db
      .update(captures)
      .set({ stampId: hexToBytea(stampId), status: "claimed" })
      .where(eq(captures.id, captureId));
    const c9 = formatCode(encodeCode(code));
    let r = await req(`/v1/stamps/${c9}/original`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-stamper-source")).toBe("staging");
    expect(r.headers.get("etag")).toBe(`"${sha256Hex(bytes).slice(2)}"`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);

    r = await req(`/v1/stamps/${c9.toLowerCase()}`);
    expect(r.status).toBe(200);
    const p = (await r.json()) as { storageState: string; code9: string; footer: string };
    expect(p.storageState).toBe("pending");

    await h.ctx.db.insert(bindings).values({
      stampId: hexToBytea(stampId),
      slot: 0,
      asset: 0,
      dataSetId: 1n,
      pieceId: 0n,
      providerId: 1n,
      bindTx: hexToBytea(stampId),
      boundEpoch: 6n,
      lastOkAt: new Date(),
      probeFailures: 0,
    });
    r = await req(`/v1/stamps/${c9}/original`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/piece/");
    r = await req(`/v1/stamps/${c9}`);
    expect(((await r.json()) as { storageState: string }).storageState).toBe("bound");
    expect((await req(`/v1/stamps/${c9}/share.jpg`)).status).toBe(404);
    const ev = (await (await req(`/v1/stamps/${c9}/evidence.json`)).json()) as {
      stampId: string;
      bindings: unknown[];
    };
    expect(ev.stampId).toBe(stampId);
    expect(ev.bindings).toHaveLength(1);
  }, 30_000);

  it("codes: 422 InvalidCode, 404 NotRegistered", async () => {
    const r = await req("/v1/stamps/AAAA-AAAA-A", { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect([404, 422]).toContain(r.status);
    expect(
      (await req("/v1/stamps/ab", { headers: { "x-forwarded-for": "10.0.0.1" } })).status,
    ).toBe(422);
  });

  it("rate limits code lookups at 60/min/IP → 429", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await req("/v1/stamps/zz", { headers: { "x-forwarded-for": "10.9.9.9" } })).status;
    expect(last).toBe(429);
  });

  it("well-known files and OpenAPI", async () => {
    const a = (await (await req("/.well-known/apple-app-site-association")).json()) as {
      applinks: { details: Array<{ appIDs: string[]; components: unknown[] }> };
    };
    expect(a.applinks.details[0]?.appIDs).toEqual(["TEAM123456.media.stamper.app"]);
    expect(a.applinks.details[0]?.components).toEqual([{ "/": "/v/*" }]);
    const l = (await (await req("/.well-known/assetlinks.json")).json()) as Array<{
      relation: string[];
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    expect(l[0]?.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(l[0]?.target.package_name).toBe("media.stamper.app");
    expect(l[0]?.target.sha256_cert_fingerprints[0]).toMatch(/^AB(:AB){31}$/);
    expect((await req("/v1/openapi.json")).status).toBe(200);
  });

  it("verify upload stores to staging and enqueues the worker job; reports are taken", async () => {
    const fd = new FormData();
    fd.set("file", new File([bytes], "x.jpg", { type: "image/jpeg" }));
    const r = await req("/v1/verify/upload", { method: "POST", body: fd });
    expect(r.status).toBe(202);
    const { jobId } = (await r.json()) as { jobId: string };
    expect(h.queue.pending.some((p) => p.name === "verify-upload")).toBe(true);
    expect(
      ((await (await req(`/v1/verify/jobs/${jobId}`)).json()) as { status: string }).status,
    ).toBe("queued");
    const rep = await req("/v1/reports", {
      method: "POST",
      body: JSON.stringify({ code: "5VEB-TVRA-F", kind: "abuse", text: "x" }),
    });
    expect(rep.status).toBe(201);
  });
});
