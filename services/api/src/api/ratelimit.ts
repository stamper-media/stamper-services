import type { Context, MiddlewareHandler } from "hono";
import { CODE_LOOKUP_RATE, RATE_WINDOW_MS, VERIFY_UPLOAD_RATE } from "../shared/index.js";
import { ApiError } from "./errors.js";
import { clientIp } from "./util.js";

/** Per-minute budgets (DESIGN §11.2). Mobile mirrors these in its back-off. */
export const RATES = {
  attest: 30,
  devices: 10,
  captures: 30,
  uploads: 600,
  claims: 30,
  codeLookup: CODE_LOOKUP_RATE,
  verifyUpload: VERIFY_UPLOAD_RATE,
  reports: 10,
  withdraw: 10,
} as const;

type Bucket = { tokens: number; at: number };

/** Token bucket: capacity = rate, refilled continuously over RATE_WINDOW_MS. */
export class TokenBuckets {
  private readonly b = new Map<string, Bucket>();
  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, rate: number): { ok: boolean; retryAfterS: number } {
    const t = this.now();
    const cur = this.b.get(key) ?? { tokens: rate, at: t };
    const tokens = Math.min(rate, cur.tokens + ((t - cur.at) * rate) / RATE_WINDOW_MS);
    if (this.b.size > 50_000) this.prune(t);
    if (tokens < 1) {
      this.b.set(key, { tokens, at: t });
      return { ok: false, retryAfterS: Math.ceil(((1 - tokens) * RATE_WINDOW_MS) / rate / 1000) };
    }
    this.b.set(key, { tokens: tokens - 1, at: t });
    return { ok: true, retryAfterS: 0 };
  }

  private prune(t: number) {
    for (const [k, v] of this.b) if (t - v.at > RATE_WINDOW_MS) this.b.delete(k);
  }
}

export function rateLimit(
  buckets: TokenBuckets,
  name: keyof typeof RATES,
  extraKey?: (c: Context) => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientIp((h) => c.req.header(h));
    const keys = [`${name}:ip:${ip}`];
    const k = extraKey?.(c);
    if (k) keys.push(`${name}:k:${k}`);
    for (const key of keys) {
      const r = buckets.take(key, RATES[name]);
      if (!r.ok) {
        throw new ApiError(
          429,
          "RateLimited",
          { retryAfter: r.retryAfterS },
          { "retry-after": String(r.retryAfterS) },
        );
      }
    }
    await next();
  };
}
