/**
 * Whole flow as a simulated device (plan §WP-12):
 * key → enrol (stub) → fixture JPEG → minimise → sha256 + PieceCID (both impls) → capture → upload ×3 →
 * signed claim → 202 → receipt → marked → bound ×2 → probe ok → chain re-verification → ladder legs
 * (ORIGINAL, STAMPER MARKED COPY, RELATED) → video with a server-computed PieceCID.
 *
 * Env: API_URL, RPC_URL, DEPLOYMENT_JSON (required); E2E_OUT_DIR (default ./out), E2E_MODE (label),
 * E2E_SKIP_ML=1 (skip RELATED), E2E_SKIP_VIDEO=1, E2E_STEP_TIMEOUT_S (default 240), E2E_PLATFORM,
 * E2E_LOCATION="lat,lon[,accuracyM]" (accuracy default 10 m): the photo stamp records location as the
 * app does with "Record location" on (the 0.01° cell in the public record, the exact fix in a private
 * record under a random 32-byte salt sent as the claim's `privateRecord`), and a "location" leg checks
 * the published record carries the cell only;
 * E2E_PHOTO=/path/to.jpg: stamp this JPEG instead of the generated fixture (same @stamper/minimise step;
 * contentHash is first-stamp-wins, so a given file stamps once per stack).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Deployment,
  parseDeployment,
  readStampByCode,
  stampRegistryAbi,
} from "@stamper/contracts-abi";
import {
  type CaptureClaim,
  claimDeadline,
  decodeRecord,
  encodeCode,
  FLAG,
  hashCaptureClaim,
  normaliseCode,
  pieceCidHex,
  pieceCidOf,
  predictCode,
  privateRecordHash,
  stamperDomain,
  verifyDeviceSignature,
} from "@stamper/core";
import { createPublicClient, type Hex, http, type PublicClient } from "viem";
import { Api, PollAbort, type Presentation, poll } from "./lib/api.js";
import {
  buildClaim,
  type CaptureLocation,
  captureBinding,
  captureLocation,
  type Device,
  enrolBinding,
  newDevice,
  parseLocation,
  possessionSig,
  sha256Hex,
  stubToken,
  wireClaim,
} from "./lib/device.js";
import { type Fixture, loadPhoto, makePhoto, makeVideo, reencode } from "./lib/media.js";
import { buildReport, type FlowResult, formatReport } from "./report.js";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`${k} is required`);
  return v;
};
const lower = (s: string) => s.toLowerCase();
const log = (m: string) => console.log(`[flow] ${m}`);

const OUT = resolve(process.env.E2E_OUT_DIR ?? join(import.meta.dirname, "out"));
const STEP_MS = Number(process.env.E2E_STEP_TIMEOUT_S ?? "240") * 1000;
const api = new Api(env("API_URL"));
const dep: Deployment = parseDeployment(JSON.parse(readFileSync(env("DEPLOYMENT_JSON"), "utf8")));
const pub = createPublicClient({ transport: http(env("RPC_URL")) }) as PublicClient;
const reg = { address: dep.registry, abi: stampRegistryAbi } as const;
const FIX = parseLocation(process.env.E2E_LOCATION);
const PHOTO = process.env.E2E_PHOTO || undefined;

const result: FlowResult = {
  mode: process.env.E2E_MODE ?? "local",
  chainId: dep.chainId,
  startedAt: new Date().toISOString(),
  marks: {},
  legs: {},
};

/** Run one leg and record it. True only when the leg ran and passed: a skipped leg produced nothing. */
async function leg(name: string, fn: () => Promise<string>, skip?: string): Promise<boolean> {
  if (skip) {
    result.legs[name] = { status: "skip", detail: skip };
    log(`skip ${name}: ${skip}`);
    return false;
  }
  const t0 = Date.now();
  try {
    const detail = await fn();
    result.legs[name] = { status: "pass", detail, ms: Date.now() - t0 };
    log(`ok   ${name}: ${detail}`);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    result.legs[name] = { status: "fail", detail: detail.slice(0, 600), ms: Date.now() - t0 };
    log(`FAIL ${name}: ${detail}`);
    return false;
  }
}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function enrol(dev: Device): Promise<number> {
  const ch = await api.json<{ challengeId: string; challenge: Hex }>(
    `/v1/attest/challenge?keyId=${dev.keyId}`,
  );
  const r = await api.post<{ level: number; txHash: Hex }>(
    `/v1/devices/${dev.platform}`,
    {
      addr: dev.addr,
      keyId: dev.keyId,
      platform: dev.platform,
      keyType: 0,
      popSig: await possessionSig(dev, dep.chainId, dep.registry),
      attestation: {
        kind: "stub",
        token: stubToken(dev.platform, enrolBinding(dev.addr, ch.challenge)),
        challengeId: ch.challengeId,
      },
      appInfo: { id: "media.stamper.app", version: "1.0.0", build: "1" },
    },
    [201],
  );
  // 201 means "registering": the registerKey tx is sent, not mined (instant on anvil, ~30 s blocks on Calibration)
  const rcpt = await pub.waitForTransactionReceipt({ hash: r.txHash, timeout: STEP_MS });
  must(rcpt.status === "success", `registerKey reverted: ${r.txHash}`);
  const key = await pub.readContract({ ...reg, functionName: "getKey", args: [dev.keyId] });
  must(lower(key.addr) === lower(dev.addr), "enrolled key addr on chain differs from the device");
  must(key.level === r.level, `key level on chain ${key.level} != api ${r.level}`);
  return r.level;
}

