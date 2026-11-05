import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Decision,
  decide,
  encodeCode,
  pieceCidHex,
  pieceCidOf,
  type VerifyIO,
  verdictLabel,
} from "@stamper/core";
import { pdqVariants, ssim } from "@stamper/marking";
import { sniff } from "@stamper/minimise";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import type { Hex } from "viem";
import { verifications } from "../../db/index.js";
import { renditions, stamps, type VerifyJobRow, verifyJobs } from "../../db/repo/index.js";
import type { JobPayload } from "../../queue/port.js";
import { byteaToHex, cachePath } from "../../shared/index.js";
import type { WorkerDeps } from "../deps.js";
import { decodeImage, MediaError, sha256Hex, writeAtomic } from "../media.js";

export const PDQ_MIN_QUALITY = 50;
export const KNN_K = 20;
export const KNN_MAX_BITS = 31;
/** Every candidate within this many bits of the best one is shown; the ladder never auto-picks. */
export const CANDIDATE_SPREAD_BITS = 5;
export const DIFF_THRESHOLD = 0.1;

export type Candidate = { stampId: Hex; distance: number; code9?: string; ssim?: number };
export type VerifyResult = {
  verdict: Decision["verdict"];
  label: string;
  path: Decision["path"];
  stampId?: Hex;
  code9?: string;
  candidates?: Candidate[];
  anomaly?: string;
  mediaKind: "image" | "video";
  sha256: Hex;
  pieceCid: Hex;
  diff?: { path: string; width: number; height: number; changedPixels: number; ratio: number };
};

/** DESIGN §8.1 steps 0–5 for an uploaded copy; the result goes to verify_jobs. */
export async function handleVerifyUpload(
  d: WorkerDeps,
  { jobId }: JobPayload["verify-upload"],
): Promise<VerifyResult | null> {
  const job = await verifyJobs.get(d.db, jobId);
  if (!job) {
    d.log.warn({ jobId }, "verify-upload: unknown job");
    return null;
  }
  if (!(await verifyJobs.start(d.db, jobId))) return null;
  try {
    const result = await ladder(d, job);
    await verifyJobs.finish(d.db, jobId, { result });
    await d.db.insert(verifications).values({
      stampId: result.stampId ? Buffer.from(result.stampId.slice(2), "hex") : null,
      method: result.path,
      distance: result.candidates?.[0]?.distance ?? null,
      verdict: result.verdict,
      ipHash: job.ipHash ?? null,
    });
    return result;
  } catch (e) {
    const code = e instanceof MediaError ? e.code : "internal";
    d.log.warn({ err: e, jobId }, "verify-upload failed");
    await verifyJobs.finish(d.db, jobId, { error: code });
    return null;
  }
}

