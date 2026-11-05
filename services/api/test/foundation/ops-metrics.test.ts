import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryQueue } from "../../src/queue/memory.js";
import {
  createMetrics,
  OPS_METRIC,
  probeFailuresGauge,
  queueAgeGauge,
  runwayDaysMetric,
  sampledGauge,
  TX_LATENCY_WINDOW_MS,
  txLatencyMetric,
} from "../../src/shared/metrics.js";

const reg = () => createMetrics("api", { defaults: false });
/** Sample lines (no # comments) of one metric, as healthcheck.sh's awk sees them. */
const lines = async (r: ReturnType<typeof reg>, name: string) =>
  (await r.metrics())
    .split("\n")
    .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));

describe("ops metrics (healthcheck contract)", () => {
  it("uses the metric names infra/scripts/healthcheck.sh alerts on", () => {
    const sh = process.env.STAMPER_PROTOCOL_DIR
      ? `${process.env.STAMPER_PROTOCOL_DIR}/infra/scripts/healthcheck.sh`
      : fileURLToPath(
          new URL("../../../../../stamper-protocol/infra/scripts/healthcheck.sh", import.meta.url),
        );
    if (!existsSync(sh)) return; // infra package absent from this checkout
    const text = readFileSync(sh, "utf8");
    for (const name of Object.values(OPS_METRIC)) expect(text).toContain(`:-${name}}`);
  });

  it("runway: absent until the first check and while nothing is paid for", async () => {
    const r = reg();
    const set = runwayDaysMetric(r);
    expect(runwayDaysMetric(r)).toBe(set);
    expect(await lines(r, OPS_METRIC.runwayDays)).toEqual([]);
    set(42.5);
    expect(await lines(r, OPS_METRIC.runwayDays)).toEqual([
      'stamper_runway_days{token="USDFC",role="api"} 42.5',
    ]);
    set(null);
    expect(await lines(r, OPS_METRIC.runwayDays)).toEqual([]);
  });

  it("tx latency: pending age, then settled latency for the window, then nothing", async () => {
    const r = reg();
    let now = 1_000_000;
    const t = txLatencyMetric(r, () => now);
    expect(txLatencyMetric(r)).toBe(t);
    const settle = t.begin("register");
    t.begin("attach")(now + 2_000);
    now += 400_000;
    expect(await lines(r, OPS_METRIC.txLatencyMax)).toEqual([
      'stamper_tx_latency_seconds_max{kind="attach",role="api"} 2',
      'stamper_tx_latency_seconds_max{kind="register",role="api"} 400',
    ]);
    now += 100_000;
    settle();
    settle(now + 999_000); // idempotent
    now += 60_000;
    expect(await lines(r, OPS_METRIC.txLatencyMax)).toContain(
      'stamper_tx_latency_seconds_max{kind="register",role="api"} 500',
    );
    now += TX_LATENCY_WINDOW_MS;
    expect(await lines(r, OPS_METRIC.txLatencyMax)).toEqual([]);
  });

  it("queue age: zero-filled per queue, oldest wins, throttled, errors keep the last values", async () => {
    const r = reg();
    let calls = 0;
    let fail = false;
    const warned: string[] = [];
    queueAgeGauge(r, {
      queues: ["ingest", "register"],
      minIntervalMs: 0,
      log: { warn: (_o, msg) => warned.push(msg) },
      stats: async () => {
        calls++;
        if (fail) throw new Error("db down");
        return [{ name: "register", oldestAgeSeconds: 720 }];
      },
    });
    const want = [
      'stamper_queue_oldest_age_seconds{queue="ingest",role="api"} 0',
      'stamper_queue_oldest_age_seconds{queue="register",role="api"} 720',
    ];
    expect(await lines(r, OPS_METRIC.queueOldestAge)).toEqual(want);
    fail = true;
    expect(await lines(r, OPS_METRIC.queueOldestAge)).toEqual(want);
    expect(warned).toHaveLength(1);
    expect(calls).toBe(2);

    let n = 0;
    const r2 = reg();
    sampledGauge(r2, {
      name: "stamper_test_sampled",
      help: "t",
      labelNames: ["k"],
      minIntervalMs: 60_000,
      sample: async () => [{ labels: { k: "x" }, value: ++n }],
    });
    await r2.metrics();
    await r2.metrics();
    expect(n).toBe(1);
  });

  it("memory queue stats feed the gauge", async () => {
    const q = createMemoryQueue("worker");
    await q.enqueue("pdp-monitor", {});
    const st = (await q.stats?.()) ?? [];
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ name: "pdp-monitor", waiting: 1 });
    expect(st[0]?.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("probe failures: counted per slot with zero baselines", async () => {
    const r = reg();
    probeFailuresGauge(r, { slots: [0, 1], failing: async () => [{ slot: 1, count: 3 }] });
    expect(await lines(r, OPS_METRIC.probeFailures)).toEqual([
      'stamper_probe_failures{slot="0",role="api"} 0',
      'stamper_probe_failures{slot="1",role="api"} 3',
    ]);
  });
});
