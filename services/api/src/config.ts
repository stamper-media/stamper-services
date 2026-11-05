/**
 * Fail-closed configuration (IMPLEMENTATION-PLAN §WP-06). ROLE decides which secrets are
 * required: the custodian (api) must hold its keys as Docker-secret files, the worker refuses
 * to start if any secret (raw or *_FILE) is present in its environment.
 */
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { z } from "zod";

export type { AppContext } from "./shared/context.js";

/** Canonical public origin; the only place the domain appears in services. */
export const PUBLIC_ORIGIN = "https://stamper.media";

export type Role = "api" | "worker";
export type ChainId = 31337 | 314159 | 314;
export type DataSetRole = "A" | "B";
export type DataSetPin = { id: bigint; providerId: bigint; withCDN: boolean };

/** Structurally the @stamper/foc FocConfig, plus mode and mock SP settings. */
export type FocSettings = {
  mode: "real" | "mock";
  chainId: number;
  rpcUrl: string;
  payerAddress: Address;
  source: "stamper";
  dataSets: Record<DataSetRole, DataSetPin>;
  mockSp: { dir: string; port: number } | null;
};

export type Secrets = {
  relayerPk?: Hex;
  registrarPk?: Hex;
  focSessionPk?: Hex;
  resolverOwnerPk?: Hex;
  recordWrapKey?: Hex;
  playSaJson?: string;
};

export type AppConfig = {
  role: Role;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  chain: {
    id: ChainId;
    rpcUrls: string[];
    registry: Address;
    resolver: Address;
    pdpVerifier: Address;
    fwss: Address;
    reorgDepth: number;
    receiptTimeoutMs: number;
  };
  foc: FocSettings;
  paths: { staging: string; cache: string; models: string };
  mirror: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  } | null;
  ml: { url: string | null };
  attest: {
    mode: "stub" | "strict";
    apple: { teamId?: string; bundleId: string; env: "production" | "development" };
    play: { packageName: string; certSha256?: string; cloudProjectNumber?: string };
  };
  limits: {
    maxImageBytes: number;
    maxVideoBytes: number;
    maxVideoSeconds: number;
    /** TTL of the per-capture challenge (must cover capture + upload); enrolment stays 5 min. */
    captureChallengeTtlMs: number;
  };
  /** Non-enumerable: JSON.stringify(cfg) and spread never carry it. Empty for the worker. */
  secrets: Secrets;
  publicBaseUrl: string;
  verifyBaseUrl: string;
  ntfyUrl?: string;
  schemaWaitMs: number;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Secret names; each may only arrive as `<NAME>_FILE` and only in ROLE=api. */
export const SECRET_ENV = [
  "RELAYER_PK",
  "REGISTRAR_PK",
  "FOC_SESSION_PK",
  "RESOLVER_OWNER_PK",
  "RECORD_WRAP_KEY",
  "PLAY_SA_JSON",
] as const;
/** Never accepted by a service process (scripts only). */
const FORBIDDEN_ENV = ["FOC_PAYER_PK"] as const;

/** Frozen FOC addresses (IMPLEMENTATION-PLAN §0 rule 8). */
const KNOWN: Record<314 | 314159, { pdpVerifier: Address; fwss: Address }> = {
  314: {
    pdpVerifier: "0xBADd0B92C1c71d02E7d520f64c0876538fa2557F",
    fwss: "0x8408502033C418E1bbC97cE9ac48E5528F371A9f",
  },
  314159: {
    pdpVerifier: "0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C",
    fwss: "0x02925630df557F957f70E112bA06e50965417CA0",
  },
};

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const opt = z
  .string()
  .transform((s) => s.trim())
  .optional()
  .transform((s) => (s === undefined || s === "" ? undefined : s));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x address");
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "expected an http(s) URL");
const intIn = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "expected an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const uint = z.string().regex(/^\d+$/, "expected an unsigned integer");

