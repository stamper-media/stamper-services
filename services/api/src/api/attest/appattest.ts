import { createPublicKey } from "node:crypto";
import { verifyAssertion, verifyAttestation } from "node-app-attest";
import type { Hex } from "viem";
import { fromB64, toHex0x } from "../util.js";
import { makeBundle } from "./bundle.js";
import type {
  CaptureAttestation,
  CaptureKey,
  CaptureResult,
  EnrolAttestation,
  EnrolResult,
} from "./types.js";

export type AppAttestImpl = {
  verifyAttestation: (p: Record<string, unknown>) => {
    keyId: string;
    publicKey: string;
    receipt: unknown;
    environment: string;
  };
  verifyAssertion: (p: Record<string, unknown>) => { signCount: number };
};

export type AppAttestCfg = { teamId?: string; bundleId: string; env: "production" | "development" };

/**
 * App Attest via node-app-attest (x5c → Apple App Attestation Root CA, nonce, keyId == sha256(pubkey),
 * rpIdHash, counter 0, AAGUID by env). The client passes the binding as the challenge string
 * (lower-case hex without 0x); node-app-attest hashes it into clientDataHash.
 */
export function createAppAttest(
  cfg: AppAttestCfg,
  impl: AppAttestImpl = { verifyAttestation, verifyAssertion } as unknown as AppAttestImpl,
) {
  const challengeString = (binding: Hex) => binding.slice(2).toLowerCase();
  return {
    async verifyEnrolment(binding: Hex, a: EnrolAttestation): Promise<EnrolResult> {
      const fail = (reason: string): EnrolResult => ({
        ok: false,
        level: 0,
        ...makeBundle({
          kind: "appattest",
          keyId: a.keyId ?? null,
          attestationObject: a.attestationObject ?? null,
          error: reason,
        }),
        reason,
      });
      if (!cfg.teamId) return fail("APPLE_TEAM_ID not configured");
      if (!a.keyId || !a.attestationObject) return fail("keyId and attestationObject are required");
      try {
        const r = impl.verifyAttestation({
          attestation: Buffer.from(fromB64(a.attestationObject)),
          challenge: challengeString(binding),
          keyId: a.keyId,
          bundleIdentifier: cfg.bundleId,
          teamIdentifier: cfg.teamId,
          allowDevelopmentEnvironment: cfg.env === "development",
        });
        if (cfg.env === "production" && r.environment !== "production")
          return fail("development AAGUID");
        const jwk = createPublicKey(r.publicKey).export({ format: "jwk" });
        if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) return fail("not a P-256 key");
        const x = toHex0x(fromB64(jwk.x));
        const y = toHex0x(fromB64(jwk.y));
        const { bundle, bundleHash } = makeBundle({
          kind: "appattest",
          keyId: a.keyId,
          attestationObject: a.attestationObject,
          environment: r.environment,
          receipt: r.receipt ? Buffer.from(r.receipt as Uint8Array).toString("base64") : null,
        });
        return { ok: true, level: 1, bundle, bundleHash, appAttest: { keyId: a.keyId, x, y } };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },

    async verifyCapture(
      binding: Hex,
      a: CaptureAttestation,
      key: CaptureKey,
    ): Promise<CaptureResult> {
      if (!cfg.teamId) return { ok: false, reason: "APPLE_TEAM_ID not configured" };
      if (!a.assertion) return { ok: false, reason: "assertion required" };
      if (!key.pubX || !key.pubY) return { ok: false, reason: "no App Attest key enrolled" };
      try {
        const publicKey = createPublicKey({
          key: {
            kty: "EC",
            crv: "P-256",
            x: Buffer.from(key.pubX.slice(2), "hex").toString("base64url"),
            y: Buffer.from(key.pubY.slice(2), "hex").toString("base64url"),
          },
          format: "jwk",
        }).export({ type: "spki", format: "pem" });
        const r = impl.verifyAssertion({
          assertion: Buffer.from(fromB64(a.assertion)),
          payload: challengeString(binding),
          publicKey,
          bundleIdentifier: cfg.bundleId,
          teamIdentifier: cfg.teamId,
          signCount: Number(key.assertionCounter),
        });
        const counter = BigInt(r.signCount);
        if (counter <= key.assertionCounter) return { ok: false, reason: "counter not increasing" };
        return { ok: true, counter };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
