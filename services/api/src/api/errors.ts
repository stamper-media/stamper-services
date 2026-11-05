/** Typed HTTP error: `{ error: code, ...extra }` with an HTTP status. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status:
      | 400
      | 401
      | 403
      | 404
      | 409
      | 410
      | 413
      | 415
      | 416
      | 422
      | 429
      | 500
      | 502
      | 503,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

/** Recursively turn bigints into decimal strings and Dates into ISO strings (wire encoding, plan §4.1). */
export function toWire<T>(v: T): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => toWire(x));
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
    return out;
  }
  return v;
}
