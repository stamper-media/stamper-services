import { randomUUID } from "node:crypto";
import { readPredictCode, readUsedNonce } from "@stamper/contracts-abi";
import { type CaptureClaim, encodeCode, FLAG, formatCode, predictCode } from "@stamper/core";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { z } from "zod";
import {
  attestationBundles,
  captures as capturesT,
  derivatives,
  deviceKeys,
  stamps as stampsT,
  uploads as uploadsT,
} from "../../db/index.js";
import { stampEvents, uploads } from "../../db/repo/index.js";
import { byteaToHex, hexToBytea, stagingPath } from "../../shared/index.js";
import { consumeChallenge, issueChallenge } from "../attest/challenge.js";
import { seal } from "../crypto.js";
import { ApiError } from "../errors.js";
import { enrolledKey, keyRow } from "../keys.js";
import type { CaptureBody, ClaimBody } from "../schemas.js";
import type { Services } from "../services.js";
import { fromB64, sha256Hex } from "../util.js";
import { ClaimRejected, validateClaim } from "./validate-claim.js";

export const fmtCode = (v: bigint): string => formatCode(encodeCode(v));

/** register job: a fixed 15 s retry for up to 15 min, while a just-enrolled key reaches the chain. */
export const REGISTER_RETRY_DELAY_MS = 15_000;
export const REGISTER_RETRY_LIMIT = 60;

export async function createCapture(s: Services, b: z.output<typeof CaptureBody>) {
  const key = await keyRow(s.db, b.keyId);
  if (!key) throw new ApiError(404, "UnknownKey");
  if (key.revokedEpoch !== null && key.revokedEpoch !== 0n) throw new ApiError(403, "KeyRevoked");
  const max = BigInt(b.mediaKind === 2 ? s.cfg.limits.maxVideoBytes : s.cfg.limits.maxImageBytes);
  if (b.expectedSize !== undefined && (b.expectedSize < 1n || b.expectedSize > max)) {
    throw new ApiError(413, "LengthOutOfBounds", { max: max.toString() });
  }
  const ch = await issueChallenge(s.db, "capture", b.keyId, s.cfg.limits.captureChallengeTtlMs);
  const uploadId = randomUUID();
  const captureId = await s.db.transaction(async (tx) => {
    const [c] = await tx
      .insert(capturesT)
      .values({
        keyId: hexToBytea(b.keyId),
        userId: key.userId,
        mediaKind: b.mediaKind,
        challengeId: ch.challengeId,
        expectedSize: b.expectedSize ?? null,
      })
      .returning({ id: capturesT.id });
    if (!c) throw new Error("capture insert returned no row");
    await uploads.create(tx, {
      id: uploadId,
      captureId: c.id,
      path: stagingPath(s.cfg, uploadId),
      totalSize: b.expectedSize ?? null,
    });
    return c.id;
  });
  return { captureId, uploadId, challengeId: ch.challengeId, challenge: ch.challenge };
}

const claimFromWire = (c: z.output<typeof ClaimBody>["claim"]): CaptureClaim => ({ ...c });
const claimToJson = (c: CaptureClaim) => ({
  ...c,
  contentLength: c.contentLength.toString(),
  capturedAt: c.capturedAt.toString(),
  nonce: c.nonce.toString(),
  deadline: c.deadline.toString(),
});

async function nonceUsed(s: Services, keyId: Hex, nonce: bigint): Promise<boolean> {
  const [hit] = await s.db
    .select({ id: stampsT.stampId })
    .from(stampsT)
    .where(
      and(
        eq(stampsT.keyId, hexToBytea(keyId)),
        sql`${stampsT.claim}->>'nonce' = ${nonce.toString()}`,
        ne(stampsT.status, "rejected"),
      ),
    )
    .limit(1);
  if (hit) return true;
  try {
    return await readUsedNonce(s.pub, s.cfg.chain.registry, keyId, nonce);
  } catch (e) {
    s.log.warn({ err: e }, "usedNonce read failed; relying on the DB and the contract");
    return false;
  }
}

