import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { normaliseCode } from "@stamper/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Hex } from "viem";
import { ZodError, type z } from "zod";
import { reports as reportsT } from "../db/index.js";
import { stampEvents, stamps, verifyJobs } from "../db/repo/index.js";
import { byteaToHex, stagingPath } from "../shared/index.js";
import { issueChallenge } from "./attest/challenge.js";
import { captureStatus, createCapture, submitClaim } from "./captures/service.js";
import { webCaptureRoutes } from "./devices/web.js";
import { enrolDevice } from "./devices.js";
import { ApiError, toWire } from "./errors.js";
import { rateLimit, TokenBuckets } from "./ratelimit.js";
import {
  CaptureBody,
  ChallengeQuery,
  ClaimBody,
  EnrolBody,
  openApiDocument,
  ReportBody,
  WithdrawBody,
} from "./schemas.js";
import type { Services } from "./services.js";
import {
  evidence,
  original,
  presentation,
  RENDITION_FILES,
  type RenditionFile,
  rendition,
  withdraw,
} from "./stamps.js";
import { clientIp, sha256Hex } from "./util.js";

async function json<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "BadJson");
  }
  return schema.parse(raw);
}

export function onError(log: Services["log"]) {
  return (err: Error, c: Context) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
      return c.json({ error: err.code, ...err.extra }, err.status);
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: "BadRequest",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    }
    log.error({ err, path: c.req.path }, "unhandled api error");
    return c.json({ error: "Internal" }, 500);
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v: string) => {
  if (!UUID.test(v)) throw new ApiError(404, "NotFound");
  return v.toLowerCase();
};

export type RouteOpts = {
  buckets?: TokenBuckets;
  mirrorGet?: (sha: Hex) => Promise<{ body: Readable; size?: number } | null>;
};

