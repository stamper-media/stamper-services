import { readFile } from "node:fs/promises";
import {
  encodeAttachDerivative,
  encodeBindStorage,
  encodeRegisterStamp,
  encodeSetFlag,
  stampRegistryAbi,
} from "@stamper/contracts-abi";
import { encodeCode, finalityState, parsePieceCid } from "@stamper/core";
import type { DataSetRole } from "@stamper/foc";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { type Hex, parseEventLogs, type TransactionReceipt } from "viem";
import {
  bindings as bindingsT,
  captures as capturesT,
  derivatives,
  stamps as stampsT,
  uploads as uploadsT,
} from "../db/index.js";
import { bindings, stampEvents, stamps } from "../db/repo/index.js";
import { DEFAULT_SCHEDULES, type JobPayload } from "../queue/port.js";
import { byteaToHex, hexToBytea } from "../shared/index.js";
import { runwayDaysMetric } from "../shared/metrics.js";
import { TxRevertedError } from "./chain.js";
import type { Services } from "./services.js";
import { sleep } from "./util.js";

const SLOT_OF: Record<DataSetRole, number> = { A: 0, B: 1 };

/** Thrown to make the queue retry later (pg-boss backoff). */
export class RetryLater extends Error {
  override name = "RetryLater";
}

type Claim = {
  contentHash: Hex;
  pieceCid: Hex;
  contentLength: string;
  mediaKind: number;
  capturedAt: string;
  recordHash: Hex;
  keyId: Hex;
  nonce: string;
  flags: number;
  deadline: string;
};

async function stampOrThrow(s: Services, stampId: Hex) {
  const st = await stamps.byId(s.db, stampId);
  if (!st) throw new Error(`unknown stamp ${stampId}`);
  return st;
}

/** Apply a StampRegistered outcome (from the receipt or from chain state after a crash). */
async function markRegistered(
  s: Services,
  stampId: Hex,
  o: { code: bigint; level: number; epoch: bigint; tx: Hex | null },
) {
  await s.db.transaction(async (tx) => {
    await tx
      .update(stampsT)
      .set({
        code: o.code,
        level: o.level,
        registeredEpoch: o.epoch,
        ...(o.tx ? { registerTx: hexToBytea(o.tx) } : {}),
        status: "registered",
        finality: "included",
      })
      .where(and(eq(stampsT.stampId, hexToBytea(stampId)), eq(stampsT.status, "registering")));
    await stampEvents.append(tx, {
      stampId,
      kind: "registered",
      actor: "api",
      data: { code: encodeCode(o.code), tx: o.tx },
    });
  });
  await s.queue.enqueue("ingest", { stampId }, { singletonKey: stampId });
}

export async function handleRegister(
  s: Services,
  { stampId }: JobPayload["register"],
): Promise<void> {
  const st = await stampOrThrow(s, stampId);
  if (st.status !== "registering") return;
  const read = await s.pub.readContract({
    address: s.cfg.chain.registry,
    abi: stampRegistryAbi,
    functionName: "getStamp",
    args: [stampId],
  });
  if (read.registeredEpoch !== 0n) {
    await markRegistered(s, stampId, {
      code: BigInt(read.code),
      level: read.level,
      epoch: read.registeredEpoch,
      tx: null,
    });
    return;
  }
  const c = st.claim as Claim;
  const key = await s.pub.readContract({
    address: s.cfg.chain.registry,
    abi: stampRegistryAbi,
    functionName: "getKey",
    args: [c.keyId],
  });
  if (key.enrolledEpoch === 0n) throw new RetryLater("device key not yet enrolled on chain");
  const data = encodeRegisterStamp({
    claim: {
      ...c,
      contentLength: BigInt(c.contentLength),
      capturedAt: BigInt(c.capturedAt),
      nonce: BigInt(c.nonce),
      deadline: BigInt(c.deadline),
    },
    sig: byteaToHex(st.sig as Buffer),
    authData: st.authData ? byteaToHex(st.authData) : "0x",
    countersig: st.countersig ? byteaToHex(st.countersig) : "0x",
  });
  let receipt: TransactionReceipt;
  try {
    receipt = await s.relayer.sendAndWait("register", { to: s.cfg.chain.registry, data, stampId });
  } catch (e) {
    if (!(e instanceof TxRevertedError)) throw e;
    s.log.warn({ stampId, reason: e.reason }, "registerStamp rejected");
    await s.db.transaction(async (tx) => {
      await stamps.setStatus(tx, stampId, "rejected", { from: ["registering"] });
      await tx
        .update(capturesT)
        .set({ status: "rejected" })
        .where(eq(capturesT.stampId, hexToBytea(stampId)));
      await stampEvents.append(tx, {
        stampId,
        kind: "register_failed",
        actor: "api",
        data: { reason: e.reason, tx: e.hash ?? null },
      });
    });
    return;
  }
  const [ev] = parseEventLogs({
    abi: stampRegistryAbi,
    eventName: "StampRegistered",
    logs: receipt.logs,
  });
  if (!ev) throw new Error("StampRegistered event missing from receipt");
  await markRegistered(s, stampId, {
    code: BigInt(ev.args.code),
    level: ev.args.level,
    epoch: receipt.blockNumber,
    tx: receipt.transactionHash,
  });
}