type Stamped = { captureId: string; stampId: Hex; predictedCode: string };

/** capture → upload in 3 chunks → signed claim (+ private record when location is on) → 202. */
async function stamp(
  dev: Device,
  fx: Fixture,
  mediaKind: 1 | 2,
  nonce: bigint,
  location?: CaptureLocation,
): Promise<Stamped> {
  const contentHash = sha256Hex(fx.bytes);
  let localCid: Hex | null = null;
  if (mediaKind === 1) {
    const a = pieceCidHex(await pieceCidOf(fx.bytes));
    const b = pieceCidHex(await pieceCidOf(fx.bytes, { impl: "fr32" }));
    must(a === b, `PieceCID implementations disagree: synapse ${a} fr32 ${b}`);
    localCid = a;
  }
  if (mediaKind === 1) result.marks.captureStart = Date.now();
  const cap = await api.post<{
    captureId: string;
    uploadId: string;
    challengeId: string;
    challenge: Hex;
  }>("/v1/captures", { keyId: dev.keyId, mediaKind, expectedSize: String(fx.bytes.length) }, [201]);
  const up = await api.upload(cap.uploadId, fx.bytes, 3);
  must(lower(up.sha256) === lower(contentHash), `upload sha256 ${up.sha256} != ${contentHash}`);
  if (localCid)
    must(lower(up.pieceCidHex) === lower(localCid), "server PieceCID differs from the device's");
  const built = await buildClaim({
    device: dev,
    chainId: dep.chainId,
    registry: dep.registry,
    bytes: fx.bytes,
    contentHash,
    // video: the device does not hash the piece; it takes the server-computed PieceCID and says so
    pieceCidHex: localCid ?? up.pieceCidHex,
    mediaKind,
    mediaType: fx.mime,
    dims: fx.dims,
    challenge: cap.challenge,
    nonce,
    capturedAt: BigInt(Date.now()),
    flags: localCid ? 0 : FLAG.PIECECID_SERVER_COMPUTED,
    sanitised: fx.sanitised,
    publicExif: fx.publicExif,
    ...(location ? { location } : {}),
  });
  const res = await api.post<{ stampId: Hex; predictedCode: string; status: string }>(
    `/v1/captures/${cap.captureId}/claim`,
    {
      claim: wireClaim(built.claim),
      sig: built.sig,
      record: Buffer.from(built.record).toString("base64"),
      attestation: {
        kind: "stub",
        token: stubToken(dev.platform, captureBinding(built.digest, cap.challenge)),
        challengeId: cap.challengeId,
      },
      ...(location
        ? { privateRecord: Buffer.from(location.privateRecord).toString("base64") }
        : {}),
    },
    [202],
  );
  if (mediaKind === 1) result.marks.accepted = Date.now();
  must(
    lower(res.stampId) === lower(built.digest),
    "stampId is not the EIP-712 digest of the claim",
  );
  return { captureId: cap.captureId, ...res };
}

