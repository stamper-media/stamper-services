import type { Address, Hex } from "viem";
import { z } from "zod";

export const hexStr = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, "expected 0x hex") as unknown as z.ZodType<Hex>;
export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected bytes32 hex") as unknown as z.ZodType<Hex>;
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected an address") as unknown as z.ZodType<Address>;
const u64 = z
  .string()
  .regex(/^\d{1,20}$/, "expected a decimal string")
  .transform((s) => BigInt(s))
  .refine((n) => n < 2n ** 64n, "exceeds uint64");
const b64 = z.string().regex(/^[A-Za-z0-9+/_-]*={0,2}$/, "expected base64");
const uuid = z.string().uuid();

export const ChallengeQuery = z.object({ keyId: bytes32.optional() });
export const ChallengeResponse = z.object({
  challengeId: uuid,
  challenge: bytes32,
  expiresAt: z.string(),
});

export const EnrolBody = z
  .object({
    addr: address,
    keyId: bytes32,
    platform: z.enum(["ios", "android"]),
    /** 0 secp256k1 (MVP), 1 P-256 raw. */
    keyType: z.union([z.literal(0), z.literal(1)]).default(0),
    x: bytes32.optional(),
    y: bytes32.optional(),
    popSig: hexStr,
    attestation: z.object({
      kind: z.enum(["appattest", "playintegrity", "stub", "none"]),
      keyId: z.string().max(200).optional(),
      attestationObject: b64.max(200_000).optional(),
      token: z.string().max(20_000).optional(),
      challengeId: uuid,
    }),
    appInfo: z.object({
      id: z.string().max(200),
      version: z.string().max(50),
      build: z.string().max(50),
    }),
  })
  .strict();
export const EnrolResponse = z.object({
  keyId: bytes32,
  level: z.number().int(),
  txHash: bytes32,
  status: z.literal("registering"),
});

export const CaptureBody = z
  .object({
    keyId: bytes32,
    mediaKind: z.union([z.literal(1), z.literal(2)]),
    expectedSize: u64.optional(),
  })
  .strict();
export const CaptureResponse = z.object({
  captureId: uuid,
  uploadId: uuid,
  challengeId: uuid,
  challenge: bytes32,
});

export const UploadComplete = z.object({
  sha256: bytes32,
  pieceCid: z.string(),
  pieceCidHex: hexStr,
  size: z.string(),
});

export const ClaimWire = z
  .object({
    contentHash: bytes32,
    pieceCid: hexStr,
    contentLength: u64,
    mediaKind: z.union([z.literal(1), z.literal(2)]),
    capturedAt: u64,
    recordHash: bytes32,
    keyId: bytes32,
    nonce: u64,
    flags: z.number().int().min(0).max(255),
    deadline: u64,
  })
  .strict();

export const ClaimBody = z
  .object({
    claim: ClaimWire,
    sig: hexStr,
    authData: hexStr.optional(),
    record: b64.max(64_000),
    attestation: z.object({
      kind: z.enum(["appattest", "playintegrity", "stub", "none"]),
      assertion: b64.max(20_000).optional(),
      token: z.string().max(20_000).optional(),
      challengeId: uuid,
    }),
    privateRecordEnc: b64.max(1_000_000).optional(),
    /** canonical DAG-CBOR private record (exact location, salt); hashed against record.privateHash, sealed at rest */
    privateRecord: b64.max(4_096).optional(),
  })
  .strict();
export const ClaimResponse = z.object({
  stampId: bytes32,
  predictedCode: z.string(),
  attempt: z.number().int(),
  status: z.literal("registering"),
});

export const CaptureStatusResponse = z.object({
  status: z.string(),
  stampId: bytes32.nullable(),
  predictedCode: z.string().nullable(),
  code: z.string().optional(),
  registerTx: bytes32.optional(),
  registeredEpoch: z.string().optional(),
  shareReady: z.boolean(),
  marked: z.string().optional(),
  reissued: z.object({ newCaptureId: uuid }).optional(),
});

export const StampPresentationSchema = z.object({
  code9: z.string(),
  stampId: bytes32,
  status: z.string(),
  finality: z.enum(["pending", "included", "safe", "final"]),
  level: z.number().int(),
  effectiveLevel: z.number().int(),
  tier: z.object({ headline: z.string(), means: z.string(), doesNotMean: z.string() }),
  footer: z.string(),
  flags: z.array(z.string()),
  resolverFlag: z.string().nullable(),
  mediaKind: z.union([z.literal(1), z.literal(2)]),
  mime: z.string(),
  contentHash: bytes32,
  pieceCid: z.string(),
  pieceCidHex: hexStr,
  contentLength: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  capturedAt: z.string(),
  receivedAt: z.string(),
  registeredEpoch: z.string().optional(),
  registeredAtUtc: z.string().optional(),
  registerTx: bytes32.optional(),
  countersigner: address.optional(),
  keyId: bytes32,
  keyType: z.number().int(),
  registrar: address.optional(),
  registrarRemovedAt: z.string().optional(),
  revokedEpoch: z.string().optional(),
  renditions: z.object({
    share: z.string().optional(),
    shareCard: z.string().optional(),
    preview: z.string().optional(),
    thumb: z.string().optional(),
  }),
  derivatives: z.array(
    z.object({
      kind: z.number().int(),
      sha256: bytes32,
      paramsHash: bytes32,
      attachTx: bytes32.optional(),
    }),
  ),
  bindings: z.array(
    z.object({
      slot: z.number().int(),
      asset: z.number().int(),
      dataSetId: z.string(),
      pieceId: z.string(),
      providerId: z.string(),
      serviceUrl: z.string(),
      boundEpoch: z.string(),
      lastProbeAt: z.string().optional(),
      lastOkAt: z.string().optional(),
      probeFailures: z.number().int(),
    }),
  ),
  originalSources: z.object({
    filbeam: z.string().optional(),
    providers: z.array(z.string()),
    mirror: z.string(),
  }),
  storageState: z.enum(["pending", "bound", "unavailable"]),
  explorers: z.object({ blockscout: z.string(), filfox: z.string() }),
  /** the public CaptureRecord (DAG-CBOR, base64); clients check sha256 against the on-chain recordHash */
  record: z.string().nullable().optional(),
});
export type StampPresentation = z.infer<typeof StampPresentationSchema>;

