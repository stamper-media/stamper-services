import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DERIV_KIND,
  effectiveLevel,
  encodeCode,
  FLAG,
  qrPayload,
  tierSentence,
} from "@stamper/core";
import {
  applyBadgeImage,
  applyBadgeVideo,
  type BadgeFamily,
  paramsHash,
  pdqVariants,
  type RenderParams,
  renderPreview,
  renderShareCard,
  renderThumb,
} from "@stamper/marking";
import { and, eq, inArray } from "drizzle-orm";
import type { Hex } from "viem";
import {
  derivatives,
  deviceKeys,
  renditions as renditionsT,
  stampEvents as stampEventsT,
} from "../../db/index.js";
import { renditions, type StampRow, stampEvents, stamps } from "../../db/repo/index.js";
import type { JobPayload } from "../../queue/port.js";
import { byteaToHex, cachePath, hexToBytea } from "../../shared/index.js";
import { ACTOR, type WorkerDeps } from "../deps.js";
import { sha256Hex, stagedOriginalPath, writeAtomic } from "../media.js";
import { ensureMirrored, mirrorKey } from "../mirror.js";

export const WATERMARK_STRENGTH = 1.0;
export const PREVIEW_EDGE = 1600;
export const THUMB_EDGE = 320;
const DONE = new Set(["rejected", "withdrawn", "takedown"]);
const NULL_WM = new Set(["", "none", "null"]);

export type MarkOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "marked"; derivativeId: number; sha256: Hex; paramsHash: Hex; pdqRows: number };

/** Badge family by effective level (IMPLEMENTATION-PLAN §4 item 7): F1 when ≥ 1, else F0; F2 reserved. */
export function familyFor(level: number): BadgeFamily {
  return level >= 1 ? "F1" : "F0";
}

