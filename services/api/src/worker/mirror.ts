import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { Hex } from "viem";
import type { AppConfig } from "../config.js";

/**
 * Off-box mirror (DESIGN §5.4, ADR-017). Key layout is a contract with the api's /original proxy:
 * originals at `originals/<sha256 hex>`, derivatives at `d/<sha256 hex>` (lowercase, no 0x).
 */
export const mirrorKey = {
  original: (sha256: Hex) => `originals/${strip(sha256)}`,
  derivative: (sha256: Hex) => `d/${strip(sha256)}`,
};

function strip(h: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new TypeError("sha256 must be 32-byte 0x hex");
  return h.slice(2).toLowerCase();
}

export type MirrorBody = Uint8Array | { path: string; size: number };
export type MirrorHead = { size: number; etag: string | null };

export interface Mirror {
  /** Uploads and checks the returned ETag against the body's MD5; throws MirrorError otherwise. */
  put(key: string, body: MirrorBody, contentType: string): Promise<{ etag: string }>;
  /** null when the object does not exist. */
  head(key: string): Promise<MirrorHead | null>;
}

export class MirrorError extends Error {
  override name = "MirrorError";
}

export async function md5Of(body: MirrorBody): Promise<Buffer> {
  const h = createHash("md5");
  if (body instanceof Uint8Array) return h.update(body).digest();
  for await (const chunk of createReadStream(body.path)) h.update(chunk as Buffer);
  return h.digest();
}

const unquote = (e: string | undefined | null) =>
  e ? e.replace(/^W\//, "").replace(/"/g, "") : null;

/** Ensures `key` exists with `size` bytes; uploads otherwise. Returns true when a put happened. */
export async function ensureMirrored(
  m: Mirror,
  key: string,
  body: MirrorBody,
  contentType: string,
): Promise<boolean> {
  const size = body instanceof Uint8Array ? body.byteLength : body.size;
  const h = await m.head(key);
  if (h && h.size === size) return false;
  await m.put(key, body, contentType);
  return true;
}

type MirrorCfg = NonNullable<AppConfig["mirror"]>;

export function createS3Mirror(cfg: MirrorCfg, client?: Pick<S3Client, "send">): Mirror {
  const conf: S3ClientConfig = {
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  };
  const s3 = client ?? new S3Client(conf);
  return {
    async put(key, body, contentType) {
      const md5 = await md5Of(body);
      const size = body instanceof Uint8Array ? body.byteLength : body.size;
      const out = await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body instanceof Uint8Array ? body : createReadStream(body.path),
          ContentLength: size,
          ContentType: contentType,
          ContentMD5: md5.toString("base64"),
        }),
      );
      const etag = unquote(out.ETag);
      // single-part PUT without SSE-KMS: ETag is the hex MD5 of the body
      if (!etag || (/^[0-9a-f]{32}$/i.test(etag) && etag.toLowerCase() !== md5.toString("hex"))) {
        throw new MirrorError(`mirror ETag mismatch for ${key}: got ${etag ?? "none"}`);
      }
      return { etag };
    },
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0), etag: unquote(r.ETag) };
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
  };
}