export async function handleAttach(
  s: Services,
  { stampId, derivativeId }: JobPayload["attach"],
): Promise<void> {
  const [d] = await s.db
    .select()
    .from(derivatives)
    .where(eq(derivatives.id, derivativeId))
    .limit(1);
  if (!d || byteaToHex(d.stampId).toLowerCase() !== stampId.toLowerCase())
    throw new Error("unknown derivative");
  if (d.attachTx) return;
  const st = await stampOrThrow(s, stampId);
  if (st.code == null) throw new RetryLater("stamp not registered yet");
  const contentHash = byteaToHex(d.sha256);
  const paramsHash = d.paramsHash ? byteaToHex(d.paramsHash) : (`0x${"00".repeat(32)}` as Hex);
  const derivative = {
    contentHash,
    pieceCid: d.pieceCid ? byteaToHex(d.pieceCid) : ("0x" as Hex),
    kind: d.kind,
    paramsHash,
  };
  const onChain = await s.pub.readContract({
    address: s.cfg.chain.registry,
    abi: stampRegistryAbi,
    functionName: "getDerivatives",
    args: [stampId],
  });
  let txHash: Hex | null = null;
  if (!onChain.some((x) => x.contentHash.toLowerCase() === contentHash.toLowerCase())) {
    const registrarSig = await s.registrar.attachSig({ stampId, ...derivative });
    const r = await s.relayer.sendAndWait("attach", {
      to: s.cfg.chain.registry,
      data: encodeAttachDerivative({ stampId, derivative, registrarSig }),
      stampId,
    });
    txHash = r.transactionHash;
  }
  await s.db
    .update(derivatives)
    .set({ attachTx: hexToBytea(txHash ?? (`0x${"00".repeat(32)}` as Hex)) })
    .where(eq(derivatives.id, derivativeId));
  await stampEvents.append(s.db, {
    stampId,
    kind: "attached",
    actor: "api",
    data: { derivativeId, kind: d.kind, tx: txHash },
  });
}

async function stagedBytes(s: Services, stampId: Hex): Promise<Uint8Array> {
  const [u] = await s.db
    .select({ path: uploadsT.path })
    .from(uploadsT)
    .innerJoin(capturesT, eq(capturesT.id, uploadsT.captureId))
    .where(and(eq(capturesT.stampId, hexToBytea(stampId)), eq(uploadsT.status, "complete")))
    .limit(1);
  if (!u) throw new Error("staged original not found");
  return new Uint8Array(await readFile(u.path));
}