const EnvSchema = z.object({
  ROLE: z.enum(["api", "worker"]),
  HOST: opt.default("0.0.0.0"),
  PORT: opt.pipe(intIn(0, 65535).optional()).default(8080),
  LOG_LEVEL: opt.pipe(z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional()),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "expected a postgres:// URL"),
  CHAIN_ID: z.coerce
    .number()
    .refine(
      (n): n is ChainId => n === 31337 || n === 314159 || n === 314,
      "CHAIN_ID must be 31337, 314159 or 314",
    ),
  RPC_URLS: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    )
    .pipe(z.array(httpUrl).min(1)),
  REGISTRY_ADDRESS: address,
  RESOLVER_ADDRESS: address,
  PDP_VERIFIER_ADDRESS: opt.pipe(address.optional()),
  FWSS_ADDRESS: opt.pipe(address.optional()),
  REORG_DEPTH: opt.pipe(intIn(0, 900).optional()),
  RECEIPT_TIMEOUT_MS: opt.pipe(intIn(1000, 3_600_000).optional()).default(180_000),
  STAGING_DIR: opt.default("/var/lib/stamper/staging"),
  CACHE_DIR: opt.default("/var/lib/stamper/cache"),
  MODELS_DIR: opt.default("/var/lib/stamper/models"),
  ML_URL: opt.pipe(httpUrl.optional()),
  MIRROR_S3_ENDPOINT: opt.pipe(httpUrl.optional()),
  MIRROR_S3_BUCKET: opt,
  MIRROR_S3_REGION: opt,
  MIRROR_S3_ACCESS_KEY_ID: opt,
  MIRROR_S3_SECRET_ACCESS_KEY: opt,
  PUBLIC_BASE_URL: opt.pipe(httpUrl.optional()),
  VERIFY_BASE_URL: opt.pipe(httpUrl.optional()),
  NTFY_URL: opt.pipe(httpUrl.optional()),
  ATTEST_MODE: opt.pipe(z.enum(["stub", "strict"]).optional()).default("strict"),
  APPLE_TEAM_ID: opt,
  IOS_BUNDLE_ID: opt.default("media.stamper.app"),
  APPLE_APP_ATTEST_ENV: opt
    .pipe(z.enum(["production", "development"]).optional())
    .default("production"),
  ANDROID_PACKAGE: opt.default("media.stamper.app"),
  ANDROID_CERT_SHA256: opt,
  PLAY_CLOUD_PROJECT_NUMBER: opt,
  MAX_IMAGE_BYTES: opt.pipe(intIn(1, 2 ** 40).optional()).default(50 * 1024 * 1024),
  MAX_VIDEO_BYTES: opt.pipe(intIn(1, 2 ** 40).optional()).default(500 * 1024 * 1024),
  MAX_VIDEO_SECONDS: opt.pipe(intIn(1, 86_400).optional()).default(180),
  // 60 min ≈ 500 MB at ~1.1 Mbit/s uplink; owner to confirm (see README)
  CAPTURE_CHALLENGE_TTL_S: opt.pipe(intIn(300, 86_400).optional()).default(3600),
  FOC_MODE: opt.pipe(z.enum(["real", "mock"]).optional()).default("real"),
  FOC_CHAIN_ID: opt.pipe(intIn(1, 2 ** 31).optional()),
  FOC_RPC_URL: opt.pipe(httpUrl.optional()),
  FOC_PAYER_ADDRESS: opt.pipe(address.optional()),
  FOC_DATASET_A_ID: opt.pipe(uint.optional()),
  FOC_DATASET_A_PROVIDER_ID: opt.pipe(uint.optional()),
  FOC_DATASET_B_ID: opt.pipe(uint.optional()),
  FOC_DATASET_B_PROVIDER_ID: opt.pipe(uint.optional()),
  MOCK_SP_DIR: opt,
  MOCK_SP_PORT: opt.pipe(intIn(1, 65535).optional()).default(7878),
  SCHEMA_WAIT_MS: opt.pipe(intIn(0, 600_000).optional()).default(60_000),
});

function present(env: NodeJS.ProcessEnv, k: string): boolean {
  const v = env[k];
  return v !== undefined && v.trim() !== "";
}

