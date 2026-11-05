import { parsePieceCid } from "@stamper/core";
import { downloadAndVerify } from "@stamper/foc";
import { and, eq, sql } from "drizzle-orm";
import { bindings as bindingsT } from "../../db/index.js";
import { bindings, stampEvents, stamps } from "../../db/repo/index.js";
import type { JobPayload } from "../../queue/port.js";
import { byteaToHex } from "../../shared/index.js";
import { ACTOR, type WorkerDeps } from "../deps.js";

export const REPAIR_AFTER_MS = 3 * 24 * 3600 * 1000;
export const PROBE_TIMEOUT_MS = 120_000;
const SLOT_ROLE = ["A", "B"] as const;

export type ProbeOutcome =
  | { outcome: "skipped"; reason: string }
  | {
      outcome: "probed";
      ok: boolean;
      results: Array<{ url: string; ok: boolean; error?: string }>;
    };

/** Retrieval probe of one bound slot: download from the provider (and FilBeam for A), re-hash. */
export async function handleProbe(
  d: WorkerDeps,
  { stampId, slot }: JobPayload["probe"],
): Promise<ProbeOutcome> {
  const st = await stamps.byId(d.db, stampId);
  if (!st?.contentSha256 || !st.pieceCid) return { outcome: "skipped", reason: "unknown stamp" };
  const b = (await bindings.forStamp(d.db, stampId)).find((x) => x.slot === slot);
  if (!b) return { outcome: "skipped", reason: "no binding" };
  const pieceCid = parsePieceCid(byteaToHex(st.pieceCid));
  const sha256 = byteaToHex(st.contentSha256);

  const urls = new Set<string>();
  if (b.serviceUrl) urls.add(b.serviceUrl);
  if (d.foc) {
    try {
      const r = await d.foc.retrievalUrls(pieceCid);
      const p = r.providers.find((x) => b.providerId != null && x.providerId === b.providerId);
      if (p) urls.add(p.url);
      if (SLOT_ROLE[slot] === "A" && r.filbeam) urls.add(r.filbeam);
    } catch (e) {
      d.log.warn({ err: e, stampId }, "probe: retrievalUrls failed");
    }
  }
  if (urls.size === 0) return { outcome: "skipped", reason: "no retrieval url" };

  const results: Array<{ url: string; ok: boolean; error?: string }> = [];
  for (const url of urls) {
    const r = await downloadAndVerify(
      url,
      { sha256, pieceCid },
      { timeoutMs: PROBE_TIMEOUT_MS, fetch: d.fetch },
    );
    results.push({ url, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
  const ok = results.every((r) => r.ok);
  const now = d.now();
  const [row] = await d.db
    .update(bindingsT)
    .set(
      ok
        ? { lastProbeAt: now, lastOkAt: now, probeFailures: 0 }
        : { lastProbeAt: now, probeFailures: sql`${bindingsT.probeFailures} + 1` },
    )
    .where(and(eq(bindingsT.stampId, b.stampId), eq(bindingsT.slot, slot)))
    .returning({ failures: bindingsT.probeFailures, lastOkAt: bindingsT.lastOkAt });
  await stampEvents.append(d.db, {
    stampId,
    kind: "probe",
    actor: ACTOR,
    data: { slot, ok, results },
  });

  if (!ok) {
    const since = row?.lastOkAt ?? null;
    const failingFor = since ? now.getTime() - since.getTime() : null;
    const failures = row?.failures ?? 0;
    if (failingFor === null ? failures >= 3 : failingFor >= REPAIR_AFTER_MS) {
      await d.notify({
        title: "repair needed",
        message: `Retrieval probe failing for stamp ${stampId} slot ${slot} (${failures} failures; last success ${since?.toISOString() ?? "never"}).`,
        priority: 4,
        tags: ["warning"],
      });
    }
  }
  return { outcome: "probed", ok, results };
}
