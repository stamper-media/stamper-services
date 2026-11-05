import { count, isNotNull, sql } from "drizzle-orm";
import { bindings } from "../../db/index.js";
import { byteaToHex } from "../../shared/index.js";
import type { WorkerDeps } from "../deps.js";

export const SAMPLE_RATE = 0.02;

/** Weekly: enqueue retrieval probes for a 2 % random sample of bound slots. Returns the count. */
export async function handleProbeSample(d: WorkerDeps): Promise<number> {
  const [c] = await d.db.select({ n: count() }).from(bindings).where(isNotNull(bindings.bindTx));
  const total = Number(c?.n ?? 0);
  if (total === 0) return 0;
  const n = Math.max(1, Math.ceil(total * SAMPLE_RATE));
  const rows = await d.db
    .select({ stampId: bindings.stampId, slot: bindings.slot })
    .from(bindings)
    .where(isNotNull(bindings.bindTx))
    .orderBy(sql`random()`)
    .limit(n);
  for (const r of rows) {
    const stampId = byteaToHex(r.stampId);
    await d.queue.enqueue(
      "probe",
      { stampId, slot: r.slot },
      { singletonKey: `${stampId}:${r.slot}` },
    );
  }
  return rows.length;
}
