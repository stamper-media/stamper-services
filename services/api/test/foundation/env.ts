import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const KEY = (b: string) => `0x${b.repeat(64)}`;

/** Write the api secret files into a temp dir and return their *_FILE env entries. */
export function secretFiles(
  names = ["RELAYER_PK", "REGISTRAR_PK", "RECORD_WRAP_KEY"],
): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "stamper-wp06-secrets-"));
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    const p = join(dir, n);
    writeFileSync(
      p,
      n === "PLAY_SA_JSON" ? '{"type":"service_account"}' : `${KEY(String(i + 1))}\n`,
    );
    out[`${n}_FILE`] = p;
  });
  return out;
}

/** Minimal valid anvil/mock environment for a role (no secrets). */
export function baseEnv(
  role: "api" | "worker",
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ROLE: role,
    PORT: "0",
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    CHAIN_ID: "31337",
    RPC_URLS: "http://127.0.0.1:1",
    REGISTRY_ADDRESS: `0x${"11".repeat(20)}`,
    RESOLVER_ADDRESS: `0x${"22".repeat(20)}`,
    PDP_VERIFIER_ADDRESS: `0x${"33".repeat(20)}`,
    FWSS_ADDRESS: `0x${"44".repeat(20)}`,
    FOC_MODE: "mock",
    ATTEST_MODE: "stub",
    STAGING_DIR: join(tmpdir(), "stamper-wp06-staging"),
    CACHE_DIR: join(tmpdir(), "stamper-wp06-cache"),
    MODELS_DIR: join(tmpdir(), "stamper-wp06-models"),
    ...extra,
  };
}
