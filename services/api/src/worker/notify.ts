import type { Logger } from "../shared/logger.js";
import type { Notifier } from "./deps.js";

/** ntfy publisher (DESIGN §5.4 alerts). Without NTFY_URL the notice is only logged. */
export function createNotifier(
  url: string | undefined,
  log: Logger,
  f: typeof fetch = fetch,
): Notifier {
  return async (n) => {
    log.warn({ notice: n.title, msg: n.message }, "ops notice");
    if (!url) return;
    try {
      const res = await f(url, {
        method: "POST",
        body: n.message,
        headers: {
          Title: n.title,
          Priority: String(n.priority ?? 3),
          ...(n.tags?.length ? { Tags: n.tags.join(",") } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.error({ status: res.status }, "ntfy post failed");
    } catch (e) {
      log.error({ err: e }, "ntfy post failed");
    }
  };
}
