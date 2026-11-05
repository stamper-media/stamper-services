import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, PUBLIC_ORIGIN } from "../../src/config.js";
import { baseEnv, secretFiles } from "./env.js";

describe("loadConfig (fail closed)", () => {
  it("worker boots with no secrets and an empty secrets object", () => {
    const cfg = loadConfig(baseEnv("worker"));
    expect(cfg.role).toBe("worker");
    expect(cfg.secrets).toEqual({});
    expect(cfg.ml.url).toBeNull();
    expect(cfg.publicBaseUrl).toBe(PUBLIC_ORIGIN);
  });

  it("worker refuses any secret file", () => {
    expect(() => loadConfig(baseEnv("worker", secretFiles(["RELAYER_PK"])))).toThrow(
      /RELAYER_PK_FILE must not be present in ROLE=worker/,
    );
    expect(() => loadConfig(baseEnv("worker", { PLAY_SA_JSON_FILE: "/x" }))).toThrow(ConfigError);
  });

  it("refuses inline secrets in either role", () => {
    expect(() => loadConfig(baseEnv("worker", { REGISTRAR_PK: "0x01" }))).toThrow(
      /REGISTRAR_PK_FILE, not inline/,
    );
    expect(() => loadConfig(baseEnv("api", { ...secretFiles(), RELAYER_PK: "0x01" }))).toThrow(
      /not inline/,
    );
    expect(() => loadConfig(baseEnv("api", { ...secretFiles(), FOC_PAYER_PK: "0x01" }))).toThrow(
      /scripts only/,
    );
    expect(() =>
      loadConfig(baseEnv("worker", { FOC_PAYER_PK_FILE: "/run/secrets/payer" })),
    ).toThrow(/scripts only/);
  });

  it("api without RELAYER_PK_FILE fails", () => {
    expect(() =>
      loadConfig(baseEnv("api", secretFiles(["REGISTRAR_PK", "RECORD_WRAP_KEY"]))),
    ).toThrow(/RELAYER_PK_FILE is required/);
  });

  it("api loads keys from files; secrets are not enumerable", () => {
    const cfg = loadConfig(baseEnv("api", secretFiles()));
    expect(cfg.secrets.relayerPk).toBe(`0x${"1".repeat(64)}`);
    expect(cfg.secrets.recordWrapKey).toBe(`0x${"3".repeat(64)}`);
    expect(
      JSON.stringify(cfg, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("1".repeat(64));
    expect(Object.keys(cfg)).not.toContain("secrets");
  });

  it("rejects a malformed key file", () => {
    const files = secretFiles();
    expect(() =>
      loadConfig(
        baseEnv("api", { ...files, RELAYER_PK_FILE: `${files.REGISTRAR_PK_FILE}.missing` }),
      ),
    ).toThrow(/not readable/);
  });

  it("mock mode needs no FOC ids", () => {
    const cfg = loadConfig(baseEnv("api", secretFiles()));
    expect(cfg.foc.mode).toBe("mock");
    expect(cfg.foc.dataSets.A).toEqual({ id: 1n, providerId: 1n, withCDN: true });
    expect(cfg.foc.dataSets.B.id).toBe(2n);
    expect(cfg.chain.reorgDepth).toBe(0);
  });

  it("real mode requires FOC ids, the session key and Calibration defaults apply", () => {
    const env = baseEnv("worker", {
      CHAIN_ID: "314159",
      FOC_MODE: "real",
      FOC_PAYER_ADDRESS: `0x${"55".repeat(20)}`,
      PDP_VERIFIER_ADDRESS: "",
      FWSS_ADDRESS: "",
    });
    expect(() => loadConfig(env)).toThrow(/FOC_DATASET_A_ID is required/);
    const ids = {
      FOC_DATASET_A_ID: "7",
      FOC_DATASET_A_PROVIDER_ID: "3",
      FOC_DATASET_B_ID: "8",
      FOC_DATASET_B_PROVIDER_ID: "4",
    };
    const cfg = loadConfig({ ...env, ...ids });
    expect(cfg.chain.pdpVerifier).toBe("0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C");
    expect(cfg.chain.reorgDepth).toBe(2);
    expect(cfg.foc.dataSets.B).toEqual({ id: 8n, providerId: 4n, withCDN: false });
    expect(() => loadConfig({ ...env, ...ids, ROLE: "api", ...secretFiles() })).toThrow(
      /FOC_SESSION_PK_FILE is required/,
    );
  });

  it("refuses unsafe mode combinations and bad values", () => {
    expect(() => loadConfig(baseEnv("worker", { CHAIN_ID: "314", FOC_MODE: "real" }))).toThrow(
      /ATTEST_MODE=stub/,
    );
    expect(() => loadConfig(baseEnv("worker", { FOC_MODE: "real" }))).toThrow(
      /requires FOC_MODE=mock/,
    );
    expect(() => loadConfig(baseEnv("worker", { ROLE: "admin" }))).toThrow(/ROLE/);
    expect(() => loadConfig(baseEnv("worker", { REGISTRY_ADDRESS: "0x12" }))).toThrow(
      /REGISTRY_ADDRESS/,
    );
    expect(() => loadConfig(baseEnv("worker", { PORT: "99999" }))).toThrow(/PORT/);
    expect(() => loadConfig(baseEnv("worker", { MIRROR_S3_ENDPOINT: "http://s3.local" }))).toThrow(
      /MIRROR_S3_BUCKET/,
    );
  });

  it("strict attestation needs the Play service account and app ids in the api", () => {
    const env = baseEnv("api", { ...secretFiles(), ATTEST_MODE: "strict" });
    expect(() => loadConfig(env)).toThrow(/PLAY_SA_JSON_FILE is required/);
    const withSa = { ...env, ...secretFiles(["PLAY_SA_JSON"]) };
    expect(() => loadConfig(withSa)).toThrow(/APPLE_TEAM_ID/);
    const cfg = loadConfig({
      ...withSa,
      APPLE_TEAM_ID: "T",
      ANDROID_CERT_SHA256: "AB",
      PLAY_CLOUD_PROJECT_NUMBER: "1",
    });
    expect(cfg.secrets.playSaJson).toContain("service_account");
  });
});
