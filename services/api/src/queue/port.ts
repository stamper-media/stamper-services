/**
 * Queue port: the single source of job names, payloads and role ownership
 * (IMPLEMENTATION-PLAN §4 item 4). A role may enqueue any job but may only register handlers
 * for, and schedule, the jobs it owns; violating that throws QueueRoleError at boot.
 */
import type { Hex } from "viem";
import { z } from "zod";

export type Role = "api" | "worker";

export const JOB_NAMES = [
  "register",
  "attach",
  "commit",
  "bind",
  "flag",
  "finality",
  "runway",
  "ingest",
  "mark",
  "store",
  "probe",
  "verify-upload",
  "pdp-monitor",
  "probe-sample",
  "mirror-gc",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

type Empty = Record<string, never>;
export type JobPayload = {
  register: { stampId: Hex };
  attach: { stampId: Hex; derivativeId: number };
  commit: { stampId: Hex; dataSet: "A" | "B" };
  bind: { stampId: Hex };
  flag: { stampId: Hex; flag: number; reasonUri: string };
  ingest: { stampId: Hex };
  mark: { stampId: Hex };
  store: { stampId: Hex };
  probe: { stampId: Hex; slot: number };
  "verify-upload": { jobId: string };
  finality: Empty;
  runway: Empty;
  "pdp-monitor": Empty;
  "probe-sample": Empty;
  "mirror-gc": Empty;
};

/** api = holds keys (custodian); worker = key-free pipeline. */
export const JOB_ROLE: Readonly<Record<JobName, Role>> = Object.freeze({
  register: "api",
  attach: "api",
  commit: "api",
  bind: "api",
  flag: "api",
  finality: "api",
  runway: "api",
  ingest: "worker",
  mark: "worker",
  store: "worker",
  probe: "worker",
  "verify-upload": "worker",
  "pdp-monitor": "worker",
  "probe-sample": "worker",
  "mirror-gc": "worker",
});

/** Default repeat schedules (DESIGN §9.4); the owning role calls queue.schedule at start. */
export const DEFAULT_SCHEDULES: Readonly<Partial<Record<JobName, string>>> = Object.freeze({
  finality: "* * * * *", // pg-boss cron resolution is 1 min; the handler loops twice (30 s)
  runway: "0 * * * *",
  "pdp-monitor": "*/10 * * * *",
  "probe-sample": "0 3 * * 1",
  "mirror-gc": "30 4 * * *",
});

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected bytes32 hex") as unknown as z.ZodType<Hex>;
const empty = z.object({}).strict() as unknown as z.ZodType<Empty>;

export const JOB_SCHEMAS: { [N in JobName]: z.ZodType<JobPayload[N]> } = {
  register: z.object({ stampId: bytes32 }).strict(),
  attach: z.object({ stampId: bytes32, derivativeId: z.number().int().positive() }).strict(),
  commit: z.object({ stampId: bytes32, dataSet: z.enum(["A", "B"]) }).strict(),
  bind: z.object({ stampId: bytes32 }).strict(),
  flag: z
    .object({
      stampId: bytes32,
      flag: z.number().int().min(0).max(255),
      reasonUri: z.string().url().max(2048),
    })
    .strict(),
  ingest: z.object({ stampId: bytes32 }).strict(),
  mark: z.object({ stampId: bytes32 }).strict(),
  store: z.object({ stampId: bytes32 }).strict(),
  probe: z.object({ stampId: bytes32, slot: z.number().int().min(0).max(255) }).strict(),
  "verify-upload": z.object({ jobId: z.string().uuid() }).strict(),
  finality: empty,
  runway: empty,
  "pdp-monitor": empty,
  "probe-sample": empty,
  "mirror-gc": empty,
};

export type EnqueueOptions = {
  delayMs?: number;
  /** Dedupe key: while a job with the same name+key is queued, enqueue returns null. Defaults to the canonical payload. */
  singletonKey?: string;
  retryLimit?: number;
  retryDelayMs?: number;
  retryBackoff?: boolean;
};
export type JobInfo = { id: string; attempt: number };
export type Handler<N extends JobName> = (payload: JobPayload[N], job: JobInfo) => Promise<void>;

export interface Queue {
  readonly role: Role;
  /** Returns the job id, or null when deduplicated by singletonKey. */
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload[N],
    opts?: EnqueueOptions,
  ): Promise<string | null>;
  work<N extends JobName>(
    name: N,
    handler: Handler<N>,
    opts?: { concurrency?: number },
  ): Promise<void>;
  schedule(name: JobName, cron: string): Promise<void>;
  stop(): Promise<void>;
  /**
   * Runnable backlog per queue (queued or retrying, start time reached), all roles' queues; only
   * queues with waiting jobs are listed. Feeds `stamper_queue_oldest_age_seconds` (worker).
   */
  stats?(): Promise<QueueStat[]>;
}

export type QueueStat = { name: JobName; waiting: number; oldestAgeSeconds: number };

export class QueueRoleError extends Error {
  override name = "QueueRoleError";
}

export function isJobName(v: unknown): v is JobName {
  return typeof v === "string" && (JOB_NAMES as readonly string[]).includes(v);
}

/** Throws unless `role` owns job `name`. */
export function assertOwner(role: Role, name: JobName, what: "work" | "schedule"): void {
  if (!isJobName(name)) throw new QueueRoleError(`unknown job ${String(name)}`);
  if (JOB_ROLE[name] !== role) {
    throw new QueueRoleError(
      `ROLE=${role} cannot ${what} '${name}' (owned by ROLE=${JOB_ROLE[name]})`,
    );
  }
}

export function parsePayload<N extends JobName>(name: N, payload: unknown): JobPayload[N] {
  const r = JOB_SCHEMAS[name].safeParse(payload);
  if (!r.success) {
    throw new TypeError(
      `invalid '${name}' payload: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

/** Deterministic JSON with sorted keys, used as the default singleton key. */
export function canonicalKey(payload: object): string {
  const entries = Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

const CRON_RE = /^(\S+\s+){4}\S+$/;
export function assertCron(cron: string): void {
  if (!CRON_RE.test(cron.trim())) throw new TypeError(`invalid 5-field cron: ${cron}`);
}
