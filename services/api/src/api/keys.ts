import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { deviceKeys } from "../db/index.js";
import type { Tx } from "../db/repo/index.js";
import { byteaToHex, hexToBytea } from "../shared/index.js";
import type { EnrolledKey } from "./captures/validate-claim.js";

export type DeviceKeyRow = typeof deviceKeys.$inferSelect;

export async function keyRow(db: Tx, keyId: Hex): Promise<DeviceKeyRow | undefined> {
  const [r] = await db
    .select()
    .from(deviceKeys)
    .where(eq(deviceKeys.keyId, hexToBytea(keyId)))
    .limit(1);
  return r;
}

const hx = (b: Buffer | null): Hex | null => (b ? byteaToHex(b) : null);

/** DB row → the shape claim validation needs. For keyType 0, pubX/pubY hold the App Attest key (iOS). */
export function enrolledKey(r: DeviceKeyRow): EnrolledKey {
  const p256 = r.keyType === 1 || r.keyType === 2;
  return {
    keyType: r.keyType,
    platform: r.platform as EnrolledKey["platform"],
    level: r.level,
    addr: (hx(r.addr) as Address | null) ?? null,
    x: p256 ? hx(r.pubX) : null,
    y: p256 ? hx(r.pubY) : null,
    rpIdHash: hx(r.rpIdHash),
    appAttestKeyId: r.appAttestKeyId,
    pubX: hx(r.pubX),
    pubY: hx(r.pubY),
    assertionCounter: r.assertionCounter,
    revoked: r.revokedEpoch !== null && r.revokedEpoch !== 0n,
  };
}
