/**
 * Deterministic fixtures: a textured JPEG with EXIF Orientation, a 2 s H.264 clip, a q70 re-encode;
 * or a given JPEG (E2E_PHOTO) through the same minimiser.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectJpeg, minimiseJpeg, minimiseMp4, sniff } from "@stamper/minimise";
import sharp from "sharp";

export type Fixture = {
  bytes: Uint8Array;
  mime: string;
  dims: { w: number; h: number; durationMs?: number; fps?: number };
  sanitised: { removed: string[]; kept: string[] };
  publicExif: Record<string, string | number>;
};

/** Seeded xorshift so every run stamps a different photo (contentHash is first-stamp-wins). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

export async function makePhoto(seed: number, w = 960, h = 720): Promise<Fixture> {
  const r = rng(seed);
  const px = new Uint8Array(w * h * 3);
  const blobs = Array.from({ length: 24 }, () => ({
    x: r() * w,
    y: r() * h,
    rad: 30 + r() * 140,
    c: [r() * 255, r() * 255, r() * 255],
  }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [
        128 + 90 * Math.sin(x / 37 + seed),
        128 + 90 * Math.sin(y / 23),
        128 + 90 * Math.sin((x + y) / 51),
      ];
      for (const b of blobs) {
        if ((x - b.x) ** 2 + (y - b.y) ** 2 < b.rad ** 2) c = b.c;
      }
      const o = (y * w + x) * 3;
      px[o] = c[0] as number;
      px[o + 1] = c[1] as number;
      px[o + 2] = c[2] as number;
    }
  }
  const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .withExif({ IFD0: { Make: "StamperE2E", Model: "Simulated", Orientation: "1" } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const m = minimiseJpeg(new Uint8Array(jpeg));
  return {
    bytes: m.bytes,
    mime: "image/jpeg",
    dims: { w: m.report.width ?? w, h: m.report.height ?? h },
    sanitised: { removed: m.report.removed, kept: m.report.kept },
    publicExif: m.report.publicExif as Record<string, string | number>,
  };
}

/**
 * A JPEG from disk (E2E_PHOTO), minimised exactly like the fixture and the app's prepareJpeg. Its
 * contentHash is first-stamp-wins: a file can be stamped once per stack.
 */
export function loadPhoto(path: string): Fixture {
  const raw = new Uint8Array(readFileSync(path));
  const kind = sniff(raw);
  if (kind !== "image/jpeg") throw new Error(`E2E_PHOTO ${path} is ${kind}, not a JPEG`);
  const m = minimiseJpeg(raw);
  const dims =
    m.report.width && m.report.height
      ? { w: m.report.width, h: m.report.height }
      : inspectJpeg(m.bytes).dims;
  if (!dims) throw new Error(`E2E_PHOTO ${path}: no image dimensions`);
  // the record takes strings and integers only (as the app keeps them)
  const publicExif: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.report.publicExif)) {
    if (typeof v === "string" || (typeof v === "number" && Number.isInteger(v))) publicExif[k] = v;
  }
  return {
    bytes: m.bytes,
    mime: "image/jpeg",
    dims,
    sanitised: { removed: m.report.removed, kept: m.report.kept },
    publicExif,
  };
}

/** 2 s 640×360 H.264 clip (no audio, no metadata) passed through the MP4 minimiser. */
export function makeVideo(seed: number, ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "stamper-wp12-video-"));
  try {
    const out = join(dir, "clip.mp4");
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=640x360:rate=30:duration=2,hue=h=${seed % 360}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        "-y",
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const m = minimiseMp4(new Uint8Array(readFileSync(out)));
    return {
      bytes: m.bytes,
      mime: "video/mp4",
      dims: { w: 640, h: 360, durationMs: 2000, fps: 30 },
      sanitised: { removed: m.report.removed, kept: m.report.kept },
      publicExif: {},
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A JPEG re-encode at quality 70 (the RELATED leg). */
export async function reencode(bytes: Uint8Array, quality = 70): Promise<Uint8Array> {
  return new Uint8Array(await sharp(bytes).jpeg({ quality }).toBuffer());
}
