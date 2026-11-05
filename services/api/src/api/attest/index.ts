import type { AppConfig } from "../../config.js";
import { type AppAttestImpl, createAppAttest } from "./appattest.js";
import { makeBundle } from "./bundle.js";
import { createPlayIntegrity, type DecodeToken, googleDecoder } from "./playintegrity.js";
import { isStubToken, stubCapture, stubEnrol } from "./stub.js";
import type { DeviceAttestation } from "./types.js";

export { stubToken } from "./stub.js";
export * from "./types.js";

export type AttestDeps = {
  appAttest?: AppAttestImpl;
  playDecode?: DecodeToken;
  now?: () => number;
};

/**
 * ATTEST_MODE=stub accepts plan §4.2 stub tokens (and still runs the real verifiers for real
 * evidence); ATTEST_MODE=strict rejects every stub token. kind "none" always yields level 0.
 */
export function createAttestation(cfg: AppConfig, deps: AttestDeps = {}): DeviceAttestation {
  const stubMode = cfg.attest.mode === "stub";
  const apple = createAppAttest(cfg.attest.apple, deps.appAttest);
  const decode: DecodeToken =
    deps.playDecode ??
    (cfg.secrets.playSaJson
      ? googleDecoder(cfg.attest.play.packageName, cfg.secrets.playSaJson)
      : async () => {
          throw new Error("PLAY_SA_JSON not configured");
        });
  const play = createPlayIntegrity(
    {
      packageName: cfg.attest.play.packageName,
      ...(cfg.attest.play.certSha256 ? { certSha256: cfg.attest.play.certSha256 } : {}),
    },
    decode,
    deps.now,
  );
  return {
    async verifyEnrolment({ platform, binding, attestation: a }) {
      if (a.kind === "stub" || isStubToken(a.token)) {
        if (!stubMode) {
          return {
            ok: false,
            level: 0,
            ...makeBundle({ kind: "stub", rejected: "strict" }),
            reason: "stub tokens are rejected in strict mode",
          };
        }
        return stubEnrol(platform, binding, a.token);
      }
      if (a.kind === "appattest" && platform === "ios") return apple.verifyEnrolment(binding, a);
      if (a.kind === "playintegrity" && platform === "android")
        return play.verifyEnrolment(binding, a.token);
      return {
        ok: false,
        level: 0,
        ...makeBundle({ kind: a.kind, platform }),
        reason: "no attestation",
      };
    },
    async verifyCapture({ platform, attestation: a, key }, binding) {
      if (a.kind === "stub" || isStubToken(a.token)) {
        if (!stubMode) return { ok: false, reason: "stub tokens are rejected in strict mode" };
        return stubCapture(platform, binding, a.token);
      }
      if (a.kind === "appattest" && platform === "ios") return apple.verifyCapture(binding, a, key);
      if (a.kind === "playintegrity" && platform === "android")
        return play.verifyCapture(binding, a.token);
      return { ok: false, reason: "no attestation" };
    },
  };
}
