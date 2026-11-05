/**
 * Drizzle schema: DESIGN §9.3 plus captures, uploads, verify_jobs, attestation_bundles and
 * stamp_events (IMPLEMENTATION-PLAN §WP-06). Byte columns are bytea (Buffer in TS); use
 * shared/hexToBytea / byteaToHex at the edges. Migrations live in ./migrations
 * (generated with `pnpm db:generate`, 0000 is the custom `create extension vector`).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  bit,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const big = (name: string) => bigint(name, { mode: "bigint" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  handle: text("handle").unique(),
  tier: text("tier").default("free").notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const deviceKeys = pgTable(
  "device_keys",
  {
    keyId: bytea("key_id").primaryKey(),
    userId: uuid("user_id").references(() => users.id),
    platform: text("platform").notNull(),
    keyType: smallint("key_type").notNull(),
    level: smallint("level").notNull(),
    addr: bytea("addr"),
    pubX: bytea("pub_x"),
    pubY: bytea("pub_y"),
    rpIdHash: bytea("rp_id_hash"),
    attestationHash: bytea("attestation_hash"),
    attestationEnc: bytea("attestation_enc"),
    appAttestKeyId: text("app_attest_key_id"),
    assertionCounter: big("assertion_counter").default(sql`0`).notNull(),
    riskMetric: integer("risk_metric"),
    playVerdict: jsonb("play_verdict"),
    registeredTx: bytea("registered_tx"),
    registeredEpoch: big("registered_epoch"),
    expiresAt: ts("expires_at"),
    revokedEpoch: big("revoked_epoch"),
    revokeReason: smallint("revoke_reason"),
    nextNonce: big("next_nonce").default(sql`1`).notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    check("device_keys_platform_chk", sql`${t.platform} in ('ios','android','web')`),
    index("device_keys_user_idx").on(t.userId),
  ],
);

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    value: bytea("value").notNull(),
    keyId: bytea("key_id"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
  },
  (t) => [index("challenges_expires_idx").on(t.expiresAt)],
);

export const STATUS_SQL = sql.raw(
  "('received','registering','registered','rejected','marked','stored','withdrawn','takedown')",
);
export const FINALITY_SQL = sql.raw("('pending','included','safe','final')");

export const stamps = pgTable(
  "stamps",
  {
    stampId: bytea("stamp_id").primaryKey(),
    code: big("code").unique(),
    userId: uuid("user_id"),
    keyId: bytea("key_id").references(() => deviceKeys.keyId),
    mediaKind: smallint("media_kind"),
    mime: text("mime"),
    size: big("size"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    contentSha256: bytea("content_sha256").unique(),
    pieceCid: bytea("piece_cid"),
    recordCbor: bytea("record_cbor"),
    privateRecordEnc: bytea("private_record_enc"),
    claim: jsonb("claim"),
    sig: bytea("sig"),
    authData: bytea("auth_data"),
    countersig: bytea("countersig"),
    capturedAt: ts("captured_at"),
    receivedAt: ts("received_at").defaultNow().notNull(),
    registeredEpoch: big("registered_epoch"),
    registerTx: bytea("register_tx"),
    status: text("status").default("received").notNull(),
    finality: text("finality").default("pending").notNull(),
    level: smallint("level"),
    flags: smallint("flags").default(0).notNull(),
    ingest: jsonb("ingest"),
  },
  (t) => [
    check("stamps_status_chk", sql`${t.status} in ${STATUS_SQL}`),
    check("stamps_finality_chk", sql`${t.finality} in ${FINALITY_SQL}`),
    index("stamps_status_idx").on(t.status),
  ],
);

export const derivatives = pgTable(
  "derivatives",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stampId: bytea("stamp_id")
      .notNull()
      .references(() => stamps.stampId),
    kind: smallint("kind").notNull(),
    sha256: bytea("sha256").unique().notNull(),
    pieceCid: bytea("piece_cid"),
    params: jsonb("params"),
    paramsHash: bytea("params_hash"),
    path: text("path"),
    attachTx: bytea("attach_tx"),
  },
  (t) => [index("derivatives_stamp_idx").on(t.stampId)],
);

export const renditions = pgTable(
  "renditions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stampId: bytea("stamp_id").notNull(),
    derivativeId: bigint("derivative_id", { mode: "number" }),
    variant: smallint("variant").notNull(),
    pdq: bit("pdq", { dimensions: 256 }).notNull(),
    pdqQuality: integer("pdq_quality"),
  },
  (t) => [
    index("renditions_pdq_hnsw").using("hnsw", t.pdq.op("bit_hamming_ops")),
    index("renditions_stamp_idx").on(t.stampId),
    check("renditions_variant_chk", sql`${t.variant} between 0 and 9`),
  ],
);

export const bindings = pgTable(
  "bindings",
  {
    stampId: bytea("stamp_id").notNull(),
    slot: smallint("slot").notNull(),
    asset: smallint("asset").notNull(),
    dataSetId: big("data_set_id"),
    pieceId: big("piece_id"),
    providerId: big("provider_id"),
    serviceUrl: text("service_url"),
    bindTx: bytea("bind_tx"),
    boundEpoch: big("bound_epoch"),
    lastProbeAt: ts("last_probe_at"),
    lastOkAt: ts("last_ok_at"),
    probeFailures: integer("probe_failures").default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.stampId, t.slot] })],
);

export const dataSets = pgTable("data_sets", {
  dataSetId: big("data_set_id").primaryKey(),
  role: text("role").notNull(),
  providerId: big("provider_id"),
  withCdn: boolean("with_cdn"),
  lastProvenEpoch: big("last_proven_epoch"),
  provingDeadline: big("proving_deadline"),
  faults: integer("faults").default(0).notNull(),
  pdpEndEpoch: big("pdp_end_epoch"),
  reserve: numeric("reserve"),
  checkedAt: ts("checked_at"),
});

/** Transaction outbox; consumed only by ROLE=api. */
export const chainTxs = pgTable(
  "chain_txs",
  {
    hash: bytea("hash").primaryKey(),
    kind: text("kind").notNull(),
    stampId: bytea("stamp_id"),
    sender: bytea("sender"),
    nonce: big("nonce"),
    submittedAt: ts("submitted_at").defaultNow().notNull(),
    includedEpoch: big("included_epoch"),
    safeAt: ts("safe_at"),
    finalAt: ts("final_at"),
    status: text("status").default("submitted").notNull(),
    error: text("error"),
  },
  (t) => [
    check(
      "chain_txs_status_chk",
      sql`${t.status} in ('submitted','included','safe','final','failed','replaced','dropped')`,
    ),
    index("chain_txs_status_idx").on(t.status),
    index("chain_txs_stamp_idx").on(t.stampId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stampId: bytea("stamp_id"),
    method: text("method").notNull(),
    distance: integer("distance"),
    verdict: text("verdict").notNull(),
    ipHash: bytea("ip_hash"),
    at: ts("at").defaultNow().notNull(),
  },
  (t) => [index("verifications_stamp_idx").on(t.stampId)],
);

export const moderation = pgTable("moderation", {
  stampId: bytea("stamp_id").primaryKey(),
  checks: jsonb("checks"),
  decision: text("decision"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  reasonUri: text("reason_uri"),
});

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  stampId: bytea("stamp_id"),
  kind: text("kind").notNull(),
  reporter: text("reporter"),
  status: text("status").default("open").notNull(),
  legalHold: boolean("legal_hold").default(false).notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
  resolvedAt: ts("resolved_at"),
});

