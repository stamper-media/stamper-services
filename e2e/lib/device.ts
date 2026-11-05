/**
 * Simulated device (Node): a secp256k1 device key, stub attestation tokens and signed claims built
 * exactly as the mobile app builds them (plan §4.2, WP-07 wire contracts).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type ApproxLocation,
  approxLocation,
  type CaptureClaim,
  type CaptureRecord,
  claimDeadline,
  type DomainChainId,
  type ExactLocation,
  encodePrivateRecord,
  encodeRecord,
  exactLocation,
  FLAG,
  hashCaptureClaim,
  hashKeyPossession,
  keyIdFromAddress,
  PF,
  privateRecordHash,
  recordHash,
  stamperDomain,
} from "@stamper/core";
import { type Address, bytesToHex, type Hex, hexToBytes, isHex } from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

export type Platform = "ios" | "android";
export type Device = { account: PrivateKeyAccount; addr: Address; keyId: Hex; platform: Platform };

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export const sha256Hex = (...parts: Uint8Array[]): Hex => bytesToHex(sha256(...parts));

function bytesOf(hex: Hex, len: number, what: string): Uint8Array {
  if (!isHex(hex) || hex.length !== 2 + len * 2)
    throw new TypeError(`${what} must be ${len}-byte hex`);
  return hexToBytes(hex);
}

/** `stub:<platform>:<hex sha256(binding)>`, lower-case hex without 0x. */
export function stubToken(platform: Platform, binding: Hex): string {
  return `stub:${platform}:${sha256Hex(bytesOf(binding, 32, "binding")).slice(2)}`;
}

/** Enrolment binding = sha256(addr20 ‖ challenge32). */
export const enrolBinding = (addr: Address, challenge: Hex): Hex =>
  sha256Hex(bytesOf(addr, 20, "addr"), bytesOf(challenge, 32, "challenge"));

/** Capture binding = sha256(stampId ‖ challenge). */
export const captureBinding = (stampId: Hex, challenge: Hex): Hex =>
  sha256Hex(bytesOf(stampId, 32, "stampId"), bytesOf(challenge, 32, "challenge"));

export function newDevice(platform: Platform = "android", pk: Hex = generatePrivateKey()): Device {
  const account = privateKeyToAccount(pk);
  return { account, addr: account.address, keyId: keyIdFromAddress(account.address), platform };
}

/** Raw signature over core `hashKeyPossession` (secp256k1: x = y = 0). */
export function possessionSig(
  dev: Device,
  chainId: DomainChainId,
  registry: Address,
): Promise<Hex> {
  const hash = hashKeyPossession(stamperDomain(chainId, registry), {
    keyId: dev.keyId,
    keyType: 0,
    platform: dev.platform === "ios" ? PF.IOS : PF.ANDROID,
    x: ZERO32,
    y: ZERO32,
    addr: dev.addr,
  });
  return dev.account.sign({ hash });
}

export type ClaimInput = {
  device: Device;
  chainId: DomainChainId;
  registry: Address;
  bytes: Uint8Array;
  contentHash: Hex;
  pieceCidHex: Hex;
  mediaKind: 1 | 2;
  mediaType: string;
  dims: CaptureRecord["dims"];
  challenge: Hex | null;
  nonce: bigint;
  capturedAt: bigint;
  flags?: number;
  sanitised: { removed: string[]; kept: string[] };
  publicExif: Record<string, string | number>;
  /** "Record location" on: the public cell plus the private record that privateHash commits to. */
  location?: CaptureLocation;
};

export type BuiltClaim = { claim: CaptureClaim; digest: Hex; sig: Hex; record: Uint8Array };

export async function buildClaim(i: ClaimInput): Promise<BuiltClaim> {
  const flags = i.flags ?? 0;
  const offline = (flags & FLAG.OFFLINE) !== 0;
  if (!offline && !i.challenge) throw new Error("an online claim needs the capture challenge");
  const recordObj: CaptureRecord = {
    v: 1,
    stampDomain: { chainId: i.chainId, registry: i.registry },
    contentHash: i.contentHash,
    pieceCid: i.pieceCidHex,
    contentLength: i.bytes.length,
    mediaType: i.mediaType,
    dims: i.dims,
    capturedAt: Number(i.capturedAt),
    monotonicNs: String(process.hrtime.bigint()),
    platform: i.device.platform,
    app: { id: "media.stamper.app", version: "1.0.0", build: "1" },
    capture: {
      source: "in-app-camera",
      facing: "back",
      lensId: "0",
      physicalCameraIds: ["0"],
      physicalOnly: true,
    },
    serverChallenge: offline ? null : i.challenge,
    offline,
    sanitised: i.sanitised,
    publicExif: i.publicExif,
    attestation: {
      kind: i.device.platform === "ios" ? "appattest" : "playintegrity",
      bundleHash: ZERO32,
    },
    privateHash: i.location ? privateRecordHash(i.location.privateRecord) : null,
    ...(i.location ? { location: i.location.cell } : {}),
  };
  const record = encodeRecord(recordObj);
  const claim: CaptureClaim = {
    contentHash: i.contentHash,
    pieceCid: i.pieceCidHex,
    contentLength: BigInt(i.bytes.length),
    mediaKind: i.mediaKind,
    capturedAt: i.capturedAt,
    recordHash: recordHash(record),
    keyId: i.device.keyId,
    nonce: i.nonce,
    flags,
    deadline: claimDeadline(i.capturedAt, offline),
  };
  const digest = hashCaptureClaim(stamperDomain(i.chainId, i.registry), claim);
  const sig = await i.device.account.sign({ hash: digest });
  return { claim, digest, sig, record };
}

/** Claim on the wire: bigints as decimal strings. */
export const wireClaim = (c: CaptureClaim) => ({
  ...c,
  contentLength: c.contentLength.toString(),
  capturedAt: c.capturedAt.toString(),
  nonce: c.nonce.toString(),
  deadline: c.deadline.toString(),
});

/** A capture's location, built as the app builds it (apps/mobile/lib/location.ts). */
export type CaptureLocation = {
  exact: ExactLocation;
  /** Public 0.01° cell; the app reports `fused` (expo-location does not say which radio). */
  cell: ApproxLocation;
  /** Canonical DAG-CBOR PrivateRecord {v, salt, location}, sent as the claim's `privateRecord`. */
  privateRecord: Uint8Array;
};

export type Fix = { latitude: number; longitude: number; accuracy: number };

/** `E2E_LOCATION="lat,lon[,accuracyM]"` → a fix (accuracy defaults to 10 m); undefined when unset. */
export function parseLocation(v: string | undefined): Fix | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const parts = v.split(",").map((x) => x.trim());
  const [lat, lon, acc = "10"] = parts;
  const n = [lat, lon, acc].map((x) => (x === undefined || x === "" ? Number.NaN : Number(x)));
  const [latitude, longitude, accuracy] = n as [number, number, number];
  if (
    parts.length > 3 ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  )
    throw new Error(`E2E_LOCATION must be "lat,lon[,accuracyM]" in degrees and metres, got "${v}"`);
  return { latitude, longitude, accuracy };
}

/** The exact fix in a private record under a fresh 32-byte CSPRNG salt; only the cell goes public. */
export function captureLocation(fix: Fix, fixAt = Date.now()): CaptureLocation {
  const exact = exactLocation({ ...fix, timestamp: fixAt });
  const salt = bytesToHex(new Uint8Array(randomBytes(32)));
  return {
    exact,
    cell: approxLocation(exact, "fused"),
    privateRecord: encodePrivateRecord({ v: 1, salt, location: exact }),
  };
}
