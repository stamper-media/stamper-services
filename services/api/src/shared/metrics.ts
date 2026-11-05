import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export type { Registry };

/**
 * Series infra/scripts/healthcheck.sh alerts on (max of each, min of runway). The worker emits
 * queue age and probe failures; the api (custodian) emits tx latency and runway.
 */
export const OPS_METRIC = {
  queueOldestAge: "stamper_queue_oldest_age_seconds",
  txLatencyMax: "stamper_tx_latency_seconds_max",
  probeFailures: "stamper_probe_failures",
  runwayDays: "stamper_runway_days",
} as const;

export type JobMetrics = {
  jobs: Counter<"name" | "outcome">;
  jobSeconds: Histogram<"name">;
};

const jobMetricsByRegistry = new WeakMap<Registry, JobMetrics>();

/** A fresh registry with process metrics and a `role` default label. */
export function createMetrics(role: string, opts: { defaults?: boolean } = {}): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ role });
  if (opts.defaults !== false) collectDefaultMetrics({ register: registry, prefix: "stamper_" });
  return registry;
}

/** Job counters/histograms, created once per registry (used by the queue adapter). */
export function jobMetrics(registry: Registry): JobMetrics {
  let m = jobMetricsByRegistry.get(registry);
  if (!m) {
    m = {
      jobs: new Counter({
        name: "stamper_jobs_total",
        help: "Jobs processed by name and outcome",
        labelNames: ["name", "outcome"] as const,
        registers: [registry],
      }),
      jobSeconds: new Histogram({
        name: "stamper_job_duration_seconds",
        help: "Job handler duration",
        labelNames: ["name"] as const,
        buckets: [0.05, 0.25, 1, 5, 15, 60, 180, 600],
        registers: [registry],
      }),
    };
    jobMetricsByRegistry.set(registry, m);
  }
  return m;
}

type WarnLog = { warn(obj: object, msg: string): void };
export type GaugeSample = { labels: Record<string, string>; value: number };

/**
 * A labelled gauge recomputed at scrape time from `sample` (a cheap DB read), at most once per
 * `minIntervalMs`. Ops gauges are labelled on purpose: an unlabelled prom-client gauge always
 * exports 0, which a min/max alert would read as a value. A failing sample keeps the previous
 * series and is logged; it never fails the /metrics response. Re-registering a name replaces it.
 */
export function sampledGauge(
  registry: Registry,
  o: {
    name: string;
    help: string;
    labelNames: readonly string[];
    sample: () => Promise<readonly GaugeSample[]>;
    minIntervalMs?: number;
    log?: WarnLog;
    now?: () => number;
  },
): Gauge<string> {
  const now = o.now ?? Date.now;
  const every = o.minIntervalMs ?? 10_000;
  let last = Number.NEGATIVE_INFINITY;
  registry.removeSingleMetric(o.name);
  return new Gauge({
    name: o.name,
    help: o.help,
    labelNames: o.labelNames,
    registers: [registry],
    async collect() {
      const t = now();
      if (t - last < every) return;
      try {
        const samples = await o.sample();
        this.reset();
        for (const s of samples) this.set(s.labels, s.value);
        last = t;
      } catch (err) {
        o.log?.warn({ err, metric: o.name }, "metric sample failed; keeping the previous values");
      }
    },
  });
}

export type QueueAgeSample = { name: string; oldestAgeSeconds: number };

/** Worker: seconds the oldest runnable job of each queue has waited (0 for an empty queue). */
export function queueAgeGauge(
  registry: Registry,
  o: {
    stats: () => Promise<readonly QueueAgeSample[]>;
    queues?: readonly string[];
    log?: WarnLog;
    minIntervalMs?: number;
  },
): Gauge<string> {
  return sampledGauge(registry, {
    name: OPS_METRIC.queueOldestAge,
    help: "Seconds the oldest runnable (queued or retrying, start time reached) job has waited, by queue",
    labelNames: ["queue"],
    log: o.log,
    minIntervalMs: o.minIntervalMs,
    sample: async () => {
      const age = new Map<string, number>((o.queues ?? []).map((q) => [q, 0]));
      for (const s of await o.stats())
        age.set(s.name, Math.max(age.get(s.name) ?? 0, s.oldestAgeSeconds, 0));
      return [...age].map(([queue, value]) => ({ labels: { queue }, value }));
    },
  });
}