export async function handleCommit(
  s: Services,
  { stampId, dataSet }: JobPayload["commit"],
): Promise<void> {
  const st = await stampOrThrow(s, stampId);
  if (st.code == null || !st.pieceCid || !st.contentSha256)
    throw new RetryLater("stamp not registered yet");
  if (["rejected", "withdrawn", "takedown"].includes(st.status)) return;
  const slot = SLOT_OF[dataSet];
  const existing = (await bindings.forStamp(s.db, stampId)).find((b) => b.slot === slot);
  if (existing?.pieceId == null) {
    const pieceCid = parsePieceCid(byteaToHex(st.pieceCid));
    if (s.cfg.foc.mode === "mock") {
      // the mock SP lives in this process; the worker cannot reach it, so stage it here
      await s.foc.storeOriginal(dataSet, await stagedBytes(s, stampId), pieceCid);
    }
    const sha = byteaToHex(st.contentSha256).slice(2);
    const r = await s.foc.commitPieces(dataSet, [
      { pieceCid, metadata: { stamp: encodeCode(st.code), role: "original", sha256: sha } },
    ]);
    const urls = await s.foc.retrievalUrls(pieceCid).catch(() => null);
    await bindings.upsert(s.db, {
      stampId: hexToBytea(stampId),
      slot,
      asset: 0,
      dataSetId: r.dataSetId,
      pieceId: r.pieceIds[0] ?? null,
      providerId: s.cfg.foc.dataSets[dataSet].providerId,
      serviceUrl: (dataSet === "A" ? urls?.filbeam : null) ?? urls?.providers[0]?.url ?? null,
    });
    await stampEvents.append(s.db, {
      stampId,
      kind: "committed",
      actor: "api",
      data: { dataSet, tx: r.txHash, pieceId: r.pieceIds[0]?.toString() },
    });
  }
  const rows = await bindings.forStamp(s.db, stampId);
  const ready = (["A", "B"] as const).every((ds) =>
    rows.some((b) => b.slot === SLOT_OF[ds] && b.pieceId !== null),
  );
  if (ready && !rows.some((b) => b.bindTx))
    await s.queue.enqueue("bind", { stampId }, { singletonKey: stampId });
}

export async function handleBind(s: Services, { stampId }: JobPayload["bind"]): Promise<void> {
  const rows = (await bindings.forStamp(s.db, stampId)).filter(
    (b) => b.pieceId !== null && b.dataSetId !== null,
  );
  if (rows.length === 0) throw new RetryLater("nothing committed yet");
  if (rows.every((b) => b.bindTx)) return;
  const pending = rows.filter((b) => !b.bindTx);
  const r = await s.relayer.sendAndWait("bind", {
    to: s.cfg.chain.registry,
    data: encodeBindStorage({
      stampId,
      bindings: pending.map((b) => ({
        asset: b.asset,
        setId: b.dataSetId as bigint,
        pieceId: b.pieceId as bigint,
      })),
    }),
    stampId,
  });
  const evs = parseEventLogs({ abi: stampRegistryAbi, eventName: "StorageBound", logs: r.logs });
  await s.db.transaction(async (tx) => {
    for (const b of pending) {
      const ev = evs.find((e) => e.args.setId === b.dataSetId && e.args.pieceId === b.pieceId);
      if (!ev) continue;
      const slot = ev.args.slot;
      if (slot !== b.slot) {
        await tx
          .delete(bindingsT)
          .where(and(eq(bindingsT.stampId, b.stampId), eq(bindingsT.slot, b.slot)));
      }
      await bindings.upsert(tx, {
        ...b,
        slot,
        bindTx: hexToBytea(r.transactionHash),
        boundEpoch: r.blockNumber,
      });
    }
    await stampEvents.append(tx, {
      stampId,
      kind: "bound",
      actor: "api",
      data: { tx: r.transactionHash, slots: evs.map((e) => e.args.slot) },
    });
  });
  for (const e of evs)
    await s.queue.enqueue(
      "probe",
      { stampId, slot: e.args.slot },
      { singletonKey: `${stampId}:${e.args.slot}` },
    );
}

export async function handleFlag(s: Services, p: JobPayload["flag"]): Promise<void> {
  if (!s.resolverOwner) throw new Error("RESOLVER_OWNER_PK_FILE is not configured");
  const cur = await s.pub.readContract({
    address: s.cfg.chain.resolver,
    abi: [
      {
        type: "function",
        name: "flag",
        stateMutability: "view",
        inputs: [{ name: "stampId", type: "bytes32" }],
        outputs: [{ type: "uint8" }],
      },
    ] as const,
    functionName: "flag",
    args: [p.stampId],
  });
  if (cur === p.flag) return;
  const r = await s.resolverOwner.sendAndWait("flag", {
    to: s.cfg.chain.resolver,
    data: encodeSetFlag({ stampId: p.stampId, flag: p.flag as 0, reasonUri: p.reasonUri }),
    stampId: p.stampId,
  });
  await stampEvents.append(s.db, {
    stampId: p.stampId,
    kind: "flagged",
    actor: "api",
    data: { flag: p.flag, reasonUri: p.reasonUri, tx: r.transactionHash },
  });
}

