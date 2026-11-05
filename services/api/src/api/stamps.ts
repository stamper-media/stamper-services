import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type Readable, Transform } from "node:stream";
import { ResolverFlag, readStampBundle, stampResolverAbi } from "@stamper/contracts-abi";
import {
  epochToUnix,
  FLAG,
  FOOTER,
  normaliseCode,
  parsePieceCid,
  pieceCidString,
  tierSentence,
  verifyDeviceSignature,
} from "@stamper/core";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { type Address, type Hex, hashMessage } from "viem";
import type { z } from "zod";
import {
  attestationBundles,
  captures as capturesT,
  chainTxs as chainTxsT,
  derivatives,
  stamps as stampsT,
  uploads as uploadsT,
} from "../db/index.js";
import { type StampRow, stampEvents, stamps } from "../db/repo/index.js";
import { byteaToHex, cachePath } from "../shared/index.js";
import { SERVER_FLAG } from "./captures/validate-claim.js";
import { ApiError } from "./errors.js";
import { enrolledKey, keyRow } from "./keys.js";
import type { StampPresentation, WithdrawBody } from "./schemas.js";
import type { Services } from "./services.js";

export const RENDITION_FILES = [
  "share.jpg",
  "share.mp4",
  "share-card.png",
  "preview.jpg",
  "thumb.webp",
] as const;
export type RenditionFile = (typeof RENDITION_FILES)[number];

export async function stampByCode(
  s: Services,
  code: string,
): Promise<{ row: StampRow; code9: string }> {
  const n = normaliseCode(code);
  if (!n.ok) throw new ApiError(422, "InvalidCode", { reason: n.reason });
  const row = await stamps.byCode(s.db, n.value);
  if (!row) throw new ApiError(404, "NotRegistered");
  return { row, code9: n.code9 };
}

const RESOLVER_NAMES = Object.fromEntries(
  Object.entries(ResolverFlag).map(([k, v]) => [v, k]),
) as Record<number, string>;

export type ChainView = {
  resolverFlag: number | null;
  registrar: Address | null;
  registrarActive: boolean;
  revokedEpoch: bigint;
  effectiveLevel: number | null;
};

const chainCache = new Map<string, { at: number; v: ChainView }>();

/** Live chain facts for the page (resolver flag, registrar, revocation); 15 s cache, null on failure. */
export async function chainView(s: Services, stampId: Hex): Promise<ChainView | null> {
  const hit = chainCache.get(stampId);
  if (hit && s.now() - hit.at < 15_000) return hit.v;
  try {
    const [b, flag] = await Promise.all([
      readStampBundle(s.pub, s.cfg.chain.registry, stampId),
      s.pub.readContract({
        address: s.cfg.chain.resolver,
        abi: stampResolverAbi,
        functionName: "flag",
        args: [stampId],
      }),
    ]);
    const zero = "0x0000000000000000000000000000000000000000";
    const v: ChainView = {
      resolverFlag: Number(flag),
      registrar: b.key.registrar === zero ? null : b.key.registrar,
      registrarActive: b.registrarActiveFrom !== 0n,
      revokedEpoch: b.key.revokedEpoch,
      effectiveLevel: b.effectiveLevel,
    };
    if (chainCache.size > 10_000) chainCache.clear();
    chainCache.set(stampId, { at: s.now(), v });
    return v;
  } catch (e) {
    s.log.warn({ err: e, stampId }, "chain view unavailable");
    return null;
  }
}

export function explorers(
  chainId: number,
  tx: Hex | undefined,
): { blockscout: string; filfox: string } {
  if (!tx || chainId === 31337) return { blockscout: "", filfox: "" };
  return chainId === 314
    ? {
        blockscout: `https://filecoin.blockscout.com/tx/${tx}`,
        filfox: `https://filfox.info/en/message/${tx}`,
      }
    : {
        blockscout: `https://filecoin-testnet.blockscout.com/tx/${tx}`,
        filfox: `https://calibration.filfox.info/en/message/${tx}`,
      };
}

export type PresentationInput = {
  row: StampRow;
  code9: string;
  key: { keyType: number; revokedEpoch: bigint | null };
  claimFlags: number;
  chain: ChainView | null;
  chainId: number;
  baseUrl: string;
  renditions: Partial<Record<RenditionFile, boolean>>;
  derivatives: Array<{ kind: number; sha256: Hex; paramsHash: Hex; attachTx?: Hex }>;
  bindings: StampPresentation["bindings"];
  bindTxs: number;
  sources: { filbeam?: string; providers: string[] };
};