export function createRoutes(s: Services, o: RouteOpts = {}): Hono {
  const app = new Hono();
  const rl = o.buckets ?? new TokenBuckets(s.now);
  app.onError(onError(s.log));

  // JSON bodies are small (the largest is an App Attest object); cap them before parsing.
  const jsonLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: () => {
      throw new ApiError(413, "TooLarge");
    },
  });
  for (const p of [
    "/v1/devices/*",
    "/v1/captures",
    "/v1/captures/*",
    "/v1/stamps/*",
    "/v1/reports",
  ])
    app.on("POST", p, jsonLimit);
  app.route("/", webCaptureRoutes(s, { buckets: rl })); // WP-14 (before /v1/devices/:platform)

  app.get("/v1/openapi.json", (c) => c.json(openApiDocument(s.cfg.publicBaseUrl)));

  app.get("/v1/attest/challenge", rateLimit(rl, "attest"), async (c) => {
    const q = ChallengeQuery.parse({ keyId: c.req.query("keyId") || undefined });
    return c.json(await issueChallenge(s.db, "enrol", q.keyId ?? null));
  });

  app.post("/v1/devices/:platform", rateLimit(rl, "devices"), async (c) => {
    const p = c.req.param("platform");
    if (p !== "ios" && p !== "android") throw new ApiError(404, "NotFound");
    return c.json(await enrolDevice(s, p, await json(c, EnrolBody)), 201);
  });

  app.post(
    "/v1/captures",
    rateLimit(rl, "captures", (c) => c.req.header("x-stamper-key") ?? undefined),
    async (c) => {
      const b = await json(c, CaptureBody);
      const k = rl.take(`captures:key:${b.keyId.toLowerCase()}`, 30);
      if (!k.ok)
        throw new ApiError(
          429,
          "RateLimited",
          { retryAfter: k.retryAfterS },
          { "retry-after": String(k.retryAfterS) },
        );
      return c.json(await createCapture(s, b), 201);
    },
  );

  // Hono serves HEAD through the GET route (body dropped)
  app.get("/v1/uploads/:id", async (c) => {
    const h = await s.uploads.head(uuidParam(c.req.param("id")));
    return c.body(null, 200, s.uploads.headers(h));
  });

  app.put("/v1/uploads/:id", rateLimit(rl, "uploads"), async (c) => {
    const r = await s.uploads.put(
      uuidParam(c.req.param("id")),
      c.req.header("content-range"),
      c.req.raw.body,
    );
    if (r.kind === "partial")
      return c.body(null, 308, s.uploads.headers({ received: r.received, total: r.total }));
    return c.json(
      toWire({
        sha256: r.sha256,
        pieceCid: r.pieceCid,
        pieceCidHex: r.pieceCidHex,
        size: r.size,
      }) as object,
      201,
    );
  });

  app.post("/v1/captures/:id/claim", rateLimit(rl, "claims"), async (c) => {
    return c.json(
      await submitClaim(s, uuidParam(c.req.param("id")), await json(c, ClaimBody)),
      202,
    );
  });

  app.get("/v1/captures/:id", async (c) =>
    c.json(await captureStatus(s, uuidParam(c.req.param("id")))),
  );

  const lookup = rateLimit(rl, "codeLookup");
  app.get("/v1/stamps/:code", lookup, async (c) =>
    c.json(await presentation(s, c.req.param("code"))),
  );

  app.get("/v1/stamps/:code/original", lookup, async (c) => {
    const r = await original(s, c.req.param("code"), o.mirrorGet);
    if (r.kind === "redirect") return c.redirect(r.url, 302);
    if (c.req.header("if-none-match") === r.etag) {
      r.body.destroy();
      return c.body(null, 304, { etag: r.etag });
    }
    return new Response(Readable.toWeb(r.body) as ReadableStream, {
      status: 200,
      headers: {
        etag: r.etag,
        "content-type": r.mime,
        "x-stamper-source": r.source,
        "cache-control": "public, max-age=300",
        ...(r.size !== undefined ? { "content-length": String(r.size) } : {}),
      },
    });
  });

  app.get("/v1/stamps/:code/evidence.json", lookup, async (c) => {
    c.header("content-disposition", `attachment; filename="stamper-evidence.json"`);
    return c.json(await evidence(s, c.req.param("code")));
  });

  app.get("/v1/stamps/:code/:file", lookup, async (c) => {
    const file = c.req.param("file");
    if (!(RENDITION_FILES as readonly string[]).includes(file)) throw new ApiError(404, "NotFound");
    const r = await rendition(s, c.req.param("code"), file as RenditionFile);
    if (c.req.header("if-none-match") === r.etag) return c.body(null, 304, { etag: r.etag });
    const { createReadStream } = await import("node:fs");
    return new Response(Readable.toWeb(createReadStream(r.path)) as ReadableStream, {
      headers: {
        etag: r.etag,
        "content-type": r.type,
        "content-length": String(r.size),
        "cache-control": "public, max-age=3600",
      },
    });
  });

  app.post("/v1/stamps/:code/withdraw", rateLimit(rl, "withdraw"), async (c) => {
    return c.json(await withdraw(s, c.req.param("code"), await json(c, WithdrawBody)), 202);
  });

  app.post(
    "/v1/verify/upload",
    rateLimit(rl, "verifyUpload"),
    bodyLimit({
      maxSize: s.cfg.limits.maxVideoBytes + 1024 * 1024,
      onError: () => {
        throw new ApiError(413, "TooLarge");
      },
    }),
    async (c) => {
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw new ApiError(415, "MultipartRequired");
      }
      const f = form.file;
      if (!(f instanceof File))
        throw new ApiError(400, "BadRequest", { reason: "multipart field 'file' required" });
      const isVideo = f.type.startsWith("video/");
      const max = isVideo ? s.cfg.limits.maxVideoBytes : s.cfg.limits.maxImageBytes;
      if (f.size === 0 || f.size > max) throw new ApiError(413, "TooLarge", { max });
      const jobId = randomUUID();
      const path = stagingPath(s.cfg, jobId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, new Uint8Array(await f.arrayBuffer()));
      const ip = clientIp((h) => c.req.header(h));
      const day = new Date(s.now()).toISOString().slice(0, 10);
      await verifyJobs.create(s.db, {
        id: jobId,
        path,
        mime: f.type || null,
        size: BigInt(f.size),
        ipHash: sha256Hex(new TextEncoder().encode(`stamper-ip:${day}:${ip}`)),
      });
      await s.queue.enqueue("verify-upload", { jobId });
      return c.json({ jobId }, 202);
    },
  );

  app.get("/v1/verify/jobs/:id", async (c) => {
    const j = await verifyJobs.get(s.db, uuidParam(c.req.param("id")));
    if (!j) throw new ApiError(404, "NotFound");
    return c.json({
      status: j.status,
      ...(j.result != null ? { result: j.result } : {}),
      ...(j.error ? { error: j.error } : {}),
    });
  });

  let health: { at: number; body: unknown } | null = null;
  app.get("/v1/health/storage", async (c) => {
    if (!health || s.now() - health.at > 60_000) {
      const settle = async <T>(p: Promise<T>) =>
        p.then(
          (v) => toWire(v),
          (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
        );
      const [A, B, runway, bal, sess] = await Promise.all([
        settle(s.foc.dataSetHealth("A")),
        settle(s.foc.dataSetHealth("B")),
        settle(s.foc.runway()),
        settle(s.relayer.balance()),
        settle(s.foc.sessionExpiry()),
      ]);
      health = {
        at: s.now(),
        body: {
          chainId: s.cfg.chain.id,
          focMode: s.cfg.foc.mode,
          dataSets: { A, B },
          runway,
          relayer: { address: s.relayer.address, balanceWei: bal },
          sessionKey: sess,
          checkedAt: new Date(s.now()).toISOString(),
        },
      };
    }
    return c.json(health.body as object);
  });

  app.post("/v1/reports", rateLimit(rl, "reports"), async (c) => {
    const b = await json(c, ReportBody);
    const n = normaliseCode(b.code);
    if (!n.ok) throw new ApiError(422, "InvalidCode", { reason: n.reason });
    const st = await stamps.byCode(s.db, n.value);
    const [row] = await s.db
      .insert(reportsT)
      .values({ stampId: st?.stampId ?? null, kind: b.kind, reporter: b.contact ?? null })
      .returning({ id: reportsT.id });
    if (!row) throw new Error("report insert returned no row");
    await stampEvents.append(s.db, {
      stampId: st ? byteaToHex(st.stampId) : null,
      kind: "report",
      actor: "public",
      data: {
        reportId: row.id,
        code: n.code9,
        kind: b.kind,
        contact: b.contact ?? null,
        text: b.text,
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/.well-known/apple-app-site-association", (c) => {
    const { teamId, bundleId } = s.cfg.attest.apple;
    if (!teamId) throw new ApiError(404, "NotConfigured");
    const appID = `${teamId}.${bundleId}`;
    return c.json({
      applinks: { details: [{ appIDs: [appID], components: [{ "/": "/v/*" }] }] },
      appclips: { apps: [] },
      webcredentials: { apps: [appID] },
    });
  });

  app.get("/.well-known/assetlinks.json", (c) => {
    const { packageName, certSha256 } = s.cfg.attest.play;
    if (!certSha256) throw new ApiError(404, "NotConfigured");
    const fp = certSha256.includes(":")
      ? certSha256.toUpperCase()
      : (certSha256.toUpperCase().match(/.{2}/g) ?? []).join(":");
    return c.json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: [fp],
        },
      },
    ]);
  });

  return app;
}
