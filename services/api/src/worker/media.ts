import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { ffmpegPath, ffprobePath, MAX_INPUT_PIXELS } from "@stamper/marking";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Hex } from "viem";
import { captures, type Db, uploads } from "../db/index.js";
import { hexToBytea } from "../shared/index.js";
import type { VideoProbe } from "./deps.js";

const run = promisify(execFile);

/** A content problem that will not go away on retry (reject / fail the job, never retry). */
export class MediaError extends Error {
  override name = "MediaError";
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** The staged original: `uploads.path` of the complete upload joined via `captures.stamp_id`. */
export async function stagedOriginalPath(db: Db, stampId: Hex): Promise<string> {
  const [u] = await db
    .select({ path: uploads.path })
    .from(uploads)
    .innerJoin(captures, eq(captures.id, uploads.captureId))
    .where(and(eq(captures.stampId, hexToBytea(stampId)), eq(uploads.status, "complete")))
    .limit(1);
  if (!u) throw new Error(`staged original not found for ${stampId}`);
  return u.path;
}

export function sha256Hex(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function sha256File(path: string): Promise<Hex> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return `0x${h.digest("hex")}`;
}

/** Write via a temp file + rename so readers never see a partial file. */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export type ImageFacts = {
  width: number;
  height: number;
  format: string;
  orientation: number | null;
};

/**
 * Decode an image once, fully (truncation or corrupt entropy data throws), and return the
 * EXIF-oriented dimensions. Throws MediaError('undecodable').
 */
export async function decodeImage(bytes: Uint8Array): Promise<ImageFacts> {
  try {
    const img = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
    const m = await img.metadata();
    await img.stats(); // forces a full decode
    if (!m.width || !m.height || !m.format) throw new Error("no dimensions");
    const swap = (m.orientation ?? 1) >= 5;
    return {
      width: swap ? m.height : m.width,
      height: swap ? m.width : m.height,
      format: m.format,
      orientation: m.orientation ?? null,
    };
  } catch (e) {
    throw new MediaError("undecodable", `image does not decode: ${(e as Error).message}`);
  }
}

type FfprobeJson = {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  format?: { duration?: string };
};

/** ffprobe (JSON) → duration, dimensions, codecs. Throws MediaError('undecodable'). */
export async function ffprobe(path: string, bin = ffprobePath(ffmpegPath())): Promise<VideoProbe> {
  let j: FfprobeJson;
  try {
    const { stdout } = await run(
      bin,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
    );
    j = JSON.parse(stdout) as FfprobeJson;
  } catch (e) {
    throw new MediaError("undecodable", `ffprobe failed: ${(e as Error).message.slice(0, 200)}`);
  }
  const v = j.streams?.find((s) => s.codec_type === "video");
  const dur = Number(j.format?.duration);
  if (!v?.width || !v.height || !Number.isFinite(dur))
    throw new MediaError("undecodable", "no video stream or duration");
  return {
    durationMs: Math.round(dur * 1000),
    width: v.width,
    height: v.height,
    videoCodec: v.codec_name ?? null,
    audioCodecs: (j.streams ?? [])
      .filter((s) => s.codec_type === "audio")
      .map((s) => s.codec_name ?? "unknown"),
  };
}

/** First frame of a video as JPEG bytes. */
export async function videoFrame(path: string, bin = ffmpegPath()): Promise<Uint8Array> {
  const { stdout } = await run(
    bin,
    ["-v", "error", "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  if (stdout.byteLength === 0) throw new MediaError("undecodable", "no video frame");
  return new Uint8Array(stdout);
}
