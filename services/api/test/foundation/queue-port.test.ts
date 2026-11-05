import { describe, expect, it } from "vitest";
import { createMemoryQueue } from "../../src/queue/memory.js";
import {
  DEFAULT_SCHEDULES,
  JOB_NAMES,
  JOB_ROLE,
  JOB_SCHEMAS,
  QueueRoleError,
} from "../../src/queue/port.js";

const sid = `0x${"07".repeat(32)}` as const;

describe("queue port", () => {
  it("every job has an owner and a schema; keyed jobs belong to the api", () => {
    for (const n of JOB_NAMES) {
      expect(JOB_ROLE[n]).toMatch(/^(api|worker)$/);
      expect(JOB_SCHEMAS[n]).toBeDefined();
    }
    for (const n of ["register", "attach", "commit", "bind", "flag"] as const)
      expect(JOB_ROLE[n]).toBe("api");
    for (const n of ["ingest", "mark", "store", "probe", "verify-upload"] as const)
      expect(JOB_ROLE[n]).toBe("worker");
    for (const n of Object.keys(DEFAULT_SCHEDULES)) expect(JOB_NAMES).toContain(n);
  });

  it("worker cannot register 'register'; api cannot register 'ingest'", async () => {
    const w = createMemoryQueue("worker");
    await expect(w.work("register", async () => {})).rejects.toThrow(QueueRoleError);
    await expect(w.schedule("runway", "0 * * * *")).rejects.toThrow(QueueRoleError);
    const a = createMemoryQueue("api");
    await expect(a.work("ingest", async () => {})).rejects.toThrow(/ROLE=api cannot work 'ingest'/);
  });

  it("validates payloads, dedupes by key and retries", async () => {
    const q = createMemoryQueue("worker");
    await expect(q.enqueue("ingest", { stampId: "0x12" as `0x${string}` })).rejects.toThrow(
      /invalid 'ingest'/,
    );
    expect(await q.enqueue("ingest", { stampId: sid })).toBeTypeOf("string");
    expect(await q.enqueue("ingest", { stampId: sid })).toBeNull();
    const attempts: number[] = [];
    await q.work("ingest", async (p, job) => {
      expect(p.stampId).toBe(sid);
      attempts.push(job.attempt);
      if (job.attempt === 1) throw new Error("transient");
    });
    expect(await q.drain()).toBe(2);
    expect(attempts).toEqual([1, 2]);
    await q.schedule("mirror-gc", "30 4 * * *");
    await expect(q.schedule("probe-sample", "weekly")).rejects.toThrow(/cron/);
  });
});
