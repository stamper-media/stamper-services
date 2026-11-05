import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import type { Db } from "../../db/index.js";
import { challenges } from "../../db/repo/index.js";
import { byteaToHex } from "../../shared/index.js";
import { toHex0x } from "../util.js";

/** Enrolment challenges stay short: the app attests the key right after fetching one. */
export const ENROL_CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Single-use challenge. Capture challenges pass `cfg.limits.captureChallengeTtlMs`
 * (CAPTURE_CHALLENGE_TTL_S): the claim consumes them only after the upload completes, so they
 * must outlive capture + a slow upload; everything else gets the 5-min enrolment TTL.
 */
export async function issueChallenge(
  db: Db,
  kind: "enrol" | "capture",
  keyId: Hex | null,
  ttlMs: number = ENROL_CHALLENGE_TTL_MS,
): Promise<{ challengeId: string; challenge: Hex; expiresAt: string }> {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error(`invalid challenge TTL ${ttlMs}`);
  const value = toHex0x(randomBytes(32));
  const row = await challenges.create(db, { kind, value, keyId, ttlMs });
  return { challengeId: row.id, challenge: value, expiresAt: row.expiresAt.toISOString() };
}

/** Single use within its TTL; returns the challenge value or null (unknown, used, expired, other kind). */
export async function consumeChallenge(
  db: Db,
  id: string,
  kind: "enrol" | "capture",
): Promise<Hex | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await challenges.consume(db, id, kind);
  return row ? byteaToHex(row.value) : null;
}