/** Pure DTO builder; every user-facing sentence comes from @stamper/core. */
export function buildPresentation(i: PresentationInput): StampPresentation {
  const r = i.row;
  const level = r.level ?? 0;
  const regEpoch = r.registeredEpoch ?? 0n;
  const revoked = i.chain?.revokedEpoch ?? i.key.revokedEpoch ?? 0n;
  const revokedBeforeStamp = revoked !== 0n && regEpoch !== 0n && revoked <= regEpoch;
  const registrarRemoved = i.chain ? i.chain.registrar !== null && !i.chain.registrarActive : false;
  const effective = i.chain?.effectiveLevel ?? (revokedBeforeStamp ? 0 : level);
  const flags: string[] = [];
  if (i.claimFlags & FLAG.OFFLINE) flags.push("OFFLINE");
  if (i.claimFlags & FLAG.PIECECID_SERVER_COMPUTED) flags.push("PIECECID_SERVER_COMPUTED");
  if (r.flags & SERVER_FLAG.CAPTURE_TIME_SKEW) flags.push("CAPTURE_TIME_SKEW");
  const tier = tierSentence({
    level,
    keyType: i.key.keyType,
    countersigned: !!r.countersig && r.countersig.length === 66,
    revokedBeforeStamp,
    registrarRemoved,
    offline: (i.claimFlags & FLAG.OFFLINE) !== 0,
    serverComputedCid: (i.claimFlags & FLAG.PIECECID_SERVER_COMPUTED) !== 0,
  });
  const pieceCidHex = byteaToHex(r.pieceCid as Buffer);
  let pieceCid = "";
  try {
    pieceCid = pieceCidString(parsePieceCid(pieceCidHex));
  } catch {
    pieceCid = "";
  }
  const base = `${i.baseUrl}/v1/stamps/${i.code9}`;
  const renditions: StampPresentation["renditions"] = {};
  const share: RenditionFile = r.mediaKind === 2 ? "share.mp4" : "share.jpg";
  if (i.renditions[share]) renditions.share = `${base}/${share}`;
  if (i.renditions["share-card.png"]) renditions.shareCard = `${base}/share-card.png`;
  if (i.renditions["preview.jpg"]) renditions.preview = `${base}/preview.jpg`;
  if (i.renditions["thumb.webp"]) renditions.thumb = `${base}/thumb.webp`;
  const bound = i.bindings.filter((b) => b.boundEpoch !== "");
  const storageState: StampPresentation["storageState"] =
    i.bindTxs === 0
      ? "pending"
      : bound.length > 0 && bound.every((b) => b.probeFailures >= 3)
        ? "unavailable"
        : "bound";
  const registerTx = r.registerTx ? byteaToHex(r.registerTx) : undefined;
  const chainRegistrarAt =
    regEpoch !== 0n && (i.chainId === 314 || i.chainId === 314159)
      ? new Date(epochToUnix(i.chainId, regEpoch) * 1000).toISOString()
      : undefined;
  const flagNum = i.chain?.resolverFlag ?? null;
  return {
    code9: i.code9,
    stampId: byteaToHex(r.stampId),
    status: r.status,
    finality: r.finality as StampPresentation["finality"],
    level,
    effectiveLevel: effective,
    tier,
    footer: FOOTER,
    flags,
    resolverFlag: flagNum ? (RESOLVER_NAMES[flagNum] ?? String(flagNum)) : null,
    mediaKind: (r.mediaKind === 2 ? 2 : 1) as 1 | 2,
    mime: r.mime ?? "application/octet-stream",
    contentHash: byteaToHex(r.contentSha256 as Buffer),
    pieceCid,
    pieceCidHex,
    contentLength: (r.size ?? 0n).toString(),
    ...(r.width != null ? { width: r.width } : {}),
    ...(r.height != null ? { height: r.height } : {}),
    ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
    capturedAt: (r.capturedAt ?? r.receivedAt).toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    ...(r.registeredEpoch != null ? { registeredEpoch: r.registeredEpoch.toString() } : {}),
    ...(chainRegistrarAt ? { registeredAtUtc: chainRegistrarAt } : {}),
    ...(registerTx ? { registerTx } : {}),
    keyId: byteaToHex(r.keyId as Buffer),
    keyType: i.key.keyType,
    ...(i.chain?.registrar ? { registrar: i.chain.registrar } : {}),
    ...(revoked !== 0n ? { revokedEpoch: revoked.toString() } : {}),
    renditions,
    derivatives: i.derivatives,
    bindings: i.bindings,
    originalSources: {
      ...(i.sources.filbeam ? { filbeam: i.sources.filbeam } : {}),
      providers: i.sources.providers,
      mirror: `${base}/original`,
    },
    storageState,
    explorers: explorers(i.chainId, registerTx),
    record: r.recordCbor ? Buffer.from(r.recordCbor).toString("base64") : null,
  };
}

