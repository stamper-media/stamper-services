import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodePrivateRecord,
  decodeRecord,
  fixInCell,
  hashKeyPossession,
  keyIdFromAddress,
  privateRecordHash,
} from "@stamper/core";
import { inspectJpeg } from "@stamper/minimise";
import { describe, expect, it } from "vitest";
import { ApiError, isTransient, PollAbort, poll } from "../lib/api.js";
import { parseRoutes, target } from "../lib/cors-proxy.js";
import {
  buildClaim,
  captureBinding,
  captureLocation,
  enrolBinding,
  newDevice,
  parseLocation,
  sha256Hex,
  stubToken,
} from "../lib/device.js";
import { loadPhoto, makePhoto } from "../lib/media.js";
import { buildReport, type FlowResult } from "../report.js";
import {
  activationTime,
  addressOfKey,
  describeRole,
  isoOf,
  type RoleCheck,
  roleState,
  untilText,
} from "../roles.js";

describe("device", () => {
  it("stub token is stub:<platform>:<hex sha256(binding)> without 0x", () => {
    const b = `0x${"ab".repeat(32)}` as const;
    const t = stubToken("android", b);
    expect(t).toBe(`stub:android:${sha256Hex(new Uint8Array(32).fill(0xab)).slice(2)}`);
    expect(t).toMatch(/^stub:android:[0-9a-f]{64}$/);
  });
  it("bindings concatenate addr‖challenge and stampId‖challenge", () => {
    const dev = newDevice();
    expect(dev.keyId).toBe(keyIdFromAddress(dev.addr));
    const ch = `0x${"11".repeat(32)}` as const;
    expect(enrolBinding(dev.addr, ch)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(captureBinding(ch, ch)).toBe(sha256Hex(new Uint8Array(64).fill(0x11)));
    expect(() => enrolBinding(dev.addr, "0x11")).toThrow(TypeError);
    expect(typeof hashKeyPossession).toBe("function");
  });
});

describe("fixtures", () => {
  it("photo keeps EXIF orientation and has no GPS", async () => {
    const p = await makePhoto(7, 320, 240);
    expect(p.dims).toEqual({ w: 320, h: 240 });
    expect(p.sanitised.kept.join(",")).toMatch(/Orientation/);
    expect((await makePhoto(7, 320, 240)).bytes).toEqual(p.bytes);
  });
});

describe("E2E_LOCATION", () => {
  it("parses lat,lon[,accuracyM] and refuses anything else", () => {
    expect(parseLocation(undefined)).toBeUndefined();
    expect(parseLocation("")).toBeUndefined();
    expect(parseLocation("-23.5505,-46.6333,8")).toEqual({
      latitude: -23.5505,
      longitude: -46.6333,
      accuracy: 8,
    });
    expect(parseLocation(" 51.5, -0.12 ")?.accuracy).toBe(10);
    for (const bad of ["51.5", "91,0", "0,181", "a,b", "1,2,-1", "1,2,3,4", "1,,3"])
      expect(() => parseLocation(bad), bad).toThrow(/E2E_LOCATION/);
  });

  it("builds the record as the app does: public cell, exact fix committed by privateHash", async () => {
    const fix = parseLocation("-23.5505,-46.6333,8");
    if (!fix) throw new Error("no fix");
    const loc = captureLocation(fix, 1_790_000_000_000);
    expect(loc.cell).toEqual({ latE2: -2356, lonE2: -4664, source: "fused" });
    const priv = decodePrivateRecord(loc.privateRecord);
    expect(priv.location).toEqual(loc.exact);
    expect(loc.exact).toMatchObject({ latE7: -235505000, lonE7: -466333000, accuracyM: 8 });
    expect(fixInCell(loc.exact, loc.cell)).toBe(true);
    expect(decodePrivateRecord(captureLocation(fix).privateRecord).salt).not.toBe(priv.salt);

    const photo = await makePhoto(3, 64, 48);
    const built = await buildClaim({
      device: newDevice(),
      chainId: 31337,
      registry: `0x${"11".repeat(20)}`,
      bytes: photo.bytes,
      contentHash: sha256Hex(photo.bytes),
      pieceCidHex: "0x01",
      mediaKind: 1,
      mediaType: photo.mime,
      dims: photo.dims,
      challenge: `0x${"22".repeat(32)}`,
      nonce: 1n,
      capturedAt: 1_790_000_000_000n,
      sanitised: photo.sanitised,
      publicExif: photo.publicExif,
      location: loc,
    });
    const rec = decodeRecord(built.record);
    expect(rec.location).toEqual(loc.cell);
    expect(rec.privateHash).toBe(privateRecordHash(loc.privateRecord));
  });
});

describe("E2E_PHOTO", () => {
  it("loads a JPEG through the minimiser (GPS dropped, integers-only public EXIF)", () => {
    const path = fileURLToPath(new URL("./fixtures/iphone.jpg", import.meta.url));
    expect(inspectJpeg(new Uint8Array(readFileSync(path))).hasGps).toBe(true);
    const p = loadPhoto(path);
    expect(p.mime).toBe("image/jpeg");
    expect(inspectJpeg(p.bytes).hasGps).toBe(false);
    expect(p.dims.w).toBeGreaterThan(0);
    expect(p.dims.h).toBeGreaterThan(0);
    for (const v of Object.values(p.publicExif))
      expect(typeof v === "string" || Number.isInteger(v)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "stamper-e2e-photo-"));
    try {
      const png = join(dir, "x.png");
      writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
      expect(() => loadPhoto(png)).toThrow(/not a JPEG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cors proxy", () => {
  const routes = parseRoutes("api=http://127.0.0.1:1234,sp=http://127.0.0.1:9/base");
  it("maps prefixes and keeps the query", () => {
    expect(target(routes, "/api/v1/stamps/X?a=1")?.toString()).toBe(
      "http://127.0.0.1:1234/v1/stamps/X?a=1",
    );
    expect(target(routes, "/sp/piece/baf")?.toString()).toBe("http://127.0.0.1:9/base/piece/baf");
    expect(target(routes, "/nope/x")).toBeNull();
  });
  it("rejects bad specs", () => {
    expect(() => parseRoutes("")).toThrow();
    expect(() => parseRoutes("x=https://a")).toThrow();
  });
});

describe("report", () => {
  it("is green only with all five timings and no failing leg", () => {
    const f: FlowResult = {
      mode: "local",
      chainId: 31337,
      startedAt: "",
      marks: { captureStart: 0, accepted: 1, receipt: 2, marked: 3, bound: 4, probeOk: 5 },
      legs: { a: { status: "pass", detail: "" }, b: { status: "skip", detail: "" } },
    };
    expect(buildReport(f).ok).toBe(true);
    expect(buildReport({ ...f, marks: { ...f.marks, probeOk: undefined } }).ok).toBe(false);
    expect(buildReport({ ...f, legs: { a: { status: "fail", detail: "" } } }).ok).toBe(false);
  });
});

describe("poll", () => {
  it("fails at once on a programming error instead of waiting out the step timeout", async () => {
    const missing = undefined as unknown as { captureId: string };
    const t0 = Date.now();
    await expect(
      poll(
        "pipeline",
        async () => missing.captureId,
        () => true,
        60_000,
        5,
      ),
    ).rejects.toThrow(/^pipeline: .*undefined/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it("retries transient failures and stops on PollAbort or a 4xx", async () => {
    let n = 0;
    const v = await poll(
      "x",
      async () => {
        n++;
        if (n === 1) throw new ApiError(503, "busy", "GET /a");
        if (n === 2) throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
        if (n === 3) throw new ApiError(404, "", "GET /a");
        return n;
      },
      (x) => x >= 4,
      5_000,
      1,
    );
    expect(v).toBe(4);
    const abort = async (): Promise<number> => {
      throw new PollAbort("capture rejected");
    };
    await expect(poll("y", abort, () => true, 60_000, 1)).rejects.toThrow("y: capture rejected");
    const bad = async (): Promise<number> => {
      throw new ApiError(400, "bad", "GET /z");
    };
    await expect(poll("z", bad, () => true, 60_000, 1)).rejects.toThrow(/^z: GET \/z: HTTP 400/);
    expect(isTransient(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(
      false,
    );
    expect(isTransient(new DOMException("slow", "TimeoutError"))).toBe(true);
  });
  it("times out with the last transient error", async () => {
    const gone = async (): Promise<number> => {
      throw new ApiError(404, "nope", "GET /w");
    };
    await expect(poll("w", gone, () => true, 30, 5)).rejects.toThrow(
      /timed out after 30 ms waiting for w; last: GET \/w: HTTP 404/,
    );
  });
});

describe("roles pre-flight", () => {
  const at = 1791002550n; // 2026-10-03T04:42:30Z: the Calibration deploy block time + 48 h
  const reg: RoleCheck = {
    role: "registrar",
    key: "REGISTRAR_PK",
    addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    active: false,
    activeFrom: at,
  };
  it("classifies roles and names the activation time", () => {
    const binder: RoleCheck = { ...reg, role: "binder", key: "RELAYER_PK", activeFrom: at - 60n };
    expect(roleState(reg)).toBe("pending");
    expect(roleState({ ...reg, active: true })).toBe("active");
    expect(roleState({ ...reg, activeFrom: 0n })).toBe("missing");
    expect(activationTime([binder, reg])).toBe(at);
    expect(activationTime([{ ...reg, active: true }])).toBeUndefined();
    expect(isoOf(at)).toBe("2026-10-03T04:42:30Z");
    expect(describeRole(reg, at - 47n * 3600n - 720n)).toBe(
      "registrar 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (REGISTRAR_PK): announced, active from 2026-10-03T04:42:30Z (in 47 h 12 min)",
    );
    expect(describeRole({ ...reg, activeFrom: 0n }, at)).toMatch(/holds no registrar role/);
    expect(untilText(0)).toBe("due now");
    expect(untilText(61)).toBe("in 2 min");
  });
  it("derives addresses from keys without echoing them", () => {
    const k = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public anvil key #1
    expect(addressOfKey("K", `0x${k}`)).toBe(reg.addr);
    expect(addressOfKey("K", ` ${k}\n`)).toBe(reg.addr);
    expect(() => addressOfKey("K", "0x1234")).toThrow(/^K is not a 32-byte hex private key$/);
    expect(() => addressOfKey("K", undefined)).toThrow(/^K is not a 32-byte hex private key$/);
    expect(() => addressOfKey("K", "0".repeat(64))).toThrow(
      /^K is not a valid secp256k1 private key$/,
    );
  });
});

describe("flow", () => {
  const closedPort = () =>
    new Promise<number>((ok, fail) => {
      const srv = createServer().once("error", fail);
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => (a && typeof a === "object" ? ok(a.port) : fail(new Error("no port"))));
      });
    });
  it("a failed enrolment skips claim and pipeline at once instead of polling for E2E_STEP_TIMEOUT_S", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamper-wp12-flow-"));
    try {
      const port = await closedPort();
      const dep = join(dir, "deployment.json");
      const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
      writeFileSync(
        dep,
        JSON.stringify({
          chainId: 31337,
          deployedAtBlock: 1,
          registry: a(1),
          resolver: a(2),
          pdpVerifier: a(3),
          fwss: a(4),
          stateView: a(5),
          governor: a(6),
          resolverOwner: a(6),
          registrars: [a(7)],
          binders: [a(8)],
        }),
      );
      const t0 = Date.now();
      const r = spawnSync(
        fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
        [fileURLToPath(new URL("../flow.ts", import.meta.url))],
        {
          encoding: "utf8",
          timeout: 90_000,
          env: {
            ...process.env,
            API_URL: `http://127.0.0.1:${port}`,
            RPC_URL: `http://127.0.0.1:${port}`,
            DEPLOYMENT_JSON: dep,
            E2E_OUT_DIR: dir,
            E2E_STEP_TIMEOUT_S: "1800",
          },
        },
      );
      expect(r.status, r.stderr.slice(-800)).toBe(1);
      expect(Date.now() - t0).toBeLessThan(60_000);
      const f = JSON.parse(readFileSync(join(dir, "flow.json"), "utf8")) as FlowResult;
      expect(f.legs.enrol?.status).toBe("fail");
      expect(f.legs.claim).toEqual({ status: "skip", detail: "enrolment failed" });
      expect(f.legs.pipeline).toEqual({ status: "skip", detail: "claim skipped" });
      expect(f.legs["chain-reverify"]?.status).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
