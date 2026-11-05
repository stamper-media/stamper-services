import { createHash } from "node:crypto";
import type { Hex } from "viem";

export const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
export const hexBytes = (h: Hex): Uint8Array => new Uint8Array(Buffer.from(h.slice(2), "hex"));
export const toHex0x = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
export const sha256Hex = (...parts: Uint8Array[]): Hex => toHex0x(sha256(...parts));
export const lowerEq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function fromB64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) throw new TypeError("invalid base64");
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}
export const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Client IP as seen behind Caddy: the last X-Forwarded-For hop (the one our proxy appended; earlier
 * hops are client-controlled and would let a caller dodge rate limits), else X-Real-IP, else "local".
 */
export function clientIp(h: (name: string) => string | undefined): string {
  const xff = h("x-forwarded-for");
  if (xff) return xff.split(",").pop()?.trim() || "unknown";
  return h("x-real-ip")?.trim() || "local";
}
