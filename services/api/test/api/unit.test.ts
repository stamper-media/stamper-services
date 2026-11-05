import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  approxLocation,
  captureCountersignatureTypes,
  containsBannedWord,
  encodePrivateRecord,
  exactLocation,
  FOOTER,
  pieceCidHex,
  pieceCidOf,
  privateRecordHash,
  stamperDomain,
  tierSentence,
} from "@stamper/core";
import { type Hex, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createAppAttest } from "../../src/api/attest/appattest.js";
import {
  createAttestation,
  type DeviceAttestation,
  stubToken,
} from "../../src/api/attest/index.js";
import {
  checkPayload,
  createPlayIntegrity,
  type IntegrityPayload,
} from "../../src/api/attest/playintegrity.js";
import {
  type ClaimErrorCode,
  ClaimRejected,
  type EnrolledKey,
  type ValidationDeps,
  validateClaim,
} from "../../src/api/captures/validate-claim.js";
import { open, seal } from "../../src/api/crypto.js";
import { TokenBuckets } from "../../src/api/ratelimit.js";
import { createRegistrar } from "../../src/api/registrar.js";
import { openApiDocument, StampPresentationSchema } from "../../src/api/schemas.js";
import { buildPresentation } from "../../src/api/stamps.js";
import { b64url, hexBytes, sha256, sha256Hex } from "../../src/api/util.js";
import { loadConfig } from "../../src/config.js";
import type { StampRow } from "../../src/db/repo/index.js";
import { baseEnv } from "../foundation/env.js";
import { buildClaim, keyFiles, newDevice } from "./harness.js";

const REGISTRY = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as const;
const domain = stamperDomain(31337, REGISTRY) as ValidationDeps["domain"];
const cfg = loadConfig(baseEnv("api", { ...keyFiles(), REGISTRY_ADDRESS: REGISTRY }));
const stubAttest = createAttestation(cfg);
const rnd32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;

const BYTES = new Uint8Array(randomBytes(3000));
const OTHER = new Uint8Array(randomBytes(200_000));

type Over = {
  build?: Parameters<typeof buildClaim>[0] extends infer P ? Partial<P> : never;
  deps?: (d: ValidationDeps) => void;
  input?: (i: Parameters<typeof validateClaim>[0]) => void;
  token?: "bad";
};

async function scenario(o: Over = {}) {
  const device = newDevice();
  const challenge = rnd32();
  const b = await buildClaim({
    bytes: BYTES,
    device,
    chainId: 31337,
    registry: REGISTRY,
    challenge,
    ...o.build,
  });
  const cid = await pieceCidOf(BYTES);
  const key: EnrolledKey = {
    keyType: 0,
    platform: "android",
    level: 1,
    addr: device.addr,
    x: null,
    y: null,
    rpIdHash: null,
    appAttestKeyId: null,
    pubX: null,
    pubY: null,
    assertionCounter: 0n,
    revoked: false,
  };
  const binding = sha256Hex(hexBytes(b.digest), hexBytes(challenge));
  const input: Parameters<typeof validateClaim>[0] = {
    claim: b.claim,
    sig: b.sig,
    authData: "0x",
    record: b.record,
    attestation: {
      kind: "stub",
      token: o.token === "bad" ? stubToken("android", rnd32()) : stubToken("android", binding),
      challengeId: "c1",
    },
  };
  const deps: ValidationDeps = {
    staged: { sha256: sha256Hex(BYTES), pieceCidHex: pieceCidHex(cid), size: BigInt(BYTES.length) },
    capture: { keyId: device.keyId, mediaKind: 1, challengeId: "c1" },
    key,
    domain,
    nowMs: Date.now(),
    nonceUsed: async () => false,
    consumeChallenge: async (id) => (id === "c1" ? challenge : null),
    attest: stubAttest,
  };
  o.deps?.(deps);
  o.input?.(input);
  return { input, deps };
}

async function expectCode(o: Over, code: ClaimErrorCode) {
  const { input, deps } = await scenario(o);
  const err = await validateClaim(input, deps).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ClaimRejected);
  expect((err as ClaimRejected).code).toBe(code);
}

