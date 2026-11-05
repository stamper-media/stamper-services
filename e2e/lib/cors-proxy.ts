/**
 * Local-stack CORS front: `/<prefix>/<rest>` → `<target>/<rest>` with permissive CORS headers.
 * The browser verify page needs CORS on the api and on the piece source; neither the custodian
 * api nor the mock SP sends it yet (reported as a WP-07 / WP-03 gap), so the e2e stack puts this
 * in front of both. Never used outside run-local.sh.
 *
 * Env: CORS_PROXY_PORT (required), CORS_PROXY_ROUTES = "api=http://127.0.0.1:1234,sp=http://…".
 */
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export type Routes = Record<string, URL>;

export function parseRoutes(spec: string): Routes {
  const out: Routes = {};
  for (const part of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    const name = part.slice(0, i);
    if (i <= 0 || !/^[a-z0-9-]+$/.test(name)) throw new Error(`bad route "${part}"`);
    const u = new URL(part.slice(i + 1));
    if (u.protocol !== "http:") throw new Error(`route ${name}: only http targets`);
    out[name] = u;
  }
  if (Object.keys(out).length === 0) throw new Error("CORS_PROXY_ROUTES is empty");
  return out;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "600",
};

/** Resolve `/<prefix>/<rest>?q` against the routes; null when no route matches. */
export function target(routes: Routes, url: string): URL | null {
  const m = /^\/([a-z0-9-]+)(\/[^?]*)?(\?.*)?$/.exec(url);
  const base = m ? routes[m[1] as string] : undefined;
  if (!m || !base) return null;
  const t = new URL(base);
  t.pathname = `${base.pathname.replace(/\/$/, "")}${m[2] ?? "/"}`;
  t.search = m[3] ?? "";
  return t;
}

export function handler(routes: Routes) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    const t = target(routes, req.url ?? "/");
    if (!t) return void res.writeHead(404, CORS).end();
    const headers = { ...req.headers, host: t.host };
    delete headers.origin;
    const up = request(t, { method: req.method, headers }, (r) => {
      const h = { ...r.headers, ...CORS };
      // keep redirects inside the proxy when they point at a proxied origin
      if (typeof h.location === "string") {
        for (const [name, base] of Object.entries(routes)) {
          if (h.location.startsWith(base.origin))
            h.location = `/${name}${h.location.slice(base.origin.length)}`;
        }
      }
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, CORS);
      res.end(String(e.message));
    });
    req.pipe(up);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.CORS_PROXY_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error("CORS_PROXY_PORT is required");
  const routes = parseRoutes(process.env.CORS_PROXY_ROUTES ?? "");
  createServer(handler(routes)).listen(port, "127.0.0.1", () =>
    console.log(`[cors-proxy] :${port} ${Object.keys(routes).join(",")}`),
  );
}
