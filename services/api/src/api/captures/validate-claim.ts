import {
  type CaptureClaim,
  type CaptureRecord,
  type DeviceKeyInfo,
  decodePrivateRecord,
  decodeRecord,
  FLAG,
  fixInCell,
  hashCaptureClaim,
  rawPieceSizeBounds,
  recordHash,
  validateCommPv2,
  verifyDeviceSignature,
} from "@stamper/core";
import type { Address, Hex, TypedDataDomain } from "viem";
import type { CaptureAttestation, DeviceAttestation, Platform } from "../attest/types.js";
import { hexBytes, lowerEq, sha256Hex } from "../util.js";

export type ClaimErrorCode =
  | "ClaimMismatch"
  | "HashMismatch"
  | "CidMismatch"
  | "LengthMismatch"
  | "CidInvalid"
  | "LengthOutOfBounds"
  | "FlagsInvalid"
  | "KeyRevoked"
  | "BadSig"
  | "NonceUsed"
  | "Expired"
  | "ChallengeInvalid"
  | "AttestationInvalid"
  | "CounterReplay"
  | "RecordHash"
  | "RecordInvalid"
  | "RecordMismatch"
  | "PrivateRecordInvalid";

export class ClaimRejected extends Error {
  override name = "ClaimRejected";
  constructor(
    readonly code: ClaimErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Server-side flags (stamps.flags); claim flags stay inside the signed claim. */
export const SERVER_FLAG = { CAPTURE_TIME_SKEW: 1 } as const;
export const SKEW_MS = 10 * 60_000;
const RESERVED_FLAGS = 0xf8;

export type EnrolledKey = {
  keyType: number;
  platform: Platform | "web";
  level: number;
  addr: Address | null;
  x: Hex | null;
  y: Hex | null;
  rpIdHash: Hex | null;
  appAttestKeyId: string | null;
  pubX: Hex | null;
  pubY: Hex | null;
  assertionCounter: bigint;
  revoked: boolean;
};

export type ClaimInput = {
  claim: CaptureClaim;
  sig: Hex;
  authData: Hex;
  record: Uint8Array;
  attestation: CaptureAttestation & { challengeId: string };
  /** DAG-CBOR private record; required when the public record carries a location */
  privateRecord?: Uint8Array;
};

export type ValidationDeps = {
  staged: { sha256: Hex; pieceCidHex: Hex; size: bigint };
  /** createdAtMs: when POST /v1/captures opened this capture (start of the receipt window). */
  capture: { keyId: Hex; mediaKind: number; challengeId: string | null; createdAtMs?: number };
  key: EnrolledKey;
  domain: TypedDataDomain & { chainId: number; verifyingContract: Address };
  nowMs: number;
  nonceUsed(keyId: Hex, nonce: bigint): Promise<boolean>;
  /** single-use consumption; returns the challenge value or null. */
  consumeChallenge(id: string): Promise<Hex | null>;
  attest: DeviceAttestation;
};

export type ValidatedClaim = {
  stampId: Hex;
  /** countersignature level: the key's level when the per-capture attestation passed, else 0. */
  level: number;
  counter?: bigint;
  serverFlags: number;
  record: CaptureRecord;
  challenge: Hex;
};

const ZERO32: Hex = `0x${"00".repeat(32)}`;

function keyInfo(k: EnrolledKey): DeviceKeyInfo {
  const kt = k.keyType as 0 | 1 | 2 | 3;
  return kt === 0 || kt === 3
    ? { keyType: kt, addr: (k.addr ?? `0x${"00".repeat(20)}`) as Address }
    : {
        keyType: kt,
        x: k.x ?? ZERO32,
        y: k.y ?? ZERO32,
        ...(k.rpIdHash ? { rpIdHash: k.rpIdHash } : {}),
      };
}

/**
 * DESIGN §7.4 in order. Byte checks come first, so a claim whose staged bytes hash differently is
 * rejected before any signature work. Throws ClaimRejected with the wire error code.
 */
export async function validateClaim(input: ClaimInput, d: ValidationDeps): Promise<ValidatedClaim> {
  const { claim } = input;
  const no = (code: ClaimErrorCode, detail?: string): never => {
    throw new ClaimRejected(code, detail);
  };

  if (!lowerEq(claim.keyId, d.capture.keyId)) no("ClaimMismatch", "keyId differs from the capture");
  if (claim.mediaKind !== d.capture.mediaKind)
    no("ClaimMismatch", "mediaKind differs from the capture");

  // 1. staged bytes
  if (!lowerEq(claim.contentHash, d.staged.sha256)) no("HashMismatch");
  if (!lowerEq(claim.pieceCid, d.staged.pieceCidHex)) no("CidMismatch");
  // 2. length, CommPv2, size bounds
  if (claim.contentLength !== d.staged.size) no("LengthMismatch");
  const cid = validateCommPv2(hexBytes(claim.pieceCid));
  if (!cid.ok) no("CidInvalid", cid.reason);
  if (cid.ok) {
    const b = rawPieceSizeBounds(cid.padding, cid.height);
    if (claim.contentLength < b.min || claim.contentLength > b.max) no("LengthOutOfBounds");
  }
  // flags: reserved bits, sealed (v1), server-computed PieceCID only for video
  if (claim.flags & RESERVED_FLAGS) no("FlagsInvalid", "reserved bits");
  if (claim.flags & FLAG.SEALED) no("FlagsInvalid", "sealed mode is not available");
  if (claim.mediaKind === 1 && claim.flags & FLAG.PIECECID_SERVER_COMPUTED) {
    no("FlagsInvalid", "PIECECID_SERVER_COMPUTED is for video only");
  }

  // 3. signature against the enrolled key
  if (d.key.revoked) no("KeyRevoked");
  const stampId = hashCaptureClaim(d.domain, claim);
  let sigOk = false;
  try {
    sigOk = verifyDeviceSignature(keyInfo(d.key), stampId, input.sig, input.authData, claim.nonce);
  } catch {
    sigOk = false;
  }
  if (!sigOk) no("BadSig");

  // 4. nonce unused (DB + chain), 5. deadline
  if (await d.nonceUsed(claim.keyId, claim.nonce)) no("NonceUsed");
  if (claim.deadline * 1000n <= BigInt(d.nowMs)) no("Expired");

  // 6. attestation bound to sha256(digest ‖ challenge); challenge single-use within its TTL
  if (!d.capture.challengeId || input.attestation.challengeId !== d.capture.challengeId) {
    no("ChallengeInvalid", "not this capture's challenge");
  }
  const challenge = await d.consumeChallenge(input.attestation.challengeId);
  if (!challenge) no("ChallengeInvalid", "unknown, used or expired");
  const ch = challenge as Hex;
  const binding = sha256Hex(hexBytes(stampId), hexBytes(ch));
  const platform: Platform = d.key.platform === "ios" ? "ios" : "android";
  const att = await d.attest.verifyCapture(
    {
      platform,
      attestation: input.attestation,
      key: {
        appAttestKeyId: d.key.appAttestKeyId,
        pubX: d.key.pubX,
        pubY: d.key.pubY,
        assertionCounter: d.key.assertionCounter,
      },
    },
    binding,
  );
  if (!att.ok && d.key.level >= 1) no("AttestationInvalid", att.reason);
  // 7. counter progression (App Attest)
  if (att.counter !== undefined && att.counter <= d.key.assertionCounter) no("CounterReplay");

  // 8. capture time within ±10 min of receipt, else flagged (not rejected). Receipt spans
  //    capture creation → claim, so a long upload alone never flags the capture.
  let serverFlags = 0;
  const capturedAtMs = Number(claim.capturedAt);
  const receiptFrom = Math.min(d.capture.createdAtMs ?? d.nowMs, d.nowMs);
  if (capturedAtMs < receiptFrom - SKEW_MS || capturedAtMs > d.nowMs + SKEW_MS)
    serverFlags |= SERVER_FLAG.CAPTURE_TIME_SKEW;

  // 9. record hashes to recordHash and agrees with the claim
  if (!lowerEq(recordHash(input.record), claim.recordHash)) no("RecordHash");
  let record: CaptureRecord | undefined;
  try {
    record = decodeRecord(input.record);
  } catch (e) {
    no("RecordInvalid", e instanceof Error ? e.message.slice(0, 200) : undefined);
  }
  const r = record as CaptureRecord;
  const offline = (claim.flags & FLAG.OFFLINE) !== 0;
  const mismatch = !lowerEq(r.contentHash, claim.contentHash)
    ? "contentHash"
    : !lowerEq(r.pieceCid, claim.pieceCid)
      ? "pieceCid"
      : BigInt(r.contentLength) !== claim.contentLength
        ? "contentLength"
        : BigInt(r.capturedAt) !== claim.capturedAt
          ? "capturedAt"
          : r.offline !== offline
            ? "offline"
            : r.platform !== d.key.platform
              ? "platform"
              : r.stampDomain.chainId !== d.domain.chainId ||
                  !lowerEq(r.stampDomain.registry, d.domain.verifyingContract)
                ? "stampDomain"
                : !offline && !lowerEq(r.serverChallenge, ch)
                  ? "serverChallenge"
                  : null;
  if (mismatch) no("RecordMismatch", mismatch);

  // 10. a public location cell needs the exact fix: sent here, hashing to privateHash, inside the cell
  if (input.privateRecord) {
    if (!r.privateHash || !lowerEq(recordHash(input.privateRecord), r.privateHash))
      no("PrivateRecordInvalid", "does not hash to record.privateHash");
    let fix: ReturnType<typeof decodePrivateRecord>["location"];
    try {
      fix = decodePrivateRecord(input.privateRecord).location;
    } catch (e) {
      no("PrivateRecordInvalid", e instanceof Error ? e.message.slice(0, 200) : undefined);
    }
    if (r.location && (!fix || !fixInCell(fix, r.location)))
      no("PrivateRecordInvalid", "exact fix is not inside the public location cell");
  } else if (r.location) no("PrivateRecordInvalid", "a public location needs the private record");

  return {
    stampId,
    level: att.ok ? d.key.level : 0,
    ...(att.counter !== undefined ? { counter: att.counter } : {}),
    serverFlags,
    record: r,
    challenge: ch,
  };
}
