/**
 * @anvil — anvil + DeployLocal + 48 h warp + throwaway Postgres + FOC_MODE=mock + ATTEST_MODE=stub.
 * Uses ANVIL_RPC_URL when set (a fresh DeployLocal is still run against it), otherwise spawns anvil on
 * a free port. Skips with a visible reason when anvil/forge or docker are unavailable.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Deployment,
  mockPdpVerifierAbi,
  parseDeployment,
  stampRegistryAbi,
} from "@stamper/contracts-abi";
import { hashKeyPossession, PF, stamperDomain } from "@stamper/core";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createPublicClient, encodeFunctionData, type Hex, http, type PublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubToken } from "../../src/api/attest/index.js";
import { TxRevertedError } from "../../src/api/chain.js";
import { hexBytes, sha256Hex } from "../../src/api/util.js";
import { chainTxs, derivatives, stamps } from "../../src/db/index.js";
import { hexToBytea } from "../../src/shared/index.js";
import { freshDatabase, skipReason as pgSkip, startPg, stopPg } from "../foundation/pg.js";
import {
  apiEnv,
  buildClaim,
  freePort,
  type Harness,
  harness,
  newDevice,
  wireClaim,
} from "./harness.js";

const CONTRACTS = join(
  process.env.STAMPER_PROTOCOL_DIR ?? join(import.meta.dirname, "../../../../../stamper-protocol"),
  "contracts",
);
const has = (bin: string) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

let skip = "";
if (!has("anvil") || !has("forge")) skip = "anvil/forge not on PATH";
const admin = skip ? null : await startPg();
if (!skip && !admin) skip = pgSkip;
if (skip) console.warn(`[skip] api flow @anvil: ${skip}`);
const d = skip ? describe.skip : describe;

d("custodian flow @anvil", () => {
  let anvil: ChildProcess | null = null;
  let rpc = "";
  let dep: Deployment;
  let h: Harness;
  let pub: PublicClient;
  const outFile = `deployments/wp07-test-${process.pid}.json`;
  const req = (path: string, init?: RequestInit) => h.ctx.http.request(path, init);
  const rpcCall = (method: string, params: unknown[]) =>
    fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  beforeAll(async () => {
    rpc = process.env.ANVIL_RPC_URL ?? "";
    if (!rpc) {
      const port = await freePort();
      anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
      rpc = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        if (
          await rpcCall("eth_chainId", []).then(
            (r) => r.ok,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    execFileSync(
      "forge",
      ["script", "script/DeployLocal.s.sol", "--rpc-url", rpc, "--broadcast", "-q"],
      {
        cwd: CONTRACTS,
        env: { ...process.env, DEPLOYMENTS_OUT: outFile },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    dep = parseDeployment(JSON.parse(readFileSync(join(CONTRACTS, outFile), "utf8")));
    await rpcCall("evm_increaseTime", [172_800]);
    await rpcCall("evm_mine", []);
    pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
    h = await harness(
      await apiEnv({
        DATABASE_URL: await freshDatabase(),
        RPC_URLS: rpc,
        REGISTRY_ADDRESS: dep.registry,
        RESOLVER_ADDRESS: dep.resolver,
        PDP_VERIFIER_ADDRESS: dep.pdpVerifier,
        FWSS_ADDRESS: dep.fwss,
        REORG_DEPTH: "0",
        RECEIPT_TIMEOUT_MS: "20000",
      }),
      // the chain clock was warped 48 h; claims must be signed against chain time
      { now: () => Date.now() + 172_800_000 + 60_000 },
    );
  }, 240_000);

  afterAll(async () => {
    await h?.close();
    anvil?.kill("SIGTERM");
    await stopPg();
    const f = join(CONTRACTS, outFile);
    if (existsSync(f)) rmSync(f);
  });

  it("enrol → capture → upload → claim → register → attach → commit ×2 → bind", async () => {
    const now = h.services.now;
    const dev = newDevice();
    const domain = stamperDomain(31337, dep.registry);

    // enrolment with a stub Play Integrity token ⇒ level 1 on chain
    const ch = (await (await req(`/v1/attest/challenge?keyId=${dev.keyId}`)).json()) as {
      challengeId: string;
      challenge: Hex;
    };
    const zero32 = `0x${"00".repeat(32)}` as Hex;
    const popSig = await dev.account.sign({
      hash: hashKeyPossession(domain, {
        keyId: dev.keyId,
        keyType: 0,
        platform: PF.ANDROID,
        x: zero32,
        y: zero32,
        addr: dev.addr,
      }),
    });
    const binding = sha256Hex(hexBytes(dev.addr), hexBytes(ch.challenge));
    let r = await req("/v1/devices/android", {
      method: "POST",
      body: JSON.stringify({
        addr: dev.addr,
        keyId: dev.keyId,
        platform: "android",
        popSig,
        attestation: {
          kind: "stub",
          token: stubToken("android", binding),
          challengeId: ch.challengeId,
        },
        appInfo: { id: "media.stamper.app", version: "1.0.0", build: "1" },
      }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as { level: number }).level).toBe(1);
    const key = await pub.readContract({
      address: dep.registry,
      abi: stampRegistryAbi,
      functionName: "getKey",
      args: [dev.keyId],
    });
    expect(key.level).toBe(1);
    expect(key.registrar).toBe(dep.registrars[0]);

    // capture + upload (fixture JPEG in 3 chunks)
    const jpeg = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 10 } },
      })
        .jpeg({ quality: 90 })
        .toBuffer(),
    );
    r = await req("/v1/captures", {
      method: "POST",
      body: JSON.stringify({ keyId: dev.keyId, mediaKind: 1, expectedSize: String(jpeg.length) }),
    });
    const cap = (await r.json()) as {
      captureId: string;
      uploadId: string;
      challengeId: string;
      challenge: Hex;
    };
    const third = Math.ceil(jpeg.length / 3);
    for (let a = 0; a < jpeg.length; a += third) {
      const b = Math.min(a + third, jpeg.length);
      r = await req(`/v1/uploads/${cap.uploadId}`, {
        method: "PUT",
        headers: { "content-range": `bytes ${a}-${b - 1}/${jpeg.length}` },
        body: jpeg.slice(a, b),
      });
      expect(r.status).toBe(b === jpeg.length ? 201 : 308);
    }

    // claim
    const built = await buildClaim({
      bytes: jpeg,
      device: dev,
      chainId: 31337,
      registry: dep.registry,
      challenge: cap.challenge,
      capturedAt: BigInt(now()),
    });
    const token = stubToken("android", sha256Hex(hexBytes(built.digest), hexBytes(cap.challenge)));
    r = await req(`/v1/captures/${cap.captureId}/claim`, {
      method: "POST",
      body: JSON.stringify({
        claim: wireClaim(built.claim),
        sig: built.sig,
        record: Buffer.from(built.record).toString("base64"),
        attestation: { kind: "stub", token, challengeId: cap.challengeId },
      }),
    });
    expect(r.status, await r.clone().text()).toBe(202);
    const claimed = (await r.json()) as { stampId: Hex; predictedCode: string };
    expect(claimed.stampId).toBe(built.digest);

    // register handler
    await h.queue.drain();
    const st = (await (await req(`/v1/captures/${cap.captureId}`)).json()) as {
      status: string;
      code: string;
      predictedCode: string;
    };
    expect(st.status).toBe("registered");
    expect(st.code).toBe(claimed.predictedCode);
    const onChain = await pub.readContract({
      address: dep.registry,
      abi: stampRegistryAbi,
      functionName: "getStamp",
      args: [claimed.stampId],
    });
    expect(onChain.level).toBe(1);
    expect(onChain.countersigner).toBe(h.services.registrar.address);
    expect(h.queue.pending.some((p) => p.name === "ingest")).toBe(true);

    // simulate the worker: a marked derivative, then attach
    const [row] = await h.ctx.db
      .insert(derivatives)
      .values({
        stampId: hexToBytea(claimed.stampId),
        kind: 1,
        sha256: hexToBytea(sha256Hex(new Uint8Array([1, 2, 3]))),
        paramsHash: hexToBytea(sha256Hex(new Uint8Array([4]))),
      })
      .returning({ id: derivatives.id });
    await h.queue.enqueue("attach", { stampId: claimed.stampId, derivativeId: row?.id as number });
    await h.queue.drain();
    expect(
      ((await (await req(`/v1/captures/${cap.captureId}`)).json()) as { shareReady: boolean })
        .shareReady,
    ).toBe(true);

    // commit A and B (mock FOC → MockPDPVerifier.addPiece), then bind
    await h.queue.enqueue("commit", { stampId: claimed.stampId, dataSet: "A" });
    await h.queue.enqueue("commit", { stampId: claimed.stampId, dataSet: "B" });
    await h.queue.drain();
    expect(h.queue.failed).toEqual([]);
    const bs = await pub.readContract({
      address: dep.registry,
      abi: stampRegistryAbi,
      functionName: "getBindings",
      args: [claimed.stampId],
    });
    const trusted = bs.filter((b) => b.trusted && b.setId !== 0n);
    expect(trusted.map((b) => b.setId).sort()).toEqual([1n, 2n]);
    const p = (await (await req(`/v1/stamps/${st.code}`)).json()) as {
      storageState: string;
      level: number;
      registrar: string;
    };
    expect(p.storageState).toBe("bound");
    expect(p.level).toBe(1);
    expect(h.queue.pending.filter((j) => j.name === "probe")).toHaveLength(2);
    const fin = await import("../../src/api/jobs.js");
    await fin.finalityPass(h.services);
    const [s2] = await h.ctx.db
      .select({ f: stamps.finality })
      .from(stamps)
      .where(hexEq(claimed.stampId));
    expect(["included", "safe", "final"]).toContain(s2?.f);
  }, 120_000);

  it("relayer: 20 concurrent sends keep nonces gap-free; a reverting call is refused before broadcast", async () => {
    const rel = h.services.relayer;
    const data = (i: number) =>
      encodeFunctionData({
        abi: mockPdpVerifierAbi,
        functionName: "addPiece",
        args: [1n, `0x0155${i.toString(16).padStart(4, "0")}`],
      });
    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        rel.send("test", { to: dep.pdpVerifier, data: data(i) }),
      ),
    );
    const nonces = sent.map((s) => s.nonce).sort((a, b) => a - b);
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]).toBe((nonces[i - 1] as number) + 1);
    const receipts = await Promise.all(sent.map((s) => s.wait()));
    expect(receipts.every((x) => x.status === "success")).toBe(true);
    const rows = await h.ctx.db.select().from(chainTxs);
    expect(rows.filter((x) => x.kind === "test" && x.status === "included")).toHaveLength(20);

    const bad = encodeFunctionData({
      abi: stampRegistryAbi,
      functionName: "bindStorage",
      args: [`0x${"ee".repeat(32)}`, []],
    });
    const err = await rel.send("test", { to: dep.registry, data: bad }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxRevertedError);
    expect((err as TxRevertedError).reason).toContain("NoStamp");
    // the lane still works after a refusal
    expect((await rel.sendAndWait("test", { to: dep.pdpVerifier, data: data(99) })).status).toBe(
      "success",
    );
  }, 60_000);
});

const hexEq = (id: Hex) => eq(stamps.stampId, hexToBytea(id));