export const VerifyJobResponse = z.object({
  status: z.enum(["queued", "running", "done", "failed"]),
  result: z.unknown().optional(),
});

export const WithdrawBody = z
  .object({
    /** ms since epoch, decimal string; must be within ±10 min. */
    issuedAt: u64,
    /** device-key signature over EIP-191 `withdrawMessage(stampId, issuedAt)`. */
    sig: hexStr,
    authData: hexStr.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const ReportBody = z
  .object({
    code: z.string().min(1).max(40),
    kind: z.enum(["takedown", "copyright", "privacy", "abuse", "other"]),
    contact: z.string().max(320).optional(),
    text: z.string().min(1).max(5000),
  })
  .strict();

type Op = { summary: string; body?: z.ZodType; response?: z.ZodType; params?: string[] };
const API: Record<string, Record<string, Op>> = {
  "/v1/attest/challenge": {
    get: { summary: "Issue a single-use 32-byte challenge (5 min)", response: ChallengeResponse },
  },
  "/v1/devices/{platform}": {
    post: {
      summary: "Enrol a device key (ios|android)",
      body: EnrolBody,
      response: EnrolResponse,
      params: ["platform"],
    },
  },
  "/v1/captures": {
    post: {
      summary: "Open a capture and its upload",
      body: CaptureBody,
      response: CaptureResponse,
    },
  },
  "/v1/uploads/{uploadId}": {
    put: {
      summary: "Resumable upload chunk (Content-Range); 308 partial, 409 gap, 201 complete",
      response: UploadComplete,
      params: ["uploadId"],
    },
    head: { summary: "Bytes received so far (Range: bytes=0-N)", params: ["uploadId"] },
  },
  "/v1/captures/{captureId}/claim": {
    post: {
      summary: "Submit the signed capture claim",
      body: ClaimBody,
      response: ClaimResponse,
      params: ["captureId"],
    },
  },
  "/v1/captures/{captureId}": {
    get: { summary: "Capture status", response: CaptureStatusResponse, params: ["captureId"] },
  },
  "/v1/stamps/{code}": {
    get: { summary: "Stamp presentation", response: StampPresentationSchema, params: ["code"] },
  },
  "/v1/stamps/{code}/{file}": {
    get: {
      summary: "Rendition file (share.jpg|share.mp4|share-card.png|preview.jpg|thumb.webp)",
      params: ["code", "file"],
    },
  },
  "/v1/stamps/{code}/original": {
    get: { summary: "Original bytes (302 to FOC, else proxied)", params: ["code"] },
  },
  "/v1/stamps/{code}/evidence.json": { get: { summary: "Evidence bundle", params: ["code"] } },
  "/v1/stamps/{code}/withdraw": {
    post: {
      summary: "Author withdrawal (device-key signed)",
      body: WithdrawBody,
      params: ["code"],
    },
  },
  "/v1/verify/upload": { post: { summary: "Submit a file for checking (multipart field 'file')" } },
  "/v1/verify/jobs/{jobId}": {
    get: { summary: "Check job status", response: VerifyJobResponse, params: ["jobId"] },
  },
  "/v1/health/storage": {
    get: { summary: "Per data set health, runway, relayer balance, session key" },
  },
  "/v1/reports": { post: { summary: "Report intake", body: ReportBody } },
};

/** OpenAPI 3.1 document generated from the zod schemas (the DTO reference for web and mobile). */
export function openApiDocument(serverUrl: string): Record<string, unknown> {
  const js = (s: z.ZodType) => z.toJSONSchema(s, { unrepresentable: "any", io: "input" });
  const paths: Record<string, unknown> = {};
  for (const [p, ops] of Object.entries(API)) {
    const out: Record<string, unknown> = {};
    for (const [m, op] of Object.entries(ops)) {
      out[m] = {
        summary: op.summary,
        ...(op.params
          ? {
              parameters: op.params.map((n) => ({
                name: n,
                in: "path",
                required: true,
                schema: { type: "string" },
              })),
            }
          : {}),
        ...(op.body
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: js(op.body) } },
              },
            }
          : {}),
        responses: {
          default: op.response
            ? {
                description: "success",
                content: { "application/json": { schema: js(op.response) } },
              }
            : { description: "see summary" },
        },
      };
    }
    paths[p] = out;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Stamper API", version: "1" },
    servers: [{ url: serverUrl }],
    paths,
  };
}