function readSecretFile(name: string, path: string): string {
  try {
    const v = readFileSync(path, "utf8").trim();
    if (v === "") throw new ConfigError(`${name}_FILE (${path}) is empty`);
    return v;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${name}_FILE (${path}) is not readable`);
  }
}

function asKey(name: string, raw: string): Hex {
  const v = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ConfigError(`${name} must be 32 bytes of hex`);
  return v.toLowerCase() as Hex;
}

function loadSecrets(env: NodeJS.ProcessEnv, role: Role, required: Set<string>): Secrets {
  const issues: string[] = [];
  for (const k of FORBIDDEN_ENV) {
    if (present(env, k) || present(env, `${k}_FILE`)) issues.push(`${k} is for scripts only`);
  }
  for (const k of SECRET_ENV) {
    if (present(env, k)) issues.push(`${k} must be passed as ${k}_FILE, not inline`);
    if (role === "worker" && present(env, `${k}_FILE`)) {
      issues.push(`${k}_FILE must not be present in ROLE=worker (key-free process)`);
    }
    if (role === "api" && required.has(k) && !present(env, `${k}_FILE`)) {
      issues.push(`${k}_FILE is required in ROLE=api`);
    }
  }
  if (issues.length) throw new ConfigError(`refusing to start: ${issues.join("; ")}`);
  if (role === "worker") return {};

  const file = (k: (typeof SECRET_ENV)[number]) => {
    const p = env[`${k}_FILE`];
    return p !== undefined && p.trim() !== "" ? readSecretFile(k, p.trim()) : undefined;
  };
  const s: Secrets = {};
  const keyed = [
    ["RELAYER_PK", "relayerPk"],
    ["REGISTRAR_PK", "registrarPk"],
    ["FOC_SESSION_PK", "focSessionPk"],
    ["RESOLVER_OWNER_PK", "resolverOwnerPk"],
    ["RECORD_WRAP_KEY", "recordWrapKey"],
  ] as const;
  for (const [envName, field] of keyed) {
    const raw = file(envName);
    if (raw !== undefined) s[field] = asKey(envName, raw);
  }
  const sa = file("PLAY_SA_JSON");
  if (sa !== undefined) {
    try {
      const parsed: unknown = JSON.parse(sa);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    } catch {
      throw new ConfigError("PLAY_SA_JSON_FILE does not contain a JSON object");
    }
    s.playSaJson = sa;
  }
  return s;
}

function bigintOf(name: string, v: string | undefined, fallback?: bigint): bigint {
  if (v === undefined) {
    if (fallback === undefined) throw new ConfigError(`${name} is required when FOC_MODE=real`);
    return fallback;
  }
  return BigInt(v);
}

/** Parse and validate the environment. Throws ConfigError with every problem found. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const role = e.ROLE;
  const chainId = e.CHAIN_ID as ChainId;

  if (e.FOC_MODE === "mock" && chainId !== 31337) {
    throw new ConfigError("FOC_MODE=mock is only allowed with CHAIN_ID=31337");
  }
  if (e.FOC_MODE === "real" && chainId === 31337) {
    throw new ConfigError("CHAIN_ID=31337 requires FOC_MODE=mock");
  }
  if (e.ATTEST_MODE === "stub" && chainId === 314) {
    throw new ConfigError("ATTEST_MODE=stub is never allowed on mainnet (CHAIN_ID=314)");
  }

  const required = new Set<string>(["RELAYER_PK", "REGISTRAR_PK", "RECORD_WRAP_KEY"]);
  if (e.FOC_MODE === "real") required.add("FOC_SESSION_PK");
  if (e.ATTEST_MODE === "strict") required.add("PLAY_SA_JSON");
  const secrets = loadSecrets(env, role, required);

  if (role === "api" && e.ATTEST_MODE === "strict") {
    const missing = (
      ["APPLE_TEAM_ID", "ANDROID_CERT_SHA256", "PLAY_CLOUD_PROJECT_NUMBER"] as const
    ).filter((k) => e[k] === undefined);
    if (missing.length) throw new ConfigError(`ATTEST_MODE=strict requires ${missing.join(", ")}`);
  }

  const known = chainId === 31337 ? undefined : KNOWN[chainId];
  const pdpVerifier = (e.PDP_VERIFIER_ADDRESS ?? known?.pdpVerifier) as Address | undefined;
  const fwss = (e.FWSS_ADDRESS ?? known?.fwss) as Address | undefined;
  if (!pdpVerifier || !fwss) {
    throw new ConfigError("PDP_VERIFIER_ADDRESS and FWSS_ADDRESS are required on CHAIN_ID=31337");
  }

  let foc: FocSettings;
  if (e.FOC_MODE === "real") {
    const focChain = e.FOC_CHAIN_ID ?? chainId;
    if (focChain !== chainId) throw new ConfigError("FOC_CHAIN_ID must equal CHAIN_ID");
    if (!e.FOC_PAYER_ADDRESS)
      throw new ConfigError("FOC_PAYER_ADDRESS is required when FOC_MODE=real");
    foc = {
      mode: "real",
      chainId: focChain,
      rpcUrl: e.FOC_RPC_URL ?? (e.RPC_URLS[0] as string),
      payerAddress: e.FOC_PAYER_ADDRESS as Address,
      source: "stamper",
      dataSets: {
        A: {
          id: bigintOf("FOC_DATASET_A_ID", e.FOC_DATASET_A_ID),
          providerId: bigintOf("FOC_DATASET_A_PROVIDER_ID", e.FOC_DATASET_A_PROVIDER_ID),
          withCDN: true,
        },
        B: {
          id: bigintOf("FOC_DATASET_B_ID", e.FOC_DATASET_B_ID),
          providerId: bigintOf("FOC_DATASET_B_PROVIDER_ID", e.FOC_DATASET_B_PROVIDER_ID),
          withCDN: false,
        },
      },
      mockSp: null,
    };
  } else {
    // DeployLocal creates mock sets 1 (A) and 2 (B); ids are optional overrides.
    foc = {
      mode: "mock",
      chainId,
      rpcUrl: e.FOC_RPC_URL ?? (e.RPC_URLS[0] as string),
      payerAddress: (e.FOC_PAYER_ADDRESS as Address | undefined) ?? ZERO_ADDRESS,
      source: "stamper",
      dataSets: {
        A: {
          id: bigintOf("FOC_DATASET_A_ID", e.FOC_DATASET_A_ID, 1n),
          providerId: bigintOf("FOC_DATASET_A_PROVIDER_ID", e.FOC_DATASET_A_PROVIDER_ID, 1n),
          withCDN: true,
        },
        B: {
          id: bigintOf("FOC_DATASET_B_ID", e.FOC_DATASET_B_ID, 2n),
          providerId: bigintOf("FOC_DATASET_B_PROVIDER_ID", e.FOC_DATASET_B_PROVIDER_ID, 2n),
          withCDN: false,
        },
      },
      mockSp: { dir: e.MOCK_SP_DIR ?? "/tmp/stamper-mock-sp", port: e.MOCK_SP_PORT },
    };
  }

  let mirror: AppConfig["mirror"] = null;
  if (e.MIRROR_S3_ENDPOINT) {
    if (!e.MIRROR_S3_BUCKET || !e.MIRROR_S3_REGION) {
      throw new ConfigError(
        "MIRROR_S3_BUCKET and MIRROR_S3_REGION are required with MIRROR_S3_ENDPOINT",
      );
    }
    if (Boolean(e.MIRROR_S3_ACCESS_KEY_ID) !== Boolean(e.MIRROR_S3_SECRET_ACCESS_KEY)) {
      throw new ConfigError(
        "set both MIRROR_S3_ACCESS_KEY_ID and MIRROR_S3_SECRET_ACCESS_KEY or neither",
      );
    }
    mirror = {
      endpoint: e.MIRROR_S3_ENDPOINT,
      bucket: e.MIRROR_S3_BUCKET,
      region: e.MIRROR_S3_REGION,
      ...(e.MIRROR_S3_ACCESS_KEY_ID ? { accessKeyId: e.MIRROR_S3_ACCESS_KEY_ID } : {}),
      ...(e.MIRROR_S3_SECRET_ACCESS_KEY ? { secretAccessKey: e.MIRROR_S3_SECRET_ACCESS_KEY } : {}),
    };
  }

  const stripSlash = (u: string) => u.replace(/\/+$/, "");
  const cfg: Omit<AppConfig, "secrets"> = {
    role,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? "info",
    databaseUrl: e.DATABASE_URL,
    chain: {
      id: chainId,
      rpcUrls: e.RPC_URLS,
      registry: e.REGISTRY_ADDRESS as Address,
      resolver: e.RESOLVER_ADDRESS as Address,
      pdpVerifier,
      fwss,
      reorgDepth: e.REORG_DEPTH ?? (chainId === 31337 ? 0 : 2),
      receiptTimeoutMs: e.RECEIPT_TIMEOUT_MS,
    },
    foc,
    paths: { staging: e.STAGING_DIR, cache: e.CACHE_DIR, models: e.MODELS_DIR },
    mirror,
    ml: { url: e.ML_URL ?? null },
    attest: {
      mode: e.ATTEST_MODE,
      apple: {
        ...(e.APPLE_TEAM_ID ? { teamId: e.APPLE_TEAM_ID } : {}),
        bundleId: e.IOS_BUNDLE_ID,
        env: e.APPLE_APP_ATTEST_ENV,
      },
      play: {
        packageName: e.ANDROID_PACKAGE,
        ...(e.ANDROID_CERT_SHA256 ? { certSha256: e.ANDROID_CERT_SHA256 } : {}),
        ...(e.PLAY_CLOUD_PROJECT_NUMBER ? { cloudProjectNumber: e.PLAY_CLOUD_PROJECT_NUMBER } : {}),
      },
    },
    limits: {
      maxImageBytes: e.MAX_IMAGE_BYTES,
      maxVideoBytes: e.MAX_VIDEO_BYTES,
      maxVideoSeconds: e.MAX_VIDEO_SECONDS,
      captureChallengeTtlMs: e.CAPTURE_CHALLENGE_TTL_S * 1000,
    },
    publicBaseUrl: stripSlash(e.PUBLIC_BASE_URL ?? PUBLIC_ORIGIN),
    verifyBaseUrl: stripSlash(e.VERIFY_BASE_URL ?? PUBLIC_ORIGIN),
    ...(e.NTFY_URL ? { ntfyUrl: e.NTFY_URL } : {}),
    schemaWaitMs: e.SCHEMA_WAIT_MS,
  };
  Object.defineProperty(cfg, "secrets", { value: Object.freeze(secrets), enumerable: false });
  return Object.freeze(cfg) as AppConfig;
}
