import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createMemoryQueue } from "../../src/queue/memory.js";
import { DEFAULT_SCHEDULES } from "../../src/queue/port.js";
import { registerWorker, WORKER_SCHEDULED } from "../../src/worker/app.js";
import type { WorkerDeps } from "../../src/worker/deps.js";
import { familyFor } from "../../src/worker/jobs/mark.js";
import { ffprobe, MediaError } from "../../src/worker/media.js";
import { createS3Mirror, ensureMirrored, MirrorError, mirrorKey } from "../../src/worker/mirror.js";
import { createNotifier } from "../../src/worker/notify.js";
import { fixture, silentLog } from "./helpers.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const SHA = `0x${"ab".repeat(32)}` as const;
const mirrorCfg = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "auto" };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("mirror", () => {
  it("uses the api's key layout", () => {
    expect(mirrorKey.original(SHA)).toBe(`originals/${"ab".repeat(32)}`);
    expect(mirrorKey.derivative(SHA)).toBe(`d/${"ab".repeat(32)}`);
    expect(() => mirrorKey.original("0x12" as `0x${string}`)).toThrow(TypeError);
  });

  it("checks the PUT ETag against the body MD5 and sends Content-MD5", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const md5 = createHash("md5").update(body).digest();
    const sent: unknown[] = [];
    const ok = createS3Mirror(mirrorCfg, {
      send: async (c: unknown) => {
        sent.push(c);
        return { ETag: `"${md5.toString("hex")}"` };
      },
    } as never);
    await expect(ok.put("k", body, "image/jpeg")).resolves.toEqual({ etag: md5.toString("hex") });
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input.ContentMD5).toBe(md5.toString("base64"));
    const bad = createS3Mirror(mirrorCfg, {
      send: async () => ({ ETag: `"${"0".repeat(32)}"` }),
    } as never);
    await expect(bad.put("k", body, "image/jpeg")).rejects.toBeInstanceOf(MirrorError);
  });

  it("head maps 404 to null; ensureMirrored skips an existing object of the same size", async () => {
    let puts = 0;
    const m = createS3Mirror(mirrorCfg, {
      send: async (c: unknown) => {
        if (c instanceof HeadObjectCommand) {
          if (c.input.Key === "missing") throw Object.assign(new Error("nf"), { name: "NotFound" });
          return { ContentLength: 3, ETag: '"x"' };
        }
        puts++;
        return {
          ETag: `"${createHash("md5")
            .update(new Uint8Array([1, 2, 3]))
            .digest("hex")}"`,
        };
      },
    } as never);
    expect(await m.head("missing")).toBeNull();
    expect(await ensureMirrored(m, "present", new Uint8Array([1, 2, 3]), "x/y")).toBe(false);
    expect(await ensureMirrored(m, "missing", new Uint8Array([1, 2, 3]), "x/y")).toBe(true);
    expect(puts).toBe(1);
  });
});

describe("worker wiring", () => {
  it("registers every worker job and schedules the monitors", async () => {
    const q = createMemoryQueue("worker");
    await registerWorker({ queue: q }, {} as WorkerDeps);
    for (const n of WORKER_SCHEDULED) expect(q.schedules.get(n)).toBe(DEFAULT_SCHEDULES[n]);
    expect(q.schedules.has("finality")).toBe(false);
  });

  it("picks F1 for effective level ≥ 1 and F0 for 0", () => {
    expect([familyFor(0), familyFor(1), familyFor(2)]).toEqual(["F0", "F1", "F1"]);
  });

  it("every media decode lives in the worker: no sharp/ffprobe/exifr/marking in src/api", () => {
    const bad = walk(join(SRC, "api")).filter((f) =>
      /from\s+["'](sharp|exifr|@stamper\/marking|fluent-ffmpeg)["']|ffprobe/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("the worker never imports src/api or reads a secret", () => {
    for (const f of walk(join(SRC, "worker"))) {
      const t = readFileSync(f, "utf8");
      expect(t).not.toMatch(/from\s+["']\.\.\/(\.\.\/)?api\//);
      expect(t).not.toMatch(/_PK(_FILE)?\b|secrets\.\w/);
    }
  });
});

describe("notifier and probes", () => {
  it("posts to ntfy with Title/Priority/Tags", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok");
    }) as unknown as typeof fetch;
    await createNotifier(
      "http://ntfy.local/topic",
      silentLog,
      f,
    )({ title: "t", message: "m", priority: 4, tags: ["warning"] });
    expect(calls[0]?.url).toBe("http://ntfy.local/topic");
    expect(calls[0]?.init.headers).toMatchObject({ Title: "t", Priority: "4", Tags: "warning" });
    expect(calls[0]?.init.body).toBe("m");
  });

  it("ffprobe reports codecs and duration, and MediaError on garbage", async () => {
    let p: Awaited<ReturnType<typeof ffprobe>> | null = null;
    try {
      p = await ffprobe(fileURLToPath(new URL("./fixtures/pixel.mp4", import.meta.url)));
    } catch (e) {
      if (!(e instanceof MediaError) || /ENOENT/.test(e.message)) {
        console.warn(`[worker unit] ffprobe unavailable: ${(e as Error).message.slice(0, 80)}`);
        return;
      }
      throw e;
    }
    expect(p.videoCodec).toBeTruthy();
    expect(p.durationMs).toBeGreaterThanOrEqual(0);
    void fixture;
    await expect(
      ffprobe(fileURLToPath(new URL("./helpers.ts", import.meta.url))),
    ).rejects.toBeInstanceOf(MediaError);
  });
});