/** One finality pass: head + 'finalized' → stamps.finality. */
export async function finalityPass(s: Services): Promise<number> {
  const head = await s.pub.getBlockNumber();
  const finalized = await s.pub.getBlock({ blockTag: "finalized" }).then(
    (b) => b.number,
    () => null,
  );
  const rows = await s.db
    .select({
      stampId: stampsT.stampId,
      epoch: stampsT.registeredEpoch,
      finality: stampsT.finality,
    })
    .from(stampsT)
    .where(
      and(
        isNotNull(stampsT.registeredEpoch),
        ne(stampsT.finality, "final"),
        inArray(stampsT.status, ["registered", "marked", "stored", "withdrawn", "takedown"]),
      ),
    )
    .limit(5000);
  let changed = 0;
  for (const r of rows) {
    const f = finalityState(head, finalized ?? null, r.epoch as bigint);
    if (f !== r.finality) {
      await s.db.update(stampsT).set({ finality: f }).where(eq(stampsT.stampId, r.stampId));
      changed++;
    }
  }
  return changed;
}

export async function handleFinality(s: Services): Promise<void> {
  await finalityPass(s);
  await sleep(s.finalityIntervalMs);
  await finalityPass(s);
}

async function notify(s: Services, title: string, msg: string) {
  s.log.warn({ title, msg }, "ops alert");
  if (!s.cfg.ntfyUrl) return;
  await fetch(s.cfg.ntfyUrl, { method: "POST", headers: { title }, body: msg }).catch(
    (e: unknown) => s.log.error({ err: e }, "ntfy failed"),
  );
}

export const MIN_RELAYER_WEI = 5n * 10n ** 17n;
export const SESSION_WARN_S = 2 * 86_400;

export async function handleRunway(s: Services): Promise<void> {
  const [runway, bal, sess] = await Promise.allSettled([
    s.foc.runway(),
    s.relayer.balance(),
    s.foc.sessionExpiry(),
  ]);
  if (runway.status === "fulfilled" && s.ctx?.metrics)
    runwayDaysMetric(s.ctx.metrics)(runway.value.days);
  if (runway.status === "fulfilled" && runway.value.days !== null && runway.value.days < 60) {
    await notify(s, "FOC runway low", `${runway.value.days} days of storage funding left`);
  }
  if (bal.status === "fulfilled" && bal.value < MIN_RELAYER_WEI) {
    await notify(
      s,
      "Relayer balance low",
      `relayer ${s.relayer.address} holds ${bal.value} wei (< 0.5 FIL)`,
    );
  }
  if (sess.status === "fulfilled" && sess.value.secondsLeft <= SESSION_WARN_S) {
    await notify(
      s,
      "Session key expiring",
      `FOC session key expires ${sess.value.expiresAt.toISOString()}`,
    );
  }
  for (const r of [runway, bal, sess])
    if (r.status === "rejected") s.log.error({ err: r.reason }, "runway check failed");
}

export async function registerJobs(s: Services): Promise<void> {
  const q = s.queue;
  await q.work("register", (p) => handleRegister(s, p), { concurrency: 8 });
  await q.work("attach", (p) => handleAttach(s, p), { concurrency: 4 });
  await q.work("commit", (p) => handleCommit(s, p), { concurrency: 2 });
  await q.work("bind", (p) => handleBind(s, p), { concurrency: 4 });
  await q.work("flag", (p) => handleFlag(s, p));
  await q.work("finality", () => handleFinality(s));
  await q.work("runway", () => handleRunway(s));
  for (const n of ["finality", "runway"] as const) {
    const cron = DEFAULT_SCHEDULES[n];
    if (cron) await q.schedule(n, cron);
  }
}
