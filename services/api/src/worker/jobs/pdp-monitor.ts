import type { DataSetHealth, DataSetRole } from "@stamper/foc";
import { eq } from "drizzle-orm";
import { dataSets } from "../../db/index.js";
import type { WorkerDeps } from "../deps.js";

export type PdpReport = {
  ds: DataSetRole;
  health: DataSetHealth | null;
  faults: number;
  alerts: string[];
};

/** Every 10 min: data-set health for A and B → data_sets row; ntfy on fault conditions (DESIGN §5.4). */
export async function handlePdpMonitor(d: WorkerDeps): Promise<PdpReport[]> {
  if (!d.foc) {
    d.log.info("pdp-monitor: no FOC reader under FOC_MODE=mock; skipped");
    return [];
  }
  const head = await d.chain.blockNumber().catch(() => null);
  const out: PdpReport[] = [];
  for (const ds of ["A", "B"] as const) {
    const alerts: string[] = [];
    let health: DataSetHealth | null = null;
    let faults = 0;
    try {
      health = await d.foc.dataSetHealth(ds);
    } catch (e) {
      alerts.push(`health read failed: ${(e as Error).message.slice(0, 160)}`);
    }
    if (health) {
      const h = health;
      const [prev] = await d.db
        .select()
        .from(dataSets)
        .where(eq(dataSets.dataSetId, h.dataSetId))
        .limit(1);
      const overdue =
        h.provenThisPeriod === false &&
        h.provingDeadline != null &&
        head != null &&
        head > h.provingDeadline;
      faults = overdue ? (prev?.faults ?? 0) + 1 : 0;
      if (!h.live) alerts.push("data set is not live");
      if (!h.listenerIsFwss) alerts.push("listener is not FWSS");
      if (h.pdpEndEpoch != null && h.pdpEndEpoch !== 0n)
        alerts.push(`pdpEndEpoch is ${h.pdpEndEpoch}`);
      if (overdue) alerts.push(`proving overdue (deadline ${h.provingDeadline}, head ${head})`);
      if (faults >= 2) alerts.push(`${faults} consecutive faults`);
      const row = {
        role: ds,
        providerId: h.providerId,
        withCdn: ds === "A",
        lastProvenEpoch: h.lastProvenEpoch,
        provingDeadline: h.provingDeadline,
        faults,
        pdpEndEpoch: h.pdpEndEpoch,
        reserve: h.lifecycleReserve?.toString() ?? null,
        checkedAt: d.now(),
      };
      await d.db
        .insert(dataSets)
        .values({ dataSetId: h.dataSetId, ...row })
        .onConflictDoUpdate({ target: dataSets.dataSetId, set: row });
    }
    for (const a of alerts)
      await d.notify({
        title: `pdp-monitor data set ${ds}`,
        message: a,
        priority: 4,
        tags: ["warning"],
      });
    out.push({ ds, health, faults, alerts });
  }
  return out;
}