/** Poll capture + presentation, recording receipt → marked → bound → probe-ok as each first appears. */
async function followPipeline(s: Stamped): Promise<Presentation> {
  const m = result.marks;
  let code: string | undefined;
  let pres: Presentation | undefined;
  await poll(
    "receipt, marked copy, two bindings and a passing retrieval probe",
    async () => {
      const st = await api.json<{ status: string; code?: string; shareReady: boolean }>(
        `/v1/captures/${s.captureId}`,
      );
      if (st.status === "rejected") throw new PollAbort("capture rejected before publication");
      if (st.code && !m.receipt) {
        m.receipt = Date.now();
        code = st.code;
        log(`receipt: ${code} (predicted ${s.predictedCode})`);
      }
      if (st.shareReady && !m.marked) {
        m.marked = Date.now();
        log("marked copy attached");
      }
      if (code) {
        pres = await api.json<Presentation>(`/v1/stamps/${code}`);
        const bound = pres.storageState === "bound" && pres.bindings.length >= 2;
        if (bound && !m.bound) {
          m.bound = Date.now();
          log(
            `bound: ${pres.bindings.map((b) => `slot ${b.slot} set ${b.dataSetId}/${b.pieceId}`).join(", ")}`,
          );
        }
        if (bound && pres.bindings.every((b) => b.lastOkAt && b.probeFailures === 0) && !m.probeOk)
          m.probeOk = Date.now();
      }
      return m.probeOk !== undefined && m.marked !== undefined;
    },
    (done) => done,
    STEP_MS * 2,
    300,
  );
  if (!pres) throw new Error("no presentation");
  return pres;
}