async function ladder(d: WorkerDeps, job: VerifyJobRow): Promise<VerifyResult> {
  const bytes = new Uint8Array(await readFile(job.path));
  if (bytes.byteLength === 0) throw new MediaError("empty");
  if (bytes.byteLength > Math.max(d.cfg.limits.maxImageBytes, d.cfg.limits.maxVideoBytes))
    throw new MediaError("too_large");
  // 0. normalise: sniff; images decode once (EXIF-rotated in every consumer)
  const t = sniff(bytes);
  const isVideo = t === "video/mp4" || t === "video/quicktime";
  if (!isVideo) await decodeImage(bytes);

  const sha256 = sha256Hex(bytes);
  const pieceCid = pieceCidHex(await pieceCidOf(bytes));
  const io: VerifyIO = {
    firstStampOf: (h) => d.chain.firstStampOf(h),
    stampByDerivativeHash: (h) => d.chain.stampByDerivativeHash(h),
    stampByCode: (c) => d.chain.stampByCode(c),
    getStamp: (id) => d.chain.getStamp(id),
  };
  if (!isVideo && d.watermarkEnabled) {
    io.watermarkDecode = async () => {
      try {
        const r = await d.watermark.decode(bytes);
        return r.ok ? r.payload40 : null;
      } catch (e) {
        d.log.warn({ err: e }, "verify-upload: watermark decode unavailable");
        return null;
      }
    };
  }
  let ranked: Candidate[] = [];
  if (!isVideo && d.pdq) {
    io.perceptualSearch = async () => {
      ranked = await perceptual(d, bytes);
      return ranked;
    };
  }
  const decision = await decide({ sha256, pieceCid }, io);
  if (decision.anomaly) {
    await d.notify({
      title: "verify anomaly",
      message: `${decision.anomaly} for upload sha256 ${sha256}`,
      priority: 4,
      tags: ["rotating_light"],
    });
  }

  let candidates: Candidate[] | undefined;
  if (decision.candidates) {
    const extra = new Map(ranked.map((c) => [c.stampId.toLowerCase(), c]));
    candidates = [];
    for (const c of decision.candidates) {
      const row = await stamps.byId(d.db, c.stampId);
      const e = extra.get(c.stampId.toLowerCase());
      candidates.push({
        stampId: c.stampId,
        distance: c.distance,
        ...(row?.code != null ? { code9: encodeCode(row.code) } : {}),
        ...(e?.ssim !== undefined ? { ssim: e.ssim } : {}),
      });
    }
  }
  let code9 = decision.code9;
  if (!code9 && decision.stampId) {
    const row = await stamps.byId(d.db, decision.stampId);
    if (row?.code != null) code9 = encodeCode(row.code);
  }
  const result: VerifyResult = {
    verdict: decision.verdict,
    label: verdictLabel(decision.verdict, code9),
    path: decision.path,
    mediaKind: isVideo ? "video" : "image",
    sha256,
    pieceCid,
    ...(decision.stampId ? { stampId: decision.stampId } : {}),
    ...(code9 ? { code9 } : {}),
    ...(candidates ? { candidates } : {}),
    ...(decision.anomaly ? { anomaly: decision.anomaly } : {}),
  };
  const target =
    decision.verdict === "RELATED_COMPARE"
      ? (decision.stampId ?? candidates?.[0]?.stampId)
      : undefined;
  if (target && !isVideo) {
    const diff = await diffMap(d, job.id, bytes, target).catch((e: unknown) => {
      d.log.warn({ err: e }, "verify-upload: diff map failed");
      return null;
    });
    if (diff) result.diff = diff;
  }
  return result;
}

/** Step 4: PDQ of the copy and its variants → k-NN ≤ 31 bits → SSIM re-rank → within 5 bits of best. */
export async function perceptual(d: WorkerDeps, bytes: Uint8Array): Promise<Candidate[]> {
  const pdq = d.pdq;
  if (!pdq) return [];
  const q = await pdq.hash(bytes);
  if (q.quality < PDQ_MIN_QUALITY) return [];
  const hashes = [q.bits];
  for (const v of await pdqVariants(bytes)) {
    if (v.variant === 0) continue;
    hashes.push((await pdq.hash(v.bytes)).bits);
  }
  const best = new Map<string, number>();
  for (const h of hashes) {
    for (const hit of await renditions.knn(d.db, byteaToHex(h), KNN_K, KNN_MAX_BITS)) {
      const k = hit.stampId.toLowerCase();
      best.set(k, Math.min(best.get(k) ?? 256, hit.distance));
    }
  }
  if (best.size === 0) return [];
  const min = Math.min(...best.values());
  const kept: Candidate[] = [...best]
    .filter(([, dist]) => dist <= min + CANDIDATE_SPREAD_BITS)
    .map(([stampId, distance]) => ({ stampId: stampId as Hex, distance }));
  for (const c of kept) {
    try {
      const ref = new Uint8Array(await readFile(cachePath(d.cfg, c.stampId, "preview.jpg")));
      c.ssim = await ssim(bytes, ref);
    } catch {
      /* no preview cached: rank by distance only */
    }
  }
  return kept.sort((a, b) => a.distance - b.distance || (b.ssim ?? 0) - (a.ssim ?? 0));
}

/** Pixel diff of the copy against the candidate's preview, as a PNG in CACHE_DIR/verify. */
export async function diffMap(
  d: WorkerDeps,
  jobId: string,
  bytes: Uint8Array,
  stampId: Hex,
): Promise<VerifyResult["diff"] | null> {
  let ref: Uint8Array;
  try {
    ref = new Uint8Array(await readFile(cachePath(d.cfg, stampId, "preview.jpg")));
  } catch {
    return null;
  }
  const r = await sharp(ref).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = r.info;
  const c = await sharp(bytes)
    .autoOrient()
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const out = Buffer.alloc(width * height * 4);
  const changed = pixelmatch(r.data, c, out, width, height, { threshold: DIFF_THRESHOLD });
  const path = join(d.cfg.paths.cache, "verify", `${jobId}.diff.png`);
  await writeAtomic(
    path,
    await sharp(out, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
  return { path, width, height, changedPixels: changed, ratio: changed / (width * height) };
}
