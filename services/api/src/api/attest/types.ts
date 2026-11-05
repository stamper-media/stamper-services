import type { Hex } from "viem";

export type Platform = "ios" | "android";
export type AttestKind = "appattest" | "playintegrity" | "stub" | "none";

export type EnrolAttestation = {
  kind: AttestKind;
  /** App Attest key id (base64, as returned by generateKeyAsync). */
  keyId?: string;
  /** App Attest attestation object (base64 CBOR). */
  attestationObject?: string;
  /** Play Integrity token, or the stub token in ATTEST_MODE=stub. */
  token?: string;
};

export type CaptureAttestation = {
  kind: AttestKind;
  /** App Attest assertion (base64 CBOR). */
  assertion?: string;
  token?: string;
};

export type EnrolResult = {
  ok: boolean;
  level: 0 | 1;
  /** evidence bytes (canonical JSON); stored encrypted, hashed on chain. */
  bundle: Uint8Array;
  bundleHash: Hex;
  reason?: string;
  /** App Attest key material needed to check later assertions. */
  appAttest?: { keyId: string; x: Hex; y: Hex };
};

export type CaptureKey = {
  appAttestKeyId: string | null;
  pubX: Hex | null;
  pubY: Hex | null;
  assertionCounter: bigint;
};

export type CaptureResult = { ok: boolean; counter?: bigint; reason?: string };

/**
 * `binding` is the 32-byte value the attestation must commit to:
 * enrolment sha256(addr ‖ challenge); capture sha256(digest ‖ challenge) (plan §4.2).
 */
export interface DeviceAttestation {
  verifyEnrolment(input: {
    platform: Platform;
    binding: Hex;
    attestation: EnrolAttestation;
  }): Promise<EnrolResult>;
  verifyCapture(
    input: { platform: Platform; attestation: CaptureAttestation; key: CaptureKey },
    binding: Hex,
  ): Promise<CaptureResult>;
}
