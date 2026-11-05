/**
 * In-process queue with the same port semantics (role ownership, payload validation,
 * singleton dedupe, retries). For unit tests of WP-07/WP-08 handlers; not for production.
 */
import { randomUUID } from "node:crypto";
import {
  assertCron,
  assertOwner,
  canonicalKey,
  type EnqueueOptions,
  type Handler,
  type JobName,
  type JobPayload,
  parsePayload,
  type Queue,
  type QueueStat,
  type Role,
} from "./port.js";

type Pending = {
  id: string;
  name: JobName;
  data: unknown;
  key: string;
  retryLimit: number;
  attempt: number;
  /** when the job (or its retry) became runnable, ms epoch */
  readyAt: number;
};

export type MemoryQueue = Queue & {
  /** Run queued jobs whose handlers are registered until none remain; returns jobs run. */
  drain(): Promise<number>;
  readonly pending: readonly Pending[];
  readonly schedules: ReadonlyMap<JobName, string>;
  readonly failed: readonly { name: JobName; id: string; error: unknown }[];
};

export function createMemoryQueue(role: Role): MemoryQueue {
  const pending: Pending[] = [];
  const handlers = new Map<JobName, Handler<JobName>>();
  const schedules = new Map<JobName, string>();
  const failed: { name: JobName; id: string; error: unknown }[] = [];
  return {
    role,
    pending,
    schedules,
    failed,
    async enqueue<N extends JobName>(name: N, payload: JobPayload[N], o: EnqueueOptions = {}) {
      const data = parsePayload(name, payload);
      const key = o.singletonKey ?? canonicalKey(data as object);
      if (pending.some((p) => p.name === name && p.key === key)) return null;
      const id = randomUUID();
      pending.push({
        id,
        name,
        data,
        key,
        retryLimit: o.retryLimit ?? 5,
        attempt: 1,
        readyAt: Date.now(),
      });
      return id;
    },
    async work<N extends JobName>(name: N, handler: Handler<N>) {
      assertOwner(role, name, "work");
      handlers.set(name, handler as unknown as Handler<JobName>);
    },
    async schedule(name: JobName, cron: string) {
      assertOwner(role, name, "schedule");
      assertCron(cron);
      schedules.set(name, cron);
    },
    async stop() {
      handlers.clear();
    },
    async stats() {
      const now = Date.now();
      const by = new Map<JobName, QueueStat>();
      for (const p of pending) {
        const age = Math.max(0, (now - p.readyAt) / 1000);
        const s = by.get(p.name);
        if (s) {
          s.waiting += 1;
          s.oldestAgeSeconds = Math.max(s.oldestAgeSeconds, age);
        } else by.set(p.name, { name: p.name, waiting: 1, oldestAgeSeconds: age });
      }
      return [...by.values()];
    },
    async drain() {
      let ran = 0;
      for (;;) {
        const idx = pending.findIndex((p) => handlers.has(p.name));
        if (idx < 0) return ran;
        const [job] = pending.splice(idx, 1);
        if (!job) return ran;
        const h = handlers.get(job.name) as Handler<JobName>;
        ran++;
        try {
          await h(parsePayload(job.name, job.data), { id: job.id, attempt: job.attempt });
        } catch (error) {
          if (job.attempt <= job.retryLimit)
            pending.push({ ...job, attempt: job.attempt + 1, readyAt: Date.now() });
          else failed.push({ name: job.name, id: job.id, error });
        }
      }
    },
  };
}
