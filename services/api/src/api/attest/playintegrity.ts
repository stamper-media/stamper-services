import type { Hex } from "viem";
import { b64url, hexBytes, sha256 } from "../util.js";
import { makeBundle } from "./bundle.js";
import type { CaptureResult, EnrolResult } from "./types.js";

/** Subset of the decoded Play Integrity payload we rely on. */
export type IntegrityPayload = {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    timestampMillis?: string | number;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    packageName?: string;
    certificateSha256Digest?: string[];
  };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  accountDetails?: { appLicensingVerdict?: string };
};

export type DecodeToken = (token: string) => Promise<IntegrityPayload>;
export type PlayCfg = { packageName: string; certSha256?: string; maxAgeMs?: number };

/** googleapis decodeIntegrityToken with the PLAY_SA_JSON service account. */
export function googleDecoder(packageName: string, saJson: string): DecodeToken {
  return async (token) => {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(saJson) as Record<string, string>,
      scopes: ["https://www.googleapis.com/auth/playintegrity"],
    });
    const api = google.playintegrity({ version: "v1", auth });
    const res = await api.v1.decodeIntegrityToken({
      packageName,
      requestBody: { integrityToken: token },
    });
    return (res.data.tokenPayloadExternal ?? {}) as IntegrityPayload;
  };
}

const normCert = (s: string) => {
  const t = s.trim();
  if (/^[0-9a-fA-F:]+$/.test(t) && t.replace(/:/g, "").length === 64) {
    return Buffer.from(t.replace(/:/g, ""), "hex").toString("base64url");
  }
  return t.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};

/** PLAY_RECOGNIZED + LICENSED + MEETS_DEVICE_INTEGRITY, requestHash bound, timestamp ≤ 10 min old. */
export function checkPayload(
  p: IntegrityPayload,
  binding: Hex,
  cfg: PlayCfg,
  nowMs: number,
): string | null {
  const rd = p.requestDetails ?? {};
  if (rd.requestPackageName !== cfg.packageName) return "package";
  // plan: base64url(sha256(binding)); DESIGN §7.2 passes base64url(binding). Both commit to the binding.
  const ok = [b64url(sha256(hexBytes(binding))), b64url(hexBytes(binding))];
  if (!rd.requestHash || !ok.includes(rd.requestHash.replace(/=+$/, ""))) return "requestHash";
  const ts = Number(rd.timestampMillis);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > (cfg.maxAgeMs ?? 10 * 60_000)) return "stale";
  if (p.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED") return "appRecognition";
  if (cfg.certSha256) {
    const want = normCert(cfg.certSha256);
    if (!(p.appIntegrity?.certificateSha256Digest ?? []).map(normCert).includes(want))
      return "cert";
  }
  if (p.accountDetails?.appLicensingVerdict !== "LICENSED") return "licensing";
  if (!(p.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes("MEETS_DEVICE_INTEGRITY")) {
    return "deviceIntegrity";
  }
  return null;
}

export function createPlayIntegrity(
  cfg: PlayCfg,
  decode: DecodeToken,
  now: () => number = Date.now,
) {
  return {
    async verifyEnrolment(binding: Hex, token: string | undefined): Promise<EnrolResult> {
      let payload: IntegrityPayload | null = null;
      let reason: string | null;
      if (!token) reason = "token required";
      else {
        try {
          payload = await decode(token);
          reason = checkPayload(payload, binding, cfg, now());
        } catch (e) {
          reason = `decode: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const { bundle, bundleHash } = makeBundle({
        kind: "playintegrity",
        token: token ?? null,
        verdict: payload,
        error: reason,
      });
      return reason
        ? { ok: false, level: 0, bundle, bundleHash, reason }
        : { ok: true, level: 1, bundle, bundleHash };
    },
    async verifyCapture(binding: Hex, token: string | undefined): Promise<CaptureResult> {
      if (!token) return { ok: false, reason: "token required" };
      try {
        const reason = checkPayload(await decode(token), binding, cfg, now());
        return reason ? { ok: false, reason } : { ok: true };
      } catch (e) {
        return { ok: false, reason: `decode: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