export async function submitClaim(s: Services, captureId: string, b: z.output<typeof ClaimBody>) {
  const [cap] = await s.db.select().from(capturesT).where(eq(capturesT.id, captureId)).limit(1);
  if (!cap) throw new ApiError(404, "NotFound");
  if (cap.status === "claimed") throw new ApiError(409, "AlreadyClaimed");
  if (cap.status !== "uploaded") throw new ApiError(409, "NotUploaded");
  const [up] = await s.db
    .select()
    .from(uploadsT)
    .where(and(eq(uploadsT.captureId, captureId), eq(uploadsT.status, "complete")))
    .limit(1);
  if (!up?.sha256 || !up.pieceCid || up.totalSize === null) throw new ApiError(409, "NotUploaded");
  const keyId = byteaToHex(cap.keyId);
  const kr = await keyRow(s.db, keyId);
  if (!kr) throw new ApiError(404, "UnknownKey");
  const key = enrolledKey(kr);

  const claim = claimFromWire(b.claim);
  const record = fromB64(b.record);
  let v: Awaited<ReturnType<typeof validateClaim>>;
  try {
    v = await validateClaim(
      {
        claim,
        sig: b.sig,
        authData: b.authData ?? "0x",
        record,
        attestation: b.attestation,
        ...(b.privateRecord ? { privateRecord: fromB64(b.privateRecord) } : {}),
      },
      {
        staged: {
          sha256: byteaToHex(up.sha256),
          pieceCidHex: byteaToHex(up.pieceCid),
          size: up.totalSize,
        },
        capture: {
          keyId,
          mediaKind: cap.mediaKind,
          challengeId: cap.challengeId,
          createdAtMs: cap.createdAt.getTime(),
        },
        key,
        domain: s.domain,
        nowMs: s.now(),
        nonceUsed: (k, n) => nonceUsed(s, k, n),
        consumeChallenge: (id) => consumeChallenge(s.db, id, "capture"),
        attest: s.attest,
      },
    );
  } catch (e) {
    if (e instanceof ClaimRejected) {
      s.log.info({ captureId, code: e.code, detail: e.detail }, "claim rejected");
      throw new ApiError(
        e.code === "NonceUsed" ? 409 : 422,
        e.code,
        e.detail ? { reason: e.detail } : {},
      );
    }
    throw e;
  }

  const countersig = await s.registrar.countersign(v.stampId, v.level);
  let predicted: { code: bigint; attempt: number };
  try {
    predicted = await readPredictCode(s.pub, s.cfg.chain.registry, v.stampId);
  } catch {
    predicted = predictCode(v.stampId);
  }

  const wrap = s.cfg.secrets.recordWrapKey;
  const attBytes = new TextEncoder().encode(JSON.stringify(b.attestation));
  const attBundle = wrap ? { ...seal(wrap, attBytes), sha256: sha256Hex(attBytes) } : null;
  // the exact location never sits in plaintext at rest: iv ‖ AES-256-GCM(ciphertext ‖ tag) under the wrap key
  let privateSealed: Buffer | null = null;
  if (b.privateRecord) {
    if (!wrap) throw new ApiError(503, "PrivateRecordUnavailable");
    const sealed = seal(wrap, fromB64(b.privateRecord));
    privateSealed = Buffer.concat([sealed.iv, sealed.ciphertext]);
  }
  try {
    await s.db.transaction(async (tx) => {
      await tx.insert(stampsT).values({
        stampId: hexToBytea(v.stampId),
        userId: cap.userId,
        keyId: cap.keyId,
        mediaKind: claim.mediaKind,
        mime: v.record.mediaType,
        size: claim.contentLength,
        width: v.record.dims.w,
        height: v.record.dims.h,
        durationMs: v.record.dims.durationMs ?? null,
        contentSha256: hexToBytea(claim.contentHash),
        pieceCid: hexToBytea(claim.pieceCid),
        recordCbor: Buffer.from(record),
        privateRecordEnc:
          privateSealed ?? (b.privateRecordEnc ? Buffer.from(fromB64(b.privateRecordEnc)) : null),
        claim: claimToJson(claim),
        sig: hexToBytea(b.sig),
        authData: hexToBytea(b.authData ?? "0x"),
        countersig: hexToBytea(countersig),
        capturedAt: new Date(Number(claim.capturedAt)),
        status: "registering",
        level: v.level,
        flags: v.serverFlags,
      });
      await tx
        .update(capturesT)
        .set({
          status: "claimed",
          stampId: hexToBytea(v.stampId),
          predictedCode: predicted.code,
          claimedAt: new Date(s.now()),
        })
        .where(eq(capturesT.id, captureId));
      const keyPatch: Partial<typeof deviceKeys.$inferInsert> = {};
      if (v.counter !== undefined) keyPatch.assertionCounter = v.counter;
      if (claim.nonce + 1n > kr.nextNonce) keyPatch.nextNonce = claim.nonce + 1n;
      if (Object.keys(keyPatch).length)
        await tx.update(deviceKeys).set(keyPatch).where(eq(deviceKeys.keyId, cap.keyId));
      if (attBundle) {
        await tx.insert(attestationBundles).values({
          keyId: cap.keyId,
          stampId: hexToBytea(v.stampId),
          kind: "capture",
          platform: key.platform,
          sha256: hexToBytea(attBundle.sha256),
          iv: attBundle.iv,
          ciphertext: attBundle.ciphertext,
        });
      }
      await stampEvents.append(tx, {
        stampId: v.stampId,
        kind: "claimed",
        actor: "api",
        data: { captureId, level: v.level, serverFlags: v.serverFlags },
      });
    });
  } catch (e) {
    const msg = String(
      (e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as Error).message,
    );
    if (/content_sha256/.test(msg)) {
      const [other] = await s.db
        .select({ code: stampsT.code })
        .from(stampsT)
        .where(eq(stampsT.contentSha256, hexToBytea(claim.contentHash)))
        .limit(1);
      throw new ApiError(
        409,
        "AlreadyStamped",
        other?.code != null ? { code: fmtCode(other.code) } : {},
      );
    }
    if (/stamps_pkey|duplicate key/.test(msg)) throw new ApiError(409, "Duplicate");
    throw e;
  }
  // A key enrolled moments ago (a browser's first stamp) lands on chain one or more tipsets later and
  // handleRegister throws RetryLater until then; the default 5 backed-off retries (~2.5 min) are too
  // short for Calibration or mainnet, so this job retries every 15 s for up to 15 min.
  await s.queue.enqueue(
    "register",
    { stampId: v.stampId },
    {
      singletonKey: v.stampId,
      retryLimit: REGISTER_RETRY_LIMIT,
      retryDelayMs: REGISTER_RETRY_DELAY_MS,
      retryBackoff: false,
    },
  );
  return {
    stampId: v.stampId,
    predictedCode: fmtCode(predicted.code),
    attempt: predicted.attempt,
    status: "registering" as const,
  };
}

