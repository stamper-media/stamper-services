import type { Hex } from "viem";
import { hexBytes, sha256Hex } from "../util.js";
import { makeBundle } from "./bundle.js";
import type { CaptureResult, EnrolResult, Platform } from "./types.js";

/** Plan §4.2: `stub:<ios|android>:<hex sha256(binding)>` (lower-case hex, no 0x). */
export function stubToken(platform: Platform, binding: Hex): string {
  return `stub:${platform}:${sha256Hex(hexBytes(binding)).slice(2)}`;
}

export function isStubToken(token: string | undefined): boolean {
  return typeof token === "string" && token.startsWith("stub:");
}

export function checkStub(platform: Platform, binding: Hex, token: string | undefined): boolean {
  if (!token) return false;
  return token.trim().toLowerCase() === stubToken(platform, binding);
}

export function stubEnrol(platform: Platform, binding: Hex, token?: string): EnrolResult {
  const ok = checkStub(platform, binding, token);
  const { bundle, bundleHash } = makeBundle({ kind: "stub", platform, token: token ?? null, ok });
  return ok
    ? { ok, level: 1, bundle, bundleHash }
    : { ok, level: 0, bundle, bundleHash, reason: "stub token does not commit to the binding" };
}

export function stubCapture(platform: Platform, binding: Hex, token?: string): CaptureResult {
  return checkStub(platform, binding, token)
    ? { ok: true }
    : { ok: false, reason: "stub token does not commit to the binding" };
}