const exists = (p: string) =>
  stat(p).then(
    (x) => x.isFile(),
    () => false,
  );

export async function presentation(s: Services, code: string): Promise<StampPresentation> {
  const { row, code9 } = await stampByCode(s, code);
  const stampId = byteaToHex(row.stampId);
  const kr = row.keyId ? await keyRow(s.db, byteaToHex(row.keyId)) : undefined;
  const claim = row.claim as { flags?: number } | null;
  const servable = !["withdrawn", "takedown", "rejected"].includes(row.status);
  const rend: Partial<Record<RenditionFile, boolean>> = {};
  if (servable)
    for (const f of RENDITION_FILES) rend[f] = await exists(cachePath(s.cfg, stampId, f));
  const ds = await s.db
    .select()
    .from(derivatives)
    .where(eq(derivatives.stampId, row.stampId))
    .orderBy(asc(derivatives.id));
  const bs = await s.db.query.bindings.findMany({
    where: (b, { eq: e }) => e(b.stampId, row.stampId),
    orderBy: (b, { asc: a }) => [a(b.slot)],
  });
  let sources: PresentationInput["sources"] = { providers: [] };
  if (servable && bs.some((b) => b.bindTx)) {
    try {
      const u = await s.foc.retrievalUrls(parsePieceCid(byteaToHex(row.pieceCid as Buffer)));
      sources = {
        ...(u.filbeam ? { filbeam: u.filbeam } : {}),
        providers: u.providers.map((p) => p.url),
      };
    } catch {
      sources = { providers: [] };
    }
  }
  const chain = row.registeredEpoch != null ? await chainView(s, stampId) : null;
  return buildPresentation({
    row,
    code9,
    key: { keyType: kr?.keyType ?? 0, revokedEpoch: kr?.revokedEpoch ?? null },
    claimFlags: claim?.flags ?? 0,
    chain,
    chainId: s.cfg.chain.id,
    baseUrl: s.cfg.publicBaseUrl,
    renditions: rend,
    derivatives: ds.map((d) => ({
      kind: d.kind,
      sha256: byteaToHex(d.sha256),
      paramsHash: d.paramsHash ? byteaToHex(d.paramsHash) : (`0x${"00".repeat(32)}` as Hex),
      ...(d.attachTx ? { attachTx: byteaToHex(d.attachTx) } : {}),
    })),
    bindings: bs.map((b) => ({
      slot: b.slot,
      asset: b.asset,
      dataSetId: (b.dataSetId ?? 0n).toString(),
      pieceId: (b.pieceId ?? 0n).toString(),
      providerId: (b.providerId ?? 0n).toString(),
      serviceUrl: b.serviceUrl ?? "",
      boundEpoch: b.boundEpoch != null ? b.boundEpoch.toString() : "",
      ...(b.lastProbeAt ? { lastProbeAt: b.lastProbeAt.toISOString() } : {}),
      ...(b.lastOkAt ? { lastOkAt: b.lastOkAt.toISOString() } : {}),
      probeFailures: b.probeFailures,
    })),
    bindTxs: bs.filter((b) => b.bindTx).length,
    sources,
  });
}

const etagCache = new Map<string, { key: string; etag: string }>();

/** Rendition files from CACHE_DIR; 404 until marked; ETag = sha256 of the file. */
export async function rendition(s: Services, code: string, file: RenditionFile) {
  const { row } = await stampByCode(s, code);
  if (["withdrawn", "takedown", "rejected"].includes(row.status))
    throw new ApiError(410, "NotServed", { status: row.status });
  const path = cachePath(s.cfg, byteaToHex(row.stampId), file);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new ApiError(404, "NotMarked");
  const k = `${st.size}:${st.mtimeMs}`;
  let etag = etagCache.get(path);
  if (!etag || etag.key !== k) {
    const h = createHash("sha256");
    for await (const c of createReadStream(path)) h.update(c as Buffer);
    etag = { key: k, etag: `"${h.digest("hex")}"` };
    etagCache.set(path, etag);
  }
  const type =
    { jpg: "image/jpeg", mp4: "video/mp4", png: "image/png", webp: "image/webp" }[
      file.split(".").pop() as string
    ] ?? "application/octet-stream";
  return { path, size: st.size, etag: etag.etag, type };
}

