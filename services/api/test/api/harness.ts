import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CaptureClaim,
  type CaptureRecord,
  claimDeadline,
  encodeRecord,
  hashCaptureClaim,
  keyIdFromAddress,
  pieceCidHex,
  pieceCidOf,
  recordHash,
  stamperDomain,
} from "@stamper/core";
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { type CustodianOpts, startCustodian } from "../../src/api/custodian.js";
import { sha256Hex } from "../../src/api/util.js";
import { type AppConfig, loadConfig } from "../../src/config.js";
import { closeDb, createDb, migrate } from "../../src/db/index.js";
import { createMemoryQueue, type MemoryQueue } from "../../src/queue/memory.js";
import type { AppContext } from "../../src/shared/context.js";
import { createLogger } from "../../src/shared/logger.js";
import { createMetrics } from "../../src/shared/metrics.js";
import { baseEnv } from "../foundation/env.js";

export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  registrar: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  relayer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  resolverOwner: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => res(p));
    });
  });
}

/** Writes key files for the custodian (anvil dev keys by default). */
export function keyFiles(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "stamper-wp07-secrets-"));
  const files: Record<string, string> = {
    RELAYER_PK: ANVIL_KEYS.relayer,
    REGISTRAR_PK: ANVIL_KEYS.registrar,
    RESOLVER_OWNER_PK: ANVIL_KEYS.resolverOwner,
    RECORD_WRAP_KEY: `0x${randomBytes(32).toString("hex")}`,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    const p = join(dir, k);
    writeFileSync(p, `${v}\n`);
    out[`${k}_FILE`] = p;
  }
  return out;
}

export async function apiEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const tmp = mkdtempSync(join(tmpdir(), "stamper-wp07-"));
  return baseEnv("api", {
    ...keyFiles(),
    STAGING_DIR: join(tmp, "staging"),
    CACHE_DIR: join(tmp, "cache"),
    MOCK_SP_DIR: join(tmp, "sp"),
    MOCK_SP_PORT: String(await freePort()),
    APPLE_TEAM_ID: "TEAM123456",
    ANDROID_CERT_SHA256: "ab".repeat(32),
    ...extra,
  });
}

export type Harness = {
  ctx: AppContext;
  cfg: AppConfig;
  queue: MemoryQueue;
  close(): Promise<void>;
  services: Awaited<ReturnType<typeof startCustodian>>["services"];
};

export async function harness(env: NodeJS.ProcessEnv, opts: CustodianOpts = {}): Promise<Harness> {
  const cfg = loadConfig(env);
  const db = await createDb(cfg.databaseUrl, { max: 30 });
  await migrate(db);
  const queue = createMemoryQueue("api");
  const ctx: AppContext = {
    cfg,
    db,
    queue,
    log: createLogger({ role: "api", level: process.env.TEST_LOG_LEVEL ?? "silent" }),
    metrics: createMetrics("api"),
    http: new Hono(),
  };
  const c = await startCustodian(ctx, opts);
  return {
    ctx,
    cfg,
    queue,
    services: c.services,
    async close() {
      await c.close();
      await queue.stop();
      await closeDb(db);
    },
  };
}

export type Device = { account: PrivateKeyAccount; addr: Address; keyId: Hex };
export function newDevice(): Device {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, addr: account.address, keyId: keyIdFromAddress(account.address) };
}

export type BuiltClaim = {
  claim: CaptureClaim;
  digest: Hex;
  sig: Hex;
  record: Uint8Array;
  recordObj: CaptureRecord;
};

/** A complete, signed, self-consistent claim for `bytes` (secp256k1 device key). */
export async function buildClaim(o: {
  bytes: Uint8Array;
  device: Device;
  chainId: 31337;
  registry: Address;
  challenge: Hex | null;
  nonce?: bigint;
  capturedAt?: bigint;
  platform?: "ios" | "android";
  flags?: number;
  recordPatch?: Partial<CaptureRecord>;
  claimPatch?: Partial<CaptureClaim>;
}): Promise<BuiltClaim> {
  const cid = await pieceCidOf(o.bytes);
  const contentHash = sha256Hex(o.bytes);
  const capturedAt = o.capturedAt ?? BigInt(Date.now());
  const offline = ((o.flags ?? 0) & 2) !== 0;
  const recordObj: CaptureRecord = {
    v: 1,
    stampDomain: { chainId: o.chainId, registry: o.registry },
    contentHash,
    pieceCid: pieceCidHex(cid),
    contentLength: o.bytes.length,
    mediaType: "image/jpeg",
    dims: { w: 64, h: 48 },
    capturedAt: Number(capturedAt),
    monotonicNs: "123456789",
    platform: o.platform ?? "android",
    app: { id: "media.stamper.app", version: "1.0.0", build: "1" },
    capture: {
      source: "in-app-camera",
      facing: "back",
      lensId: "0",
      physicalCameraIds: ["0"],
      physicalOnly: true,
    },
    serverChallenge: offline ? null : o.challenge,
    offline,
    sanitised: { removed: ["GPS*"], kept: ["Orientation"] },
    publicExif: { make: "Test", model: "Phone" },
    attestation: { kind: "playintegrity", bundleHash: `0x${"00".repeat(32)}` },
    privateHash: null,
    ...o.recordPatch,
  };
  const record = encodeRecord(recordObj);
  const claim: CaptureClaim = {
    contentHash,
    pieceCid: pieceCidHex(cid),
    contentLength: BigInt(o.bytes.length),
    mediaKind: 1,
    capturedAt,
    recordHash: recordHash(record),
    keyId: o.device.keyId,
    nonce: o.nonce ?? 1n,
    flags: o.flags ?? 0,
    deadline: claimDeadline(capturedAt, offline),
    ...o.claimPatch,
  };
  const digest = hashCaptureClaim(stamperDomain(o.chainId, o.registry), claim);
  const sig = await o.device.account.sign({ hash: digest });
  return { claim, digest, sig, record, recordObj };
}

export const wireClaim = (c: CaptureClaim) => ({
  ...c,
  contentLength: c.contentLength.toString(),
  capturedAt: c.capturedAt.toString(),
  nonce: c.nonce.toString(),
  deadline: c.deadline.toString(),
});