describe("validate-claim (DESIGN §7.4)", () => {
  it("accepts a consistent claim at the key's level", async () => {
    const { input, deps } = await scenario();
    const v = await validateClaim(input, deps);
    expect(v.level).toBe(1);
    expect(v.serverFlags).toBe(0);
    expect(v.stampId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  const big = async () => pieceCidHex(await pieceCidOf(OTHER));
  const table: Array<[ClaimErrorCode, () => Promise<Over>]> = [
    [
      "ClaimMismatch",
      async () => ({
        deps: (d) => {
          d.capture.keyId = rnd32();
        },
      }),
    ],
    // garbage signature too: the byte check must fire before any signature work
    [
      "HashMismatch",
      async () => ({
        deps: (d) => {
          d.staged.sha256 = rnd32();
        },
        input: (i) => {
          i.sig = "0x00";
        },
      }),
    ],
    [
      "CidMismatch",
      async () => ({
        deps: (d) => {
          d.staged.pieceCidHex = "0x0155";
        },
      }),
    ],
    [
      "LengthMismatch",
      async () => ({
        deps: (d) => {
          d.staged.size += 1n;
        },
      }),
    ],
    [
      "CidInvalid",
      async () => ({
        deps: (d) => {
          d.staged.pieceCidHex = "0x01559120";
        },
        input: (i) => {
          i.claim = { ...i.claim, pieceCid: "0x01559120" };
        },
      }),
    ],
    [
      "LengthOutOfBounds",
      async () => {
        const c = await big();
        return {
          deps: (d) => {
            d.staged.pieceCidHex = c;
          },
          input: (i) => {
            i.claim = { ...i.claim, pieceCid: c };
          },
        };
      },
    ],
    [
      "FlagsInvalid",
      async () => ({
        input: (i) => {
          i.claim = { ...i.claim, flags: 4 };
        },
      }),
    ],
    [
      "KeyRevoked",
      async () => ({
        deps: (d) => {
          d.key.revoked = true;
        },
      }),
    ],
    [
      "BadSig",
      async () => ({
        input: (i) => {
          i.claim = { ...i.claim, nonce: 2n };
        },
      }),
    ],
    [
      "NonceUsed",
      async () => ({
        deps: (d) => {
          d.nonceUsed = async () => true;
        },
      }),
    ],
    [
      "Expired",
      async () => ({
        deps: (d) => {
          d.nowMs = Date.now() + 2 * 3600_000;
        },
      }),
    ],
    [
      "ChallengeInvalid",
      async () => ({
        deps: (d) => {
          d.consumeChallenge = async () => null;
        },
      }),
    ],
    ["AttestationInvalid", async () => ({ token: "bad" })],
    [
      "CounterReplay",
      async () => ({
        deps: (d) => {
          d.key.assertionCounter = 5n;
          d.attest = {
            verifyEnrolment: stubAttest.verifyEnrolment,
            verifyCapture: async () => ({ ok: true, counter: 5n }),
          } as DeviceAttestation;
        },
      }),
    ],
    [
      "RecordHash",
      async () => ({
        input: (i) => {
          i.record = new Uint8Array([...i.record, 0]);
        },
      }),
    ],
    ["RecordMismatch", async () => ({ build: { recordPatch: { contentLength: 1 } } })],
  ];
  for (const [code, mk] of table) {
    it(`rejects ${code}`, async () => expectCode(await mk(), code));
  }

  it("flags a capture time outside ±10 min instead of rejecting it", async () => {
    const { input, deps } = await scenario({
      build: { capturedAt: BigInt(Date.now() - 20 * 60_000) },
    });
    expect((await validateClaim(input, deps)).serverFlags).toBe(1);
  });

  it("a long upload does not flag: receipt starts when the capture was opened", async () => {
    const opened = Date.now() - 50 * 60_000;
    const { input, deps } = await scenario({
      build: { capturedAt: BigInt(opened + 60_000) },
      deps: (d) => {
        d.capture.createdAtMs = opened;
      },
    });
    expect((await validateClaim(input, deps)).serverFlags).toBe(0);
    const recent = Date.now() - 5 * 60_000; // keeps the claim inside its deadline
    const early = await scenario({
      build: { capturedAt: BigInt(recent - 20 * 60_000) },
      deps: (d) => {
        d.capture.createdAtMs = recent;
      },
    });
    expect((await validateClaim(early.input, early.deps)).serverFlags).toBe(1);
  });

  it("an L0 key passes without attestation at level 0", async () => {
    const { input, deps } = await scenario({
      token: "bad",
      deps: (d) => {
        d.key.level = 0;
      },
    });
    expect((await validateClaim(input, deps)).level).toBe(0);
  });

  describe("location: a public cell needs its exact fix, sealed in the private record", () => {
    const fix = exactLocation({
      latitude: -23.5503099,
      longitude: -46.6342009,
      accuracy: 8,
      timestamp: 1,
    });
    const cell = approxLocation(fix, "gps");
    const priv = encodePrivateRecord({ v: 1, salt: rnd32(), location: fix });
    const located = (privateBytes: Uint8Array, extra: Over = {}): Over => ({
      build: { recordPatch: { privateHash: privateRecordHash(privateBytes), location: cell } },
      ...extra,
    });
    it("accepts the cell when the private record hashes to privateHash and holds a fix inside it", async () => {
      const { input, deps } = await scenario(
        located(priv, {
          input: (i) => {
            i.privateRecord = priv;
          },
        }),
      );
      expect((await validateClaim(input, deps)).record.location).toEqual(cell);
    });
    it("rejects a cell sent without the private record", () =>
      expectCode(located(priv), "PrivateRecordInvalid"));
    it("rejects a private record that does not hash to privateHash", () => {
      const other = encodePrivateRecord({ v: 1, salt: rnd32(), location: fix });
      return expectCode(
        located(priv, {
          input: (i) => {
            i.privateRecord = other;
          },
        }),
        "PrivateRecordInvalid",
      );
    });
    it("rejects an exact fix outside the public cell", () => {
      const far = encodePrivateRecord({
        v: 1,
        salt: rnd32(),
        location: { ...fix, latE7: fix.latE7 + 2_000_000 },
      });
      return expectCode(
        located(far, {
          input: (i) => {
            i.privateRecord = far;
          },
        }),
        "PrivateRecordInvalid",
      );
    });
  });
});

describe("attestation", () => {
  const binding = rnd32();
  it("stub accepts only the token for the right binding and platform", async () => {
    expect(
      (
        await stubAttest.verifyEnrolment({
          platform: "android",
          binding,
          attestation: { kind: "stub", token: stubToken("android", binding) },
        })
      ).level,
    ).toBe(1);
    expect(
      (
        await stubAttest.verifyEnrolment({
          platform: "android",
          binding,
          attestation: { kind: "stub", token: stubToken("ios", binding) },
        })
      ).level,
    ).toBe(0);
    expect(
      (
        await stubAttest.verifyEnrolment({
          platform: "android",
          binding,
          attestation: { kind: "stub", token: stubToken("android", rnd32()) },
        })
      ).ok,
    ).toBe(false);
    expect(stubToken("ios", binding)).toBe(`stub:ios:${sha256Hex(hexBytes(binding)).slice(2)}`);
  });

  it("strict mode rejects every stub token", async () => {
    const strict = createAttestation({
      ...cfg,
      secrets: cfg.secrets,
      attest: { ...cfg.attest, mode: "strict" },
    } as typeof cfg);
    const r = await strict.verifyEnrolment({
      platform: "android",
      binding,
      attestation: { kind: "stub", token: stubToken("android", binding) },
    });
    expect(r.ok).toBe(false);
    expect(r.level).toBe(0);
    const k = { appAttestKeyId: null, pubX: null, pubY: null, assertionCounter: 0n };
    expect(
      (
        await strict.verifyCapture(
          {
            platform: "ios",
            attestation: { kind: "appattest", token: stubToken("ios", binding) },
            key: k,
          },
          binding,
        )
      ).ok,
    ).toBe(false);
  });

  const good = (b: Hex, now: number): IntegrityPayload => ({
    requestDetails: {
      requestPackageName: "media.stamper.app",
      requestHash: b64url(sha256(hexBytes(b))),
      timestampMillis: String(now),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      certificateSha256Digest: [Buffer.from("ab".repeat(32), "hex").toString("base64url")],
    },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
  });
  const pcfg = { packageName: "media.stamper.app", certSha256: "ab".repeat(32) };

  it("Play Integrity: verdicts, requestHash, freshness, certificate", async () => {
    const now = Date.now();
    expect(checkPayload(good(binding, now), binding, pcfg, now)).toBeNull();
    const bad: Array<[string, (p: IntegrityPayload) => void]> = [
      [
        "requestHash",
        (p) => {
          p.requestDetails = { ...p.requestDetails, requestHash: "x" };
        },
      ],
      [
        "stale",
        (p) => {
          p.requestDetails = { ...p.requestDetails, timestampMillis: String(now - 11 * 60_000) };
        },
      ],
      [
        "appRecognition",
        (p) => {
          p.appIntegrity = { ...p.appIntegrity, appRecognitionVerdict: "UNRECOGNIZED_VERSION" };
        },
      ],
      [
        "licensing",
        (p) => {
          p.accountDetails = { appLicensingVerdict: "UNLICENSED" };
        },
      ],
      [
        "deviceIntegrity",
        (p) => {
          p.deviceIntegrity = { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] };
        },
      ],
      [
        "cert",
        (p) => {
          p.appIntegrity = { ...p.appIntegrity, certificateSha256Digest: ["zz"] };
        },
      ],
      [
        "package",
        (p) => {
          p.requestDetails = { ...p.requestDetails, requestPackageName: "other" };
        },
      ],
    ];
    for (const [why, f] of bad) {
      const p = good(binding, now);
      f(p);
      expect(checkPayload(p, binding, pcfg, now)).toBe(why);
    }
    const play = createPlayIntegrity(
      pcfg,
      async () => good(binding, now),
      () => now,
    );
    expect((await play.verifyEnrolment(binding, "tok")).level).toBe(1);
    expect((await play.verifyCapture(rnd32(), "tok")).ok).toBe(false);
  });

  it("App Attest: key material from the attestation, assertion counter strictly increasing", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    let seenChallenge = "";
    const apple = createAppAttest(
      { teamId: "T", bundleId: "media.stamper.app", env: "production" },
      {
        verifyAttestation: (p) => {
          seenChallenge = String(p.challenge);
          return {
            keyId: "k",
            publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
            receipt: Buffer.from("r"),
            environment: "production",
          };
        },
        verifyAssertion: (p) => ({ signCount: Number(p.signCount) + 1 }),
      },
    );
    const e = await apple.verifyEnrolment(binding, {
      kind: "appattest",
      keyId: "k",
      attestationObject: "AAAA",
    });
    expect(e.ok).toBe(true);
    expect(seenChallenge).toBe(binding.slice(2));
    expect(e.appAttest?.x).toMatch(/^0x[0-9a-f]{64}$/);
    const key = {
      appAttestKeyId: "k",
      pubX: e.appAttest?.x ?? null,
      pubY: e.appAttest?.y ?? null,
      assertionCounter: 7n,
    };
    expect(
      await apple.verifyCapture(binding, { kind: "appattest", assertion: "AAAA" }, key),
    ).toEqual({ ok: true, counter: 8n });
    const dev = createAppAttest(
      { teamId: "T", bundleId: "b", env: "production" },
      {
        verifyAttestation: () => ({
          keyId: "k",
          publicKey: "",
          receipt: null,
          environment: "development",
        }),
        verifyAssertion: () => ({ signCount: 0 }),
      },
    );
    expect(
      (
        await dev.verifyEnrolment(binding, {
          kind: "appattest",
          keyId: "k",
          attestationObject: "AAAA",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("registrar", () => {
  it("countersignature is level ‖ 65-byte sig and recovers to the registrar", async () => {
    const pk = generatePrivateKey();
    const r = createRegistrar(pk, domain);
    const stampId = rnd32();
    const cs = await r.countersign(stampId, 1);
    expect(hexBytes(cs).length).toBe(66);
    expect(cs.slice(0, 4)).toBe("0x01");
    const who = await recoverTypedDataAddress({
      domain,
      types: captureCountersignatureTypes,
      primaryType: "CaptureCountersignature",
      message: { stampId, level: 1 },
      signature: `0x${cs.slice(4)}`,
    });
    expect(who).toBe(privateKeyToAccount(pk).address);
  });
});

describe("crypto, rate limits, openapi", () => {
  it("AES-GCM round trip", () => {
    const k = rnd32();
    const s = seal(k, new TextEncoder().encode("bundle"));
    expect(open(k, s.iv, s.ciphertext).toString()).toBe("bundle");
  });
  it("token bucket refuses after the budget and refills over time", () => {
    let t = 0;
    const b = new TokenBuckets(() => t);
    for (let i = 0; i < 3; i++) expect(b.take("x", 3).ok).toBe(true);
    expect(b.take("x", 3).ok).toBe(false);
    t += 20_000;
    expect(b.take("x", 3).ok).toBe(true);
  });
  it("OpenAPI document is generated from the zod schemas", () => {
    const d = openApiDocument("https://example.test") as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    expect(d.paths["/v1/captures/{captureId}/claim"]?.post?.requestBody).toBeDefined();
    expect(JSON.parse(JSON.stringify(d))).toBeTruthy();
  });
});

describe("presentation DTO", () => {
  it("carries the core tier sentences and footer, and no banned words", () => {
    const row = {
      stampId: Buffer.alloc(32, 1),
      code: 1n,
      userId: null,
      keyId: Buffer.alloc(32, 2),
      mediaKind: 1,
      mime: "image/jpeg",
      size: 3000n,
      width: 64,
      height: 48,
      durationMs: null,
      contentSha256: Buffer.alloc(32, 3),
      pieceCid: Buffer.from("01559120", "hex"),
      recordCbor: null,
      privateRecordEnc: null,
      claim: { flags: 2 },
      sig: null,
      authData: null,
      countersig: Buffer.alloc(66, 1),
      capturedAt: new Date(),
      receivedAt: new Date(),
      registeredEpoch: 10n,
      registerTx: Buffer.alloc(32, 4),
      status: "registered",
      finality: "included",
      level: 1,
      flags: 1,
      ingest: null,
    } as unknown as StampRow;
    for (const level of [0, 1]) {
      const p = buildPresentation({
        row: { ...row, level } as StampRow,
        code9: "5VEBTVRAF",
        key: { keyType: 0, revokedEpoch: null },
        claimFlags: 2,
        chain: null,
        chainId: 31337,
        baseUrl: "https://example.test",
        renditions: { "share.jpg": true },
        derivatives: [],
        bindings: [],
        bindTxs: 0,
        sources: { providers: [] },
      });
      expect(StampPresentationSchema.safeParse(p).success).toBe(true);
      expect(p.footer).toBe(FOOTER);
      expect(p.tier).toEqual(
        tierSentence({
          level,
          keyType: 0,
          countersigned: true,
          revokedBeforeStamp: false,
          registrarRemoved: false,
          offline: true,
          serverComputedCid: false,
        }),
      );
      for (const t of [p.tier.headline, p.tier.means, p.tier.doesNotMean, p.footer, ...p.flags])
        expect(containsBannedWord(t)).toBeNull();
      expect(p.flags).toEqual(["OFFLINE", "CAPTURE_TIME_SKEW"]);
      expect(p.storageState).toBe("pending");
      expect(p.renditions.share).toBe("https://example.test/v1/stamps/5VEBTVRAF/share.jpg");
    }
  });
});

describe("key isolation", () => {
  const src = join(import.meta.dirname, "../../src");
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      statSync(join(d, f)).isDirectory()
        ? files(join(d, f))
        : f.endsWith(".ts")
          ? [join(d, f)]
          : [],
    );
  it("no module outside src/api imports src/api (except main.ts → api/index.ts)", () => {
    for (const f of files(src).filter((p) => !p.includes("/api/"))) {
      const text = readFileSync(f, "utf8");
      const hits = [...text.matchAll(/from\s+"([^"]*\/api\/[^"]*)"/g)].map((m) => m[1]);
      const allowed = f.endsWith("main.ts") ? ["./api/index.js"] : [];
      expect(
        hits.filter((h) => !allowed.includes(h as string)),
        f,
      ).toEqual([]);
    }
  });
  it("src/api/index.ts loads the secret-bearing custodian only through a dynamic import", () => {
    const text = readFileSync(join(src, "api/index.ts"), "utf8");
    const staticImports = [...text.matchAll(/^import\s+(?!type\b)[^;]+;/gm)];
    expect(staticImports).toEqual([]);
    expect(text).toContain('await import("./custodian.js")');
  });
});
