import { rm, stat } from "node:fs/promises";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { captures, uploads, verifyJobs } from "../../db/index.js";
import { byteaToHex } from "../../shared/index.js";
import type { WorkerDeps } from "../deps.js";
import { mirrorKey } from "../mirror.js";

export const ORIGINAL_TTL_MS = 30 * 24 * 3600 * 1000;
export const VERIFY_TTL_MS = 24 * 3600 * 1000;

/**
 * Daily: delete local copies of originals older than 30 d whose mirror object exists with the same
 * size (the api then serves the mirror), and verify-upload files of finished jobs older than 1 d.
 */
export async function handleMirrorGc(
  d: WorkerDeps,
): Promise<{ originals: number; verifyFiles: number }> {
  const now = d.now().getTime();
  let originals = 0;
  if (d.mirror) {
    const rows = await d.db
      .select({ path: uploads.path, sha256: uploads.sha256 })
      .from(uploads)
      .innerJoin(captures, eq(captures.id, uploads.captureId))
      .where(
        and(
          eq(uploads.status, "complete"),
          isNotNull(captures.stampId),
          isNotNull(uploads.sha256),
          lt(uploads.completedAt, new Date(now - ORIGINAL_TTL_MS)),
        ),
      );
    for (const r of rows) {
      const size = await stat(r.path).then(
        (s) => s.size,
        () => null,
      );
      if (size === null || !r.sha256) continue;
      const h = await d.mirror.head(mirrorKey.original(byteaToHex(r.sha256)));
      if (h && h.size === size) {
        await rm(r.path, { force: true });
        originals++;
      }
    }
  } else d.log.info("mirror-gc: mirror not configured; local originals kept");

  const done = await d.db
    .select({ path: verifyJobs.path })
    .from(verifyJobs)
    .where(
      and(
        inArray(verifyJobs.status, ["done", "failed"]),
        lt(verifyJobs.finishedAt, new Date(now - VERIFY_TTL_MS)),
      ),
    );
  let verifyFiles = 0;
  for (const r of done) {
    if (
      await stat(r.path).then(
        () => true,
        () => false,
      )
    ) {
      await rm(r.path, { force: true });
      verifyFiles++;
    }
  }
  return { originals, verifyFiles };
}
