import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { parsePieceCid } from "@stamper/core";
import type { DataSetRole } from "@stamper/foc";
import { stampEvents, stamps } from "../../db/repo/index.js";
import type { JobPayload } from "../../queue/port.js";
import { byteaToHex } from "../../shared/index.js";
import { ACTOR, type WorkerDeps } from "../deps.js";
import { MediaError, sha256File, stagedOriginalPath } from "../media.js";
import { ensureMirrored, mirrorKey } from "../mirror.js";

const DONE = new Set(["rejected", "withdrawn", "takedown"]);
export const STORE_ORDER: readonly DataSetRole[] = ["A", "B"];

export type StoreOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "stored"; mirrored: boolean; focStored: DataSetRole[] };

/**
 * Mirror first (ADR-017), then FOC store() on A and B, then commit A and B (api).
 * Every step is idempotent per content (head-before-put; store() is idempotent per PieceCID),
 * so a retry resumes. Under FOC_MODE=mock without an in-process FOC the api stores from staging.
 */
export async function handleStore(
  d: WorkerDeps,
  { stampId }: JobPayload["store"],
): Promise<StoreOutcome> {
  const st = await stamps.byId(d.db, stampId);
  if (!st) return { outcome: "skipped", reason: "unknown stamp" };
  if (DONE.has(st.status)) return { outcome: "skipped", reason: `status ${st.status}` };
  if (!st.contentSha256 || !st.pieceCid) throw new Error("stamp has no sha256/pieceCid yet");
  const sha = byteaToHex(st.contentSha256).toLowerCase() as `0x${string}`;
  const path = await stagedOriginalPath(d.db, stampId);
  if ((await sha256File(path)).toLowerCase() !== sha)
    throw new MediaError("hash_mismatch", "staged original does not hash to the registered sha256");
  const size = (await stat(path)).size;
  const mime = st.mime ?? (st.mediaKind === 2 ? "video/mp4" : "image/jpeg");

  let mirrored = false;
  if (d.mirror) {
    await ensureMirrored(d.mirror, mirrorKey.original(sha), { path, size }, mime);
    mirrored = true;
  } else
    d.log.warn({ stampId }, "store: mirror not configured (dev only); skipping the off-box copy");

  const focStored: DataSetRole[] = [];
  if (d.foc) {
    const pieceCid = parsePieceCid(byteaToHex(st.pieceCid));
    for (const ds of STORE_ORDER) {
      const stream = Readable.toWeb(
        createReadStream(path),
      ) as unknown as ReadableStream<Uint8Array>;
      await d.foc.storeOriginal(ds, stream, pieceCid);
      focStored.push(ds);
    }
  } else d.log.info({ stampId }, "store: FOC_MODE=mock; the api stores from staging at commit");

  await stamps.setStatus(d.db, stampId, "stored", { from: ["registered", "marked"] });
  await stampEvents.append(d.db, {
    stampId,
    kind: "stored",
    actor: ACTOR,
    data: { mirrored, dataSets: focStored },
  });
  for (const ds of STORE_ORDER)
    await d.queue.enqueue("commit", { stampId, dataSet: ds }, { singletonKey: `${stampId}:${ds}` });
  return { outcome: "stored", mirrored, focStored };
}