/** Stream that fails (aborting the response) if the bytes do not hash to `want`. */
export function hashChecked(src: Readable, want: Hex): Readable {
  const h = createHash("sha256");
  const t = new Transform({
    transform(c: Buffer, _e, cb) {
      h.update(c);
      cb(null, c);
    },
    flush(cb) {
      const got = `0x${h.digest("hex")}`;
      cb(
        got === want.toLowerCase()
          ? null
          : new Error("original bytes differ from the registered sha256"),
      );
    },
  });
  src.on("error", (e) => t.destroy(e));
  return src.pipe(t);
}

export type OriginalResult =
  | { kind: "redirect"; url: string }
  | {
      kind: "stream";
      body: Readable;
      etag: string;
      source: "mirror" | "staging";
      size?: number;
      mime: string;
    };

export async function original(
  s: Services,
  code: string,
  mirrorGet?: (sha: Hex) => Promise<{ body: Readable; size?: number } | null>,
): Promise<OriginalResult> {
  const { row } = await stampByCode(s, code);
  if (["withdrawn", "takedown", "rejected"].includes(row.status))
    throw new ApiError(410, "NotServed", { status: row.status });
  const sha = byteaToHex(row.contentSha256 as Buffer);
  const etag = `"${sha.slice(2)}"`;
  const mime = row.mime ?? "application/octet-stream";
  const bs = await s.db.query.bindings.findMany({
    where: (b, { eq: e }) => e(b.stampId, row.stampId),
  });
  const healthy = bs.some((b) => b.bindTx && b.lastOkAt && b.probeFailures === 0);
  if (healthy) {
    try {
      const u = await s.foc.retrievalUrls(parsePieceCid(byteaToHex(row.pieceCid as Buffer)));
      const url = u.filbeam ?? u.providers[0]?.url;
      if (url) return { kind: "redirect", url };
    } catch (e) {
      s.log.warn({ err: e }, "retrieval URLs unavailable; proxying");
    }
  }
  if (mirrorGet) {
    const m = await mirrorGet(sha).catch(() => null);
    if (m)
      return {
        kind: "stream",
        body: hashChecked(m.body, sha),
        etag,
        source: "mirror",
        mime,
        ...(m.size ? { size: m.size } : {}),
      };
  }
  const [u] = await s.db
    .select({ path: uploadsT.path })
    .from(uploadsT)
    .innerJoin(capturesT, eq(capturesT.id, uploadsT.captureId))
    .where(and(eq(capturesT.stampId, row.stampId), eq(uploadsT.status, "complete")))
    .limit(1);
  const st = u ? await stat(u.path).catch(() => null) : null;
  if (!u || !st) throw new ApiError(503, "OriginalUnavailable");
  return {
    kind: "stream",
    body: hashChecked(createReadStream(u.path), sha),
    etag,
    source: "staging",
    size: st.size,
    mime,
  };
}