export async function captureStatus(s: Services, captureId: string) {
  const [cap] = await s.db.select().from(capturesT).where(eq(capturesT.id, captureId)).limit(1);
  if (!cap) throw new ApiError(404, "NotFound");
  const stampId = cap.stampId ? byteaToHex(cap.stampId) : null;
  const st = stampId
    ? (
        await s.db
          .select()
          .from(stampsT)
          .where(eq(stampsT.stampId, hexToBytea(stampId)))
          .limit(1)
      )[0]
    : undefined;
  let shareReady = false;
  let marked: string | undefined;
  if (st?.code != null) {
    const ds = await s.db
      .select({ kind: derivatives.kind })
      .from(derivatives)
      .where(
        and(
          eq(derivatives.stampId, st.stampId),
          isNotNull(derivatives.attachTx),
          inArray(derivatives.kind, [1, 2]),
        ),
      );
    shareReady = ds.length > 0;
    if (shareReady) {
      const file = ds.some((d) => d.kind === 2) ? "share.mp4" : "share.jpg";
      marked = `${s.cfg.publicBaseUrl}/v1/stamps/${encodeCode(st.code)}/${file}`;
    }
  }
  return {
    status: st?.status ?? cap.status,
    stampId,
    predictedCode: cap.predictedCode != null ? fmtCode(cap.predictedCode) : null,
    ...(st?.code != null ? { code: fmtCode(st.code) } : {}),
    ...(st?.registerTx ? { registerTx: byteaToHex(st.registerTx) } : {}),
    ...(st?.registeredEpoch != null ? { registeredEpoch: st.registeredEpoch.toString() } : {}),
    shareReady,
    ...(marked ? { marked } : {}),
    ...(cap.reissuedCaptureId ? { reissued: { newCaptureId: cap.reissuedCaptureId } } : {}),
  };
}

export const OFFLINE_FLAG = FLAG.OFFLINE;
