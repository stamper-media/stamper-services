import type { Hex } from "viem";
import { sha256Hex } from "../util.js";

/** Canonical JSON (sorted keys) of the evidence, and its sha256. */
export function makeBundle(v: Record<string, unknown>): { bundle: Uint8Array; bundleHash: Hex } {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  const bundle = new TextEncoder().encode(JSON.stringify(sort(v)));
  return { bundle, bundleHash: sha256Hex(bundle) };
}