/** Render the marked copy, PDQ index, previews and share card; then enqueue attach. */
export async function handleMark(
  d: WorkerDeps,
  { stampId }: JobPayload["mark"],
): Promise<MarkOutcome> {
  const st = await stamps.byId(d.db, stampId);
  if (!st) return { outcome: "skipped", reason: "unknown stamp" };
  if (DONE.has(st.status)) return { outcome: "skipped", reason: `status ${st.status}` };
  if (st.code == null || !st.contentSha256) throw new Error("stamp not registered yet");
  const kindWanted = st.mediaKind === 2 ? DERIV_KIND.MARKED_VIDEO : DERIV_KIND.MARKED_IMAGE;

  const [prev] = await d.db
    .select()
    .from(derivatives)
    .where(and(eq(derivatives.stampId, hexToBytea(stampId)), eq(derivatives.kind, kindWanted)))
    .limit(1);
  // Only short-circuit when a previous run finished every step ("marked" event is the last
  // write); a run that crashed after the derivatives row but before PDQ/card/mirror resumes.
  const [done] = prev
    ? await d.db
        .select({ id: stampEventsT.id })
        .from(stampEventsT)
        .where(and(eq(stampEventsT.stampId, hexToBytea(stampId)), eq(stampEventsT.kind, "marked")))
        .limit(1)
    : [];
  if (done && prev?.path && (await exists(prev.path))) {
    if (!prev.attachTx)
      await d.queue.enqueue(
        "attach",
        { stampId, derivativeId: prev.id },
        { singletonKey: `${stampId}:${prev.id}` },
      );
    return { outcome: "skipped", reason: "already marked" };
  }

  const [key] = st.keyId
    ? await d.db.select().from(deviceKeys).where(eq(deviceKeys.keyId, st.keyId)).limit(1)
    : [];
  const level = effectiveLevel(
    { level: st.level ?? 0, registeredEpoch: st.registeredEpoch ?? 0n },
    { revokedEpoch: key?.revokedEpoch ?? 0n },
  );
  const family = familyFor(level);
  const code9 = encodeCode(st.code);
  const imageDigest = byteaToHex(st.contentSha256).toLowerCase();
  const origPath = await stagedOriginalPath(d.db, stampId);
  const isVideo = kindWanted === DERIV_KIND.MARKED_VIDEO;

  let outPath: string;
  let params: RenderParams;
  let marked: Uint8Array;
  let original: Uint8Array | null = null;
  if (!isVideo) {
    original = new Uint8Array(await readFile(origPath));
    const b = await applyBadgeImage(original, { family, code9, imageDigest });
    params = b.params;
    marked = b.bytes;
    if (d.watermarkEnabled) {
      const wm = await d.watermark.encode(marked, st.code, WATERMARK_STRENGTH);
      if (!NULL_WM.has(wm.version)) {
        marked = wm.bytes;
        params = {
          ...params,
          watermark: {
            lib: "trustmark",
            version: wm.version,
            variant: "Q",
            schema: "BCH_SUPER",
            strength: WATERMARK_STRENGTH,
            payload: st.code.toString(),
          },
        };
      } else d.log.info({ stampId }, "mark: ml runs without watermark weights; badge only");
    } else d.log.info({ stampId }, "mark: ML_URL unset; watermark skipped");
    outPath = cachePath(d.cfg, stampId, "share.jpg");
    await writeAtomic(outPath, marked);
  } else {
    outPath = cachePath(d.cfg, stampId, "share.mp4");
    await mkdir(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.${randomBytes(4).toString("hex")}.tmp.mp4`;
    try {
      const v = await applyBadgeVideo(origPath, tmp, { family, code9, imageDigest });
      params = v.params;
      await rename(tmp, outPath);
    } finally {
      await rm(tmp, { force: true });
    }
    marked = new Uint8Array(await readFile(outPath));
  }

  const dSha = sha256Hex(marked);
  const pHash = paramsHash(params);
  const derivativeId = await upsertDerivative(d, st, {
    kind: kindWanted,
    sha256: dSha,
    params,
    paramsHash: pHash,
    path: outPath,
  });

  // PDQ index (images): original, marked copy, and the 10 fixed variants of the original
  let pdqRows = 0;
  if (original && d.pdq) {
    const rows: Array<{ derivativeId: number | null; variant: number; pdq: Hex; quality: number }> =
      [];
    const push = async (bytes: Uint8Array, variant: number, dId: number | null) => {
      const h = await (d.pdq as NonNullable<WorkerDeps["pdq"]>).hash(bytes);
      rows.push({ derivativeId: dId, variant, pdq: byteaToHex(h.bits), quality: h.quality });
    };
    await push(original, 0, null);
    await push(marked, 0, derivativeId);
    for (const v of await pdqVariants(original)) await push(v.bytes, v.variant, null);
    await d.db.transaction(async (tx) => {
      await tx.delete(renditionsT).where(eq(renditionsT.stampId, hexToBytea(stampId)));
      for (const r of rows) await renditions.insertPdq(tx, { stampId, ...r });
    });
    pdqRows = rows.length;
  } else if (original) d.log.info({ stampId }, "mark: no PDQ client; perceptual index skipped");

  // previews and share card (rendered here, never by the api)
  const frame = original ?? (await d.videoFrame(origPath));
  await writeAtomic(
    cachePath(d.cfg, stampId, "preview.jpg"),
    await renderPreview(frame, PREVIEW_EDGE),
  );
  const thumb = await renderThumb(frame, THUMB_EDGE);
  await writeAtomic(cachePath(d.cfg, stampId, "thumb.webp"), thumb);
  const card = await renderShareCard({
    code9,
    tierSentence: tierSentence(tierInput(st, level, key?.keyType ?? 0)).headline,
    qrPayload: qrPayload(code9, d.cfg.publicBaseUrl),
    thumbnail: thumb,
  });
  const cardPath = cachePath(d.cfg, stampId, "share-card.png");
  await writeAtomic(cardPath, card);
  await upsertDerivative(d, st, {
    kind: DERIV_KIND.SHARE_CARD,
    sha256: sha256Hex(card),
    params: { v: 1, renderer: "share-card", code9 },
    paramsHash: null,
    path: cardPath,
  });

  if (d.mirror)
    await ensureMirrored(
      d.mirror,
      mirrorKey.derivative(dSha),
      marked,
      isVideo ? "video/mp4" : "image/jpeg",
    );
  else d.log.warn({ stampId }, "mark: mirror not configured; derivative not mirrored");

  await stamps.setStatus(d.db, stampId, "marked", { from: ["registered"] });
  await stampEvents.append(d.db, {
    stampId,
    kind: "marked",
    actor: ACTOR,
    data: { derivativeId, family, sha256: dSha, paramsHash: pHash, pdqRows },
  });
  await d.queue.enqueue(
    "attach",
    { stampId, derivativeId },
    { singletonKey: `${stampId}:${derivativeId}` },
  );
  return { outcome: "marked", derivativeId, sha256: dSha, paramsHash: pHash, pdqRows };
}

function tierInput(st: StampRow, level: number, keyType: number) {
  let flags = 0;
  try {
    flags = Number((st.claim as { flags?: unknown } | null)?.flags ?? 0) || 0;
  } catch {
    flags = 0;
  }
  return {
    level,
    keyType,
    countersigned: st.countersig != null,
    revokedBeforeStamp: level === 0 && (st.level ?? 0) > 0,
    registrarRemoved: false,
    offline: (flags & FLAG.OFFLINE) !== 0,
    serverComputedCid: (flags & FLAG.PIECECID_SERVER_COMPUTED) !== 0,
  };
}

async function upsertDerivative(
  d: WorkerDeps,
  st: StampRow,
  v: { kind: number; sha256: Hex; params: unknown; paramsHash: Hex | null; path: string },
): Promise<number> {
  return d.db.transaction(async (tx) => {
    // one row per (stamp, kind): a re-render replaces an unattached row of the same kind
    const old = await tx
      .select({ id: derivatives.id, sha256: derivatives.sha256, attachTx: derivatives.attachTx })
      .from(derivatives)
      .where(and(eq(derivatives.stampId, st.stampId), eq(derivatives.kind, v.kind)));
    const same = old.find((o) => byteaToHex(o.sha256).toLowerCase() === v.sha256.toLowerCase());
    if (same) {
      await tx.update(derivatives).set({ path: v.path }).where(eq(derivatives.id, same.id));
      return same.id;
    }
    const stale = old.filter((o) => !o.attachTx).map((o) => o.id);
    if (stale.length) {
      await tx.delete(renditionsT).where(inArray(renditionsT.derivativeId, stale));
      await tx.delete(derivatives).where(inArray(derivatives.id, stale));
    }
    const [row] = await tx
      .insert(derivatives)
      .values({
        stampId: st.stampId,
        kind: v.kind,
        sha256: hexToBytea(v.sha256),
        params: v.params,
        paramsHash: v.paramsHash ? hexToBytea(v.paramsHash) : null,
        path: v.path,
      })
      .returning({ id: derivatives.id });
    if (!row) throw new Error("derivative insert returned no row");
    return row.id;
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