/** Worker: bound storage slots whose most recent retrieval probe failed, by binding slot. */
export function probeFailuresGauge(
  registry: Registry,
  o: {
    failing: () => Promise<readonly { slot: number; count: number }[]>;
    slots?: readonly number[];
    log?: WarnLog;
    minIntervalMs?: number;
  },
): Gauge<string> {
  return sampledGauge(registry, {
    name: OPS_METRIC.probeFailures,
    help: "Bindings whose most recent retrieval probe failed (probe_failures > 0), by slot (0 = A, 1 = B)",
    labelNames: ["slot"],
    log: o.log,
    minIntervalMs: o.minIntervalMs,
    sample: async () => {
      const n = new Map<number, number>((o.slots ?? []).map((s) => [s, 0]));
      for (const r of await o.failing()) n.set(r.slot, (n.get(r.slot) ?? 0) + Number(r.count));
      return [...n].map(([slot, value]) => ({ labels: { slot: String(slot) }, value }));
    },
  });
}

/** Settles a tracked tx (included, reverted, dropped or abandoned); idempotent. */
export type TxSettle = (atMs?: number) => void;
export type TxLatency = { begin(kind: string, startedAtMs?: number): TxSettle };

/** Settled txs count towards the max for this long (≥ 2 healthcheck runs at 5 min). */
export const TX_LATENCY_WINDOW_MS = 15 * 60_000;
/** Safety net: a tx nobody settles stops counting after this long. */
export const TX_INFLIGHT_MAX_MS = 6 * 3600_000;
const txLatencyByRegistry = new WeakMap<Registry, TxLatency>();

/**
 * Api (relayer): `stamper_tx_latency_seconds_max{kind}` = the largest of (a) first broadcast →
 * settled for txs settled in the last 15 min and (b) the age of txs still pending, so a stuck tx
 * shows before its receipt timeout fires. One tracker per registry (shared by both relayers).
 */
export function txLatencyMetric(registry: Registry, now: () => number = Date.now): TxLatency {
  const have = txLatencyByRegistry.get(registry);
  if (have) return have;
  const inflight = new Set<{ kind: string; start: number }>();
  const settled: { kind: string; at: number; seconds: number }[] = [];
  const prune = (t: number) => {
    while (settled.length > 0 && t - (settled[0]?.at ?? t) > TX_LATENCY_WINDOW_MS) settled.shift();
    if (settled.length > 10_000) settled.splice(0, settled.length - 10_000);
  };
  new Gauge({
    name: OPS_METRIC.txLatencyMax,
    help: "Max seconds from first broadcast to settlement (txs settled in the last 15 min) or to now (pending txs), by kind",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const t = now();
      prune(t);
      const max = new Map<string, number>();
      const put = (kind: string, s: number) => max.set(kind, Math.max(max.get(kind) ?? 0, s));
      for (const s of settled) put(s.kind, s.seconds);
      for (const e of inflight) {
        if (t - e.start > TX_INFLIGHT_MAX_MS) inflight.delete(e);
        else put(e.kind, Math.max(0, (t - e.start) / 1000));
      }
      this.reset();
      for (const [kind, s] of max) this.set({ kind }, s);
    },
  });
  const tracker: TxLatency = {
    begin(kind, startedAtMs = now()) {
      const e = { kind, start: startedAtMs };
      inflight.add(e);
      let done = false;
      return (atMs = now()) => {
        if (done) return;
        done = true;
        inflight.delete(e);
        settled.push({ kind, at: atMs, seconds: Math.max(0, (atMs - e.start) / 1000) });
        prune(atMs);
      };
    },
  };
  txLatencyByRegistry.set(registry, tracker);
  return tracker;
}

const runwayByRegistry = new WeakMap<Registry, (days: number | null) => void>();

/**
 * Api (runway job): `stamper_runway_days{token="USDFC"}`. Absent until the first runway check
 * and while nothing is being paid for (`days === null`, no lockup rate).
 */
export function runwayDaysMetric(registry: Registry): (days: number | null) => void {
  const have = runwayByRegistry.get(registry);
  if (have) return have;
  const g = new Gauge({
    name: OPS_METRIC.runwayDays,
    help: "Days of FOC storage funding left at the current lockup rate (Filecoin Pay, USDFC)",
    labelNames: ["token"],
    registers: [registry],
  });
  const set = (days: number | null) => {
    if (days === null || !Number.isFinite(days)) g.reset();
    else g.set({ token: "USDFC" }, Math.max(0, days));
  };
  runwayByRegistry.set(registry, set);
  return set;
}