/** Chain only: stampByCode → getStamp → rebuild digest → device signature → predicted code → bindings. */
async function chainReverify(code9: string, stampId: Hex): Promise<string> {
  const n = normaliseCode(code9);
  must(n.ok, `code ${code9} does not normalise`);
  const byCode = await readStampByCode(pub, dep.registry, n.value);
  must(lower(byCode) === lower(stampId), `stampByCode → ${byCode}, expected ${stampId}`);
  const st = await pub.readContract({ ...reg, functionName: "getStamp", args: [stampId] });
  const claim: CaptureClaim = {
    contentHash: st.contentHash,
    pieceCid: st.pieceCid,
    contentLength: st.contentLength,
    mediaKind: st.mediaKind as 1 | 2,
    capturedAt: st.capturedAt,
    recordHash: st.recordHash,
    keyId: st.keyId,
    nonce: st.nonce,
    flags: st.flags,
    deadline: claimDeadline(st.capturedAt, (st.flags & FLAG.OFFLINE) !== 0),
  };
  const digest = hashCaptureClaim(stamperDomain(dep.chainId, dep.registry), claim);
  must(lower(digest) === lower(stampId), "digest rebuilt from chain state differs from stampId");
  const key = await pub.readContract({ ...reg, functionName: "getKey", args: [st.keyId] });
  const sigOk = verifyDeviceSignature(
    {
      keyType: key.keyType as 0 | 1 | 2 | 3,
      addr: key.addr,
      x: key.x,
      y: key.y,
      rpIdHash: key.rpIdHash,
    },
    digest,
    st.sig,
    st.authData,
    st.nonce,
  );
  must(sigOk, "device signature does not check out against the enrolled key");
  // predictCode is attempt 0; a collision on chain moves the code to a later attempt
  const pc = predictCode(stampId);
  must(
    encodeCode(pc.code) === code9 || BigInt(st.code) !== pc.code,
    "predictCode disagrees with the chain",
  );
  must(
    encodeCode(BigInt(st.code)) === code9,
    `getStamp.code ${encodeCode(BigInt(st.code))} != ${code9}`,
  );
  const bs = await pub.readContract({ ...reg, functionName: "getBindings", args: [stampId] });
  const live = bs.filter((b) => b.trusted && b.setId !== 0n);
  must(live.length >= 2, `expected 2 trusted bindings, got ${live.length}`);
  for (let slot = 0; slot < bs.length; slot++) {
    if ((bs[slot]?.setId ?? 0n) === 0n) continue;
    const s = await pub.readContract({
      ...reg,
      functionName: "bindingStatus",
      args: [stampId, slot],
    });
    must(
      s.dataSetLive && s.pieceLive && s.cidMatches && s.listenerIsFWSS,
      `bindingStatus slot ${slot} not healthy`,
    );
  }
  return `digest rebuilt, signature checks, code ${code9}, ${live.length} bindings cidMatches+listenerIsFWSS`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const seed = (Date.now() ^ process.pid) & 0x7fffffff;
  const dev = newDevice((process.env.E2E_PLATFORM as "ios" | "android" | undefined) ?? "android");
  log(`api ${api.base} chain ${dep.chainId} registry ${dep.registry} device ${dev.addr}`);

  let level = -1;
  await leg("enrol", async () => {
    level = await enrol(dev);
    return `key ${dev.keyId.slice(0, 10)}… level ${level}`;
  });

  const photo = PHOTO ? loadPhoto(PHOTO) : await makePhoto(seed);
  if (PHOTO)
    log(`photo ${PHOTO} (${photo.dims.w}×${photo.dims.h}, ${photo.bytes.length} B minimised)`);
  let loc: CaptureLocation | undefined;
  let s: Stamped | undefined;
  let pres: Presentation | undefined;
  await leg(
    "claim",
    async () => {
      loc = FIX ? captureLocation(FIX) : undefined;
      s = await stamp(dev, photo, 1, 1n, loc);
      const where = loc ? ` with location cell ${loc.cell.latE2},${loc.cell.lonE2}` : "";
      return `202 stampId ${s.stampId.slice(0, 12)}… predicted ${s.predictedCode}${where}`;
    },
    level < 0 ? "enrolment failed" : undefined,
  );
  // gate on the stamp itself: a skipped or failed claim leaves nothing to follow
  const claimed = s as Stamped | undefined;
  await leg(
    "pipeline",
    async () => {
      must(claimed, "no stamp to follow");
      pres = await followPipeline(claimed);
      result.code9 = pres.code9;
      result.stampId = pres.stampId;
      return `${pres.code9} ${pres.status}, ${pres.bindings.length} bindings, probe ok`;
    },
    claimed ? undefined : `claim ${result.legs.claim?.status === "skip" ? "skipped" : "failed"}`,
  );
  const p = pres as Presentation | undefined;
  const noPres = p ? undefined : "pipeline did not finish";

  if (FIX)
    await leg(
      "location",
      async () => {
        const l = loc as CaptureLocation;
        must(p?.record, "the presentation has no record");
        const rec = decodeRecord(new Uint8Array(Buffer.from(p.record, "base64")));
        const c = rec.location;
        must(
          c && c.latE2 === l.cell.latE2 && c.lonE2 === l.cell.lonE2 && c.source === l.cell.source,
          `published location ${JSON.stringify(c)} != cell ${JSON.stringify(l.cell)}`,
        );
        must(
          rec.privateHash === privateRecordHash(l.privateRecord),
          "published privateHash does not commit to the private record",
        );
        return `record carries cell ${l.cell.latE2},${l.cell.lonE2} (${l.cell.source}) and privateHash; exact fix (±${l.exact.accuracyM} m) went only in the private record`;
      },
      noPres,
    );

  await leg("chain-reverify", () => chainReverify(p?.code9 ?? "", p?.stampId as Hex), noPres);

  let original: Uint8Array | undefined;
  await leg(
    "ORIGINAL",
    async () => {
      const pp = p as Presentation;
      const st = await pub.readContract({ ...reg, functionName: "getStamp", args: [pp.stampId] });
      const prov = pp.originalSources.providers[0];
      const url = prov
        ? prov.includes("/piece/")
          ? prov
          : `${prov.replace(/\/$/, "")}/piece/${pp.pieceCid}`
        : api.url(`/v1/stamps/${pp.code9}/original`);
      original = (await api.bytes(url)).bytes;
      must(
        lower(sha256Hex(original)) === lower(st.contentHash),
        "served original re-hash differs from chain contentHash",
      );
      must(
        lower(pieceCidHex(await pieceCidOf(original))) === lower(st.pieceCid),
        "served original PieceCID differs from chain",
      );
      const j = await api.verifyUpload(original, "image/jpeg", "original.jpg", STEP_MS);
      must(j.result?.verdict === "ORIGINAL", `ladder says ${j.result?.verdict ?? j.error}`);
      return `re-hashed from ${new URL(url).host}; ladder ${j.result.verdict} (${j.result.path})`;
    },
    noPres,
  );

  await leg(
    "STAMPER_MARKED_COPY",
    async () => {
      const pp = p as Presentation;
      const share = (await api.bytes(api.url(`/v1/stamps/${pp.code9}/share.jpg`))).bytes;
      const j = await api.verifyUpload(share, "image/jpeg", "share.jpg", STEP_MS);
      must(
        j.result?.verdict === "STAMPER_MARKED_COPY",
        `ladder says ${j.result?.verdict ?? j.error}`,
      );
      must(
        lower(j.result.stampId ?? "") === lower(pp.stampId),
        "marked copy points at another stamp",
      );
      return `share.jpg → ${j.result.label}`;
    },
    noPres,
  );

  await leg(
    "RELATED",
    async () => {
      const pp = p as Presentation;
      const copy = await reencode(original ?? photo.bytes, 70);
      const j = await api.verifyUpload(copy, "image/jpeg", "reencoded.jpg", STEP_MS);
      must(j.result?.verdict === "RELATED_COMPARE", `ladder says ${j.result?.verdict ?? j.error}`);
      const ids = [j.result.stampId, ...(j.result.candidates ?? []).map((c) => c.stampId)];
      must(
        ids.some((id) => lower(id ?? "") === lower(pp.stampId)),
        `related to ${ids.join(",")}, not ${pp.stampId}`,
      );
      const d = j.result.candidates?.find((c) => lower(c.stampId) === lower(pp.stampId))?.distance;
      return `q70 re-encode → ${j.result.label} via ${j.result.path}${d !== undefined ? ` (PDQ distance ${d})` : ""}`;
    },
    process.env.E2E_SKIP_ML === "1" ? "E2E_SKIP_ML=1 (needs ml for PDQ)" : noPres,
  );

  await leg(
    "video-server-piececid",
    async () => {
      const v = await stamp(dev, makeVideo(seed), 2, 2n);
      const st = await poll(
        "video registration",
        () => api.json<{ status: string; code?: string }>(`/v1/captures/${v.captureId}`),
        (x) => !!x.code || x.status === "rejected",
        STEP_MS,
      );
      must(st.code, `video capture ${st.status}`);
      const onChain = await pub.readContract({
        ...reg,
        functionName: "getStamp",
        args: [v.stampId],
      });
      must(
        (onChain.flags & FLAG.PIECECID_SERVER_COMPUTED) !== 0,
        "PIECECID_SERVER_COMPUTED not set on chain",
      );
      const vp = await api.json<Presentation>(`/v1/stamps/${st.code}`);
      must(
        vp.flags.includes("PIECECID_SERVER_COMPUTED"),
        `presentation flags ${vp.flags.join(",")}`,
      );
      result.legs.video = { status: "pass", detail: st.code };
      return `${st.code} registered with PIECECID_SERVER_COMPUTED`;
    },
    process.env.E2E_SKIP_VIDEO === "1"
      ? "E2E_SKIP_VIDEO=1"
      : level < 0
        ? "enrolment failed"
        : undefined,
  );
  if (result.legs.video) {
    const code = result.legs.video.detail;
    delete result.legs.video;
    writeFileSync(join(OUT, "video.env"), `VIDEO_CODE=${code}\n`);
  }

  result.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, "flow.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (p) {
    writeFileSync(
      join(OUT, "flow.env"),
      [
        `STAMP_CODE=${p.code9}`,
        `STAMP_ID=${p.stampId}`,
        `STAMP_CONTENT_HASH=${p.contentHash}`,
        `STAMP_PIECE_CID=${p.pieceCid}`,
        `STAMP_PIECE_CID_HEX=${p.pieceCidHex}`,
        `STAMP_PROVIDER_URL=${(p.originalSources.providers[0] ?? "").replace(/\/piece\/.*$/, "")}`,
        "",
      ].join("\n"),
    );
  }
  const r = buildReport(result);
  console.log(formatReport(r));
  process.exitCode = r.ok ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
