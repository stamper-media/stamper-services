import { readFile, stat } from "node:fs/promises";
import { ResolverFlag } from "@stamper/contracts-abi";
import { MIN_SHORT_SIDE } from "@stamper/marking";
import { inspectJpeg, inspectMp4, MinimiseError, sniff } from "@stamper/minimise";
import { eq, sql } from "drizzle-orm";
import { derivatives, moderation, stamps as stampsT } from "../../db/index.js";
import { renditions, stampEvents, stamps } from "../../db/repo/index.js";
import type { JobPayload } from "../../queue/port.js";
import { byteaToHex, hexToBytea } from "../../shared/index.js";
import { ACTOR, type WorkerDeps } from "../deps.js";
import { decodeImage, MediaError, sha256Hex, stagedOriginalPath } from "../media.js";

const MEDIA_IMAGE = 1;
const MEDIA_VIDEO = 2;
/** PDQ Hamming distance under which another stamp is noted as a near-duplicate (moderation hint). */
export const NEAR_DUP_BITS = 10;
const VIDEO_CODECS = new Set(["h264", "hevc"]);

export type IngestFacts = {
  sniffed: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
};
export type IngestOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "accepted"; facts: IngestFacts; notes: Record<string, unknown> }
  | { outcome: "rejected"; reasons: string[] };

/** Pre-publication checks on the staged original (DESIGN §3.4 / §6); never marks or stores a reject. */
export async function handleIngest(
  d: WorkerDeps,
  { stampId }: JobPayload["ingest"],
): Promise<IngestOutcome> {
  const st = await stamps.byId(d.db, stampId);
  if (!st) {
    d.log.warn({ stampId }, "ingest: unknown stamp");
    return { outcome: "skipped", reason: "unknown stamp" };
  }
  if (st.status !== "registered" && st.status !== "received")
    return { outcome: "skipped", reason: `status ${st.status}` };

  const path = await stagedOriginalPath(d.db, stampId);
  const reasons: string[] = [];
  const size = (await stat(path)).size;
  const kind = st.mediaKind;
  const limit = kind === MEDIA_VIDEO ? d.cfg.limits.maxVideoBytes : d.cfg.limits.maxImageBytes;
  const facts: IngestFacts = { sniffed: "unknown", size };
  if (kind !== MEDIA_IMAGE && kind !== MEDIA_VIDEO) reasons.push("media_kind_unknown");
  if (size === 0) reasons.push("empty");
  if (size > limit) reasons.push("too_large");

  let bytes: Uint8Array | null = null;
  if (reasons.length === 0) {
    bytes = new Uint8Array(await readFile(path));
    const sha = sha256Hex(bytes);
    if (st.contentSha256 && byteaToHex(st.contentSha256).toLowerCase() !== sha)
      reasons.push("hash_mismatch");
    facts.sniffed = sniff(bytes);
    const isVideo = facts.sniffed === "video/mp4" || facts.sniffed === "video/quicktime";
    if (kind === MEDIA_IMAGE && facts.sniffed !== "image/jpeg") reasons.push("media_kind_mismatch");
    if (kind === MEDIA_VIDEO && !isVideo) reasons.push("media_kind_mismatch");
    if (st.mime && st.mime !== facts.sniffed && !(isVideo && st.mime.startsWith("video/")))
      reasons.push("mime_mismatch");
  }

  if (reasons.length === 0 && bytes) {
    try {
      if (kind === MEDIA_IMAGE) await checkImage(bytes, facts, reasons);
      else await checkVideo(d, path, bytes, facts, reasons);
    } catch (e) {
      if (!(e instanceof MediaError)) throw e;
      reasons.push(e.code);
    }
  }

  const notes: Record<string, unknown> = { abuseScore: 0 };
  if (reasons.length === 0 && bytes) {
    const sha = sha256Hex(bytes);
    const links: Array<{ kind: string; stampId: string }> = [];
    const other = await stamps.bySha256(d.db, sha);
    if (other && byteaToHex(other.stampId).toLowerCase() !== stampId.toLowerCase())
      links.push({ kind: "original", stampId: byteaToHex(other.stampId) });
    const deriv = await d.db
      .select({ stampId: derivatives.stampId })
      .from(derivatives)
      .where(eq(derivatives.sha256, hexToBytea(sha)))
      .limit(1);
    for (const r of deriv) links.push({ kind: "derivative", stampId: byteaToHex(r.stampId) });
    if (links.length) notes.exactDup = links;
    if (kind === MEDIA_IMAGE && d.pdq) {
      try {
        const h = await d.pdq.hash(bytes);
        const hits = await renditions.knn(d.db, byteaToHex(h.bits), 10, NEAR_DUP_BITS);
        const near = new Map<string, number>();
        for (const x of hits) {
          if (x.stampId.toLowerCase() === stampId.toLowerCase()) continue;
          near.set(x.stampId, Math.min(near.get(x.stampId) ?? 256, x.distance));
        }
        if (near.size) notes.nearDup = [...near].map(([s, distance]) => ({ stampId: s, distance }));
      } catch (e) {
        d.log.warn({ err: e, stampId }, "ingest: near-dup hint unavailable");
        notes.nearDup = "unavailable";
      }
    }
  }

  const ok = reasons.length === 0;
  const checks = { ok, reasons, facts, ...notes };
  await d.db.transaction(async (tx) => {
    await tx
      .insert(moderation)
      .values({
        stampId: hexToBytea(stampId),
        checks,
        decision: ok ? "pass" : "reject",
        decidedBy: ACTOR,
        decidedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: moderation.stampId,
        set: { checks, decision: ok ? "pass" : "reject", decidedBy: ACTOR, decidedAt: sql`now()` },
      });
    await tx
      .update(stampsT)
      .set({
        ingest: checks,
        ...(st.size == null ? { size: BigInt(facts.size) } : {}),
        ...(st.width == null && facts.width ? { width: facts.width } : {}),
        ...(st.height == null && facts.height ? { height: facts.height } : {}),
        ...(st.durationMs == null && facts.durationMs ? { durationMs: facts.durationMs } : {}),
      })
      .where(eq(stampsT.stampId, hexToBytea(stampId)));
    if (!ok) await stamps.setStatus(tx, stampId, "rejected", { from: ["received", "registered"] });
    await stampEvents.append(tx, {
      stampId,
      kind: ok ? "ingested" : "rejected",
      actor: ACTOR,
      data: ok ? { facts } : { reasons },
    });
  });

  if (!ok) {
    d.log.info({ stampId, reasons }, "ingest: rejected before publication");
    if (st.code != null) {
      await d.queue.enqueue(
        "flag",
        {
          stampId,
          flag: ResolverFlag.RejectedPrePublication,
          reasonUri: `${d.cfg.publicBaseUrl}/policy/pre-publication#${reasons[0]}`,
        },
        { singletonKey: `${stampId}:reject` },
      );
    }
    return { outcome: "rejected", reasons };
  }
  await d.queue.enqueue("mark", { stampId }, { singletonKey: stampId });
  await d.queue.enqueue("store", { stampId }, { singletonKey: stampId });
  return { outcome: "accepted", facts, notes };
}