/** A capture session: device key + challenge, then one upload and one claim. */
export const captures = pgTable(
  "captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: bytea("key_id")
      .notNull()
      .references(() => deviceKeys.keyId),
    userId: uuid("user_id"),
    mediaKind: smallint("media_kind").notNull(),
    challengeId: uuid("challenge_id").references(() => challenges.id),
    expectedSize: big("expected_size"),
    status: text("status").default("open").notNull(),
    stampId: bytea("stamp_id"),
    predictedCode: big("predicted_code"),
    reissuedCaptureId: uuid("reissued_capture_id"),
    createdAt: ts("created_at").defaultNow().notNull(),
    claimedAt: ts("claimed_at"),
  },
  (t) => [
    check(
      "captures_status_chk",
      sql`${t.status} in ('open','uploaded','claimed','rejected','expired','reissued')`,
    ),
    index("captures_key_idx").on(t.keyId),
    index("captures_stamp_idx").on(t.stampId),
  ],
);

/** Resumable sequential upload into STAGING_DIR. */
export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => captures.id),
    totalSize: big("total_size"),
    received: big("received").default(sql`0`).notNull(),
    path: text("path").notNull(),
    sha256: bytea("sha256"),
    pieceCid: bytea("piece_cid"),
    status: text("status").default("open").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    check("uploads_status_chk", sql`${t.status} in ('open','complete','aborted')`),
    check("uploads_received_chk", sql`${t.received} >= 0`),
    index("uploads_capture_idx").on(t.captureId),
  ],
);

/** POST /verify/upload jobs; the worker fills `result` (ladder outcome + candidates). */
export const verifyJobs = pgTable(
  "verify_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").default("queued").notNull(),
    path: text("path").notNull(),
    mime: text("mime"),
    size: big("size"),
    ipHash: bytea("ip_hash"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: ts("created_at").defaultNow().notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    check("verify_jobs_status_chk", sql`${t.status} in ('queued','running','done','failed')`),
    index("verify_jobs_created_idx").on(t.createdAt),
  ],
);

/** Raw attestation evidence, AES-256-GCM under RECORD_WRAP_KEY (api only). */
export const attestationBundles = pgTable(
  "attestation_bundles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    keyId: bytea("key_id").notNull(),
    stampId: bytea("stamp_id"),
    kind: text("kind").notNull(),
    platform: text("platform").notNull(),
    sha256: bytea("sha256").notNull(),
    iv: bytea("iv").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    check("attestation_bundles_kind_chk", sql`${t.kind} in ('enrol','capture')`),
    index("attestation_bundles_key_idx").on(t.keyId),
  ],
);

/** Append-only audit log per stamp. */
export const stampEvents = pgTable(
  "stamp_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stampId: bytea("stamp_id"),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    data: jsonb("data"),
    at: ts("at").defaultNow().notNull(),
  },
  (t) => [index("stamp_events_stamp_idx").on(t.stampId, t.at)],
);
