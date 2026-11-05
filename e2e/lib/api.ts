/** Minimal typed client for the custodian HTTP API (DTO reference: GET /v1/openapi.json). */
import type { Hex } from "viem";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 300)}`);
  }
}

/** Thrown inside a `poll` callback to stop at once: a terminal state that more waiting cannot change. */
export class PollAbort extends Error {
  override name = "PollAbort";
}

/** HTTP statuses a later attempt can outlive (row not visible yet, timeouts, rate limits); 5xx too. */
const RETRY_STATUS = new Set([404, 408, 425, 429]);

/**
 * True for failures worth polling through: retryable HTTP statuses, network errors (undici reports them
 * as TypeError "fetch failed" / "terminated" with a `cause`) and per-request timeouts. Everything else is
 * final: a programming error (TypeError reading a property of undefined), a 4xx, a PollAbort.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof PollAbort) return false;
  if (e instanceof ApiError) return e.status >= 500 || RETRY_STATUS.has(e.status);
  const name = (e as { name?: unknown } | null | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  return e instanceof TypeError && (e.message === "fetch failed" || e.cause !== undefined);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type CaptureResponse = {
  captureId: string;
  uploadId: string;
  challengeId: string;
  challenge: Hex;
};
export type UploadComplete = { sha256: Hex; pieceCid: string; pieceCidHex: Hex; size: string };
export type CaptureStatus = {
  status: string;
  stampId: Hex | null;
  predictedCode: string | null;
  code?: string;
  registerTx?: Hex;
  shareReady: boolean;
  marked?: string;
};
export type Binding = {
  slot: number;
  dataSetId: string;
  pieceId: string;
  serviceUrl: string;
  lastProbeAt?: string;
  lastOkAt?: string;
  probeFailures: number;
};
export type Presentation = {
  code9: string;
  stampId: Hex;
  status: string;
  flags: string[];
  contentHash: Hex;
  pieceCid: string;
  pieceCidHex: Hex;
  bindings: Binding[];
  originalSources: { filbeam?: string; providers: string[]; mirror: string };
  storageState: "pending" | "bound" | "unavailable";
  renditions: { share?: string };
  /** base64 DAG-CBOR CaptureRecord as published. */
  record: string | null;
};
export type VerifyJob = {
  status: "queued" | "running" | "done" | "failed";
  result?: {
    verdict: string;
    label: string;
    path: string;
    stampId?: Hex;
    code9?: string;
    candidates?: Array<{ stampId: Hex; distance: number; code9?: string }>;
  };
  error?: string;
};

export class Api {
  constructor(readonly base: string) {
    new URL(base); // validate
  }

  url(path: string): string {
    return new URL(path, this.base).toString();
  }

  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.url(path), { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
  }

  async json<T>(path: string, init: RequestInit = {}, want: number[] = [200]): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
    const r = await this.raw(path, { ...init, headers });
    const text = await r.text();
    if (!want.includes(r.status))
      throw new ApiError(r.status, text, `${init.method ?? "GET"} ${path}`);
    return JSON.parse(text) as T;
  }

  post<T>(path: string, body: unknown, want: number[] = [200, 201, 202]): Promise<T> {
    return this.json<T>(path, { method: "POST", body: JSON.stringify(body) }, want);
  }

  async bytes(url: string): Promise<{ bytes: Uint8Array; source?: string }> {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new ApiError(r.status, await r.text(), `GET ${url}`);
    return {
      bytes: new Uint8Array(await r.arrayBuffer()),
      source: r.headers.get("x-stamper-source") ?? undefined,
    };
  }

  /** Resumable upload in `parts` chunks; the last PUT returns the server's sha256 + PieceCID. */
  async upload(uploadId: string, bytes: Uint8Array, parts = 3): Promise<UploadComplete> {
    const step = Math.ceil(bytes.length / parts);
    let done: UploadComplete | null = null;
    for (let a = 0; a < bytes.length; a += step) {
      const b = Math.min(a + step, bytes.length);
      const r = await this.raw(`/v1/uploads/${uploadId}`, {
        method: "PUT",
        headers: {
          "content-range": `bytes ${a}-${b - 1}/${bytes.length}`,
          "content-type": "application/octet-stream",
        },
        body: bytes.slice(a, b),
      });
      const text = await r.text();
      const last = b === bytes.length;
      if (r.status !== (last ? 201 : 308))
        throw new ApiError(r.status, text, `PUT upload ${a}-${b - 1}`);
      if (last) done = JSON.parse(text) as UploadComplete;
    }
    if (!done) throw new Error("upload produced no completion");
    return done;
  }

  async verifyUpload(
    bytes: Uint8Array,
    mime: string,
    name: string,
    timeoutMs = 120_000,
  ): Promise<VerifyJob> {
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: mime }));
    const r = await this.raw("/v1/verify/upload", { method: "POST", body: form });
    const text = await r.text();
    if (r.status !== 202) throw new ApiError(r.status, text, "POST /v1/verify/upload");
    const { jobId } = JSON.parse(text) as { jobId: string };
    return poll(
      `verify job ${jobId}`,
      () => this.json<VerifyJob>(`/v1/verify/jobs/${jobId}`),
      (j) => j.status === "done" || j.status === "failed",
      timeoutMs,
    );
  }
}

/**
 * Poll `fn` until `ok(value)`. Transient errors (see `isTransient`) are retried until `timeoutMs`; any other
 * error ends the poll at once, so a bug or a terminal state never waits out a long step timeout.
 * Throws with the last value or error on timeout.
 */
export async function poll<T>(
  what: string,
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let err: unknown;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      err = undefined;
      if (ok(last)) return last;
    } catch (e) {
      if (!isTransient(e)) throw new Error(`${what}: ${errText(e)}`, { cause: e });
      err = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  const detail = err !== undefined ? errText(err) : JSON.stringify(last)?.slice(0, 400);
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last: ${detail}`);
}