async function checkImage(bytes: Uint8Array, facts: IngestFacts, reasons: string[]): Promise<void> {
  const img = await decodeImage(bytes);
  facts.width = img.width;
  facts.height = img.height;
  if (Math.min(img.width, img.height) < MIN_SHORT_SIDE) reasons.push("too_small");
  try {
    const i = inspectJpeg(bytes);
    if (i.hasGps) reasons.push("gps_present");
    if (i.hasSerial) reasons.push("serial_present");
    if (i.hasMakerNote) reasons.push("makernote_present");
    if (i.orientation === undefined) reasons.push("orientation_missing");
  } catch (e) {
    if (e instanceof MinimiseError) reasons.push("metadata_malformed");
    else throw e;
  }
}

async function checkVideo(
  d: WorkerDeps,
  path: string,
  bytes: Uint8Array,
  facts: IngestFacts,
  reasons: string[],
): Promise<void> {
  const p = await d.probeVideo(path);
  facts.width = p.width;
  facts.height = p.height;
  facts.durationMs = p.durationMs;
  if (p.durationMs > d.cfg.limits.maxVideoSeconds * 1000) reasons.push("too_long");
  if (!p.videoCodec || !VIDEO_CODECS.has(p.videoCodec)) reasons.push("video_codec");
  if (p.audioCodecs.some((c) => c !== "aac")) reasons.push("audio_codec");
  try {
    const i = inspectMp4(bytes);
    if (i.hasUdta) reasons.push("udta_present");
    if (i.hasLocation) reasons.push("location_present");
  } catch (e) {
    if (e instanceof MinimiseError) reasons.push("metadata_malformed");
    else throw e;
  }
}
