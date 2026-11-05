import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { hexBytes } from "./util.js";

/** AES-256-GCM with RECORD_WRAP_KEY; ciphertext carries the 16-byte tag appended. */
export function seal(keyHex: Hex, plaintext: Uint8Array): { iv: Buffer; ciphertext: Buffer } {
  const key = hexBytes(keyHex);
  if (key.length !== 32) throw new RangeError("RECORD_WRAP_KEY must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { iv, ciphertext: body };
}

export function open(keyHex: Hex, iv: Uint8Array, ciphertext: Uint8Array): Buffer {
  const d = createDecipheriv("aes-256-gcm", hexBytes(keyHex), iv);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
}