export async function evidence(s: Services, code: string): Promise<Record<string, unknown>> {
  const p = await presentation(s, code);
  const { row } = await stampByCode(s, code);
  const kr = row.keyId ? await keyRow(s.db, byteaToHex(row.keyId)) : undefined;
  const txs = await s.db
    .select()
    .from(chainTxsT)
    .where(eq(chainTxsT.stampId, row.stampId))
    .orderBy(asc(chainTxsT.submittedAt));
  const bundles = await s.db
    .select({
      kind: attestationBundles.kind,
      sha256: attestationBundles.sha256,
      at: attestationBundles.createdAt,
    })
    .from(attestationBundles)
    .where(and(isNotNull(attestationBundles.stampId), eq(attestationBundles.stampId, row.stampId)));
  const ds = await s.db.select().from(derivatives).where(eq(derivatives.stampId, row.stampId));
  return {
    v: 1,
    generatedAt: new Date(s.now()).toISOString(),
    chainId: s.cfg.chain.id,
    registry: s.cfg.chain.registry,
    resolver: s.cfg.chain.resolver,
    code9: p.code9,
    stampId: p.stampId,
    claim: row.claim,
    sig: row.sig ? byteaToHex(row.sig) : null,
    authData: row.authData ? byteaToHex(row.authData) : null,
    countersig: row.countersig ? byteaToHex(row.countersig) : null,
    record: row.recordCbor ? Buffer.from(row.recordCbor).toString("base64") : null,
    contentHash: p.contentHash,
    pieceCid: p.pieceCid,
    pieceCidHex: p.pieceCidHex,
    registeredEpoch: p.registeredEpoch ?? null,
    finality: p.finality,
    level: p.level,
    effectiveLevel: p.effectiveLevel,
    key: kr
      ? {
          keyId: p.keyId,
          keyType: kr.keyType,
          platform: kr.platform,
          attestationHash: kr.attestationHash ? byteaToHex(kr.attestationHash) : null,
          registeredTx: kr.registeredTx ? byteaToHex(kr.registeredTx) : null,
        }
      : null,
    captureAttestationSha256: bundles.map((b) => ({
      kind: b.kind,
      sha256: byteaToHex(b.sha256),
      at: b.at.toISOString(),
    })),
    txs: txs.map((t) => ({
      hash: byteaToHex(t.hash),
      kind: t.kind,
      nonce: t.nonce?.toString() ?? null,
      status: t.status,
      includedEpoch: t.includedEpoch?.toString() ?? null,
      submittedAt: t.submittedAt.toISOString(),
    })),
    derivatives: ds.map((d) => ({
      kind: d.kind,
      sha256: byteaToHex(d.sha256),
      paramsHash: d.paramsHash ? byteaToHex(d.paramsHash) : null,
      params: d.params,
      attachTx: d.attachTx ? byteaToHex(d.attachTx) : null,
    })),
    bindings: p.bindings,
    probeLog: p.bindings.map((b) => ({
      slot: b.slot,
      lastProbeAt: b.lastProbeAt ?? null,
      lastOkAt: b.lastOkAt ?? null,
      probeFailures: b.probeFailures,
    })),
  };
}

/** EIP-191 text the device key signs to withdraw a stamp. */
export const withdrawMessage = (stampId: Hex, issuedAtMs: bigint) =>
  `Stamper withdraw ${stampId.toLowerCase()} at ${issuedAtMs}`;

export async function withdraw(s: Services, code: string, b: z.output<typeof WithdrawBody>) {
  const { row, code9 } = await stampByCode(s, code);
  if (!row.keyId) throw new ApiError(409, "NoKey");
  if (Math.abs(Number(b.issuedAt) - s.now()) > 10 * 60_000) throw new ApiError(422, "Expired");
  const kr = await keyRow(s.db, byteaToHex(row.keyId));
  if (!kr) throw new ApiError(409, "NoKey");
  const k = enrolledKey(kr);
  const stampId = byteaToHex(row.stampId);
  const digest = hashMessage(withdrawMessage(stampId, b.issuedAt));
  let ok = false;
  try {
    ok =
      k.keyType === 0 || k.keyType === 3
        ? verifyDeviceSignature(
            { keyType: k.keyType, addr: k.addr as Address },
            digest,
            b.sig,
            "0x",
            0n,
          )
        : verifyDeviceSignature(
            {
              keyType: k.keyType as 1 | 2,
              x: k.x as Hex,
              y: k.y as Hex,
              ...(k.rpIdHash ? { rpIdHash: k.rpIdHash } : {}),
            },
            digest,
            b.sig,
            b.authData ?? "0x",
            0n,
          );
  } catch {
    ok = false;
  }
  if (!ok) throw new ApiError(401, "BadSig");
  if (row.status !== "withdrawn") {
    await s.db.transaction(async (tx) => {
      await tx.update(stampsT).set({ status: "withdrawn" }).where(eq(stampsT.stampId, row.stampId));
      await stampEvents.append(tx, {
        stampId,
        kind: "withdrawn",
        actor: "author",
        data: { reason: b.reason ?? null },
      });
    });
  }
  await s.queue.enqueue(
    "flag",
    {
      stampId,
      flag: ResolverFlag.WithdrawnByAuthor,
      reasonUri: `${s.cfg.publicBaseUrl}/v1/stamps/${code9}/evidence.json`,
    },
    { singletonKey: `${stampId}:flag` },
  );
  return { stampId, status: "withdrawn" as const };
}
