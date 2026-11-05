import { encodeRegisterKey } from "@stamper/contracts-abi";
import {
  hashKeyPossession,
  type KeyEnrolment,
  keyIdFromAddress,
  keyIdFromP256,
  PF,
  verifyDeviceSignature,
} from "@stamper/core";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { z } from "zod";
import { attestationBundles, deviceKeys } from "../db/index.js";
import { hexToBytea } from "../shared/index.js";
import { consumeChallenge } from "./attest/challenge.js";
import { TxRevertedError } from "./chain.js";
import { seal } from "./crypto.js";
import { ApiError } from "./errors.js";
import { keyRow } from "./keys.js";
import type { EnrolBody } from "./schemas.js";
import type { Services } from "./services.js";
import { hexBytes, lowerEq, sha256Hex } from "./util.js";

const ZERO32: Hex = `0x${"00".repeat(32)}`;
export const KEY_LIFETIME_S = 365n * 86_400n;

export async function enrolDevice(
  s: Services,
  platform: "ios" | "android",
  b: z.output<typeof EnrolBody>,
): Promise<{ keyId: Hex; level: number; txHash: Hex; status: "registering" }> {
  if (b.platform !== platform) throw new ApiError(400, "PlatformMismatch");
  const keyType = b.keyType;
  const x = keyType === 1 ? b.x : ZERO32;
  const y = keyType === 1 ? b.y : ZERO32;
  if (!x || !y)
    throw new ApiError(400, "BadRequest", { reason: "x and y are required for P-256 keys" });
  const expectKeyId = keyType === 0 ? keyIdFromAddress(b.addr) : keyIdFromP256(x, y);
  if (!lowerEq(expectKeyId, b.keyId)) throw new ApiError(400, "KeyIdMismatch");
  const pf = platform === "ios" ? PF.IOS : PF.ANDROID;

  // proof of possession over KeyPossession (the same digest the contract checks)
  const popDigest = hashKeyPossession(s.domain, {
    keyId: b.keyId,
    keyType,
    platform: pf,
    x,
    y,
    addr: b.addr,
  });
  let popOk = false;
  try {
    popOk = verifyDeviceSignature(
      keyType === 0 ? { keyType: 0, addr: b.addr } : { keyType: 1, x, y },
      popDigest,
      b.popSig,
      "0x",
      0n,
    );
  } catch {
    popOk = false;
  }
  if (!popOk) throw new ApiError(400, "BadSig", { reason: "proof of possession" });

  const existing = await keyRow(s.db, b.keyId);
  const challenge = await consumeChallenge(s.db, b.attestation.challengeId, "enrol");
  if (!challenge) throw new ApiError(400, "ChallengeInvalid");
  const binding = sha256Hex(hexBytes(b.addr), hexBytes(challenge));
  const att = await s.attest.verifyEnrolment({ platform, binding, attestation: b.attestation });
  if (existing && (existing.level >= 1 || att.level === 0)) throw new ApiError(409, "KeyExists");
  if (!att.ok)
    s.log.info({ keyId: b.keyId, reason: att.reason }, "enrolment attestation failed; level 0");

  const wrap = s.cfg.secrets.recordWrapKey;
  if (!wrap) throw new ApiError(503, "NotConfigured", { reason: "RECORD_WRAP_KEY" });
  const enc = seal(
    wrap,
    new TextEncoder().encode(
      JSON.stringify({ bundle: Buffer.from(att.bundle).toString("base64"), appInfo: b.appInfo }),
    ),
  );

  const level = att.level;
  const enrolment: KeyEnrolment = {
    keyId: b.keyId,
    keyType,
    platform: pf,
    level,
    x,
    y,
    addr: b.addr,
    rpIdHash: ZERO32,
    attestationHash: att.bundleHash,
    expiresAt: BigInt(Math.floor(s.now() / 1000)) + KEY_LIFETIME_S,
  };
  const endorsement: Hex = level >= 1 ? await s.registrar.endorse(enrolment) : "0x";
  let sent: Awaited<ReturnType<typeof s.relayer.send>>;
  try {
    sent = await s.relayer.send("registerKey", {
      to: s.cfg.chain.registry,
      data: encodeRegisterKey({ enrolment, popSig: b.popSig, endorsement }),
    });
  } catch (e) {
    if (e instanceof TxRevertedError)
      throw new ApiError(422, "EnrolRejected", { reason: e.reason });
    throw e;
  }

  const appAttest = att.appAttest;
  const row = {
    platform,
    keyType,
    level,
    addr: hexToBytea(b.addr),
    pubX: keyType === 1 ? hexToBytea(x) : appAttest ? hexToBytea(appAttest.x) : null,
    pubY: keyType === 1 ? hexToBytea(y) : appAttest ? hexToBytea(appAttest.y) : null,
    rpIdHash: null,
    attestationHash: hexToBytea(att.bundleHash),
    appAttestKeyId: appAttest?.keyId ?? null,
    registeredTx: hexToBytea(sent.hash),
    expiresAt: new Date(Number(enrolment.expiresAt) * 1000),
  };
  await s.db.transaction(async (tx) => {
    await tx
      .insert(deviceKeys)
      .values({ keyId: hexToBytea(b.keyId), ...row })
      .onConflictDoUpdate({ target: deviceKeys.keyId, set: row });
    await tx.insert(attestationBundles).values({
      keyId: hexToBytea(b.keyId),
      kind: "enrol",
      platform,
      sha256: hexToBytea(att.bundleHash),
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
    .catch((e: unknown) => s.log.error({ err: e, keyId: b.keyId }, "registerKey failed"));

  return { keyId: b.keyId, level, txHash: sent.hash, status: "registering" };
}
