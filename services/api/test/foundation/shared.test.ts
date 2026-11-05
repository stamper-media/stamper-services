import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  byteaToHex,
  CODE_LOOKUP_RATE,
  cachePath,
  hexToBytea,
  pdqBitsToHex,
  pdqHexToBits,
  readRange,
  STATUS,
  sha256Stream,
  stagingPath,
  VERIFY_UPLOAD_RATE,
} from "../../src/shared/index.js";

const cfg = { paths: { staging: "/s", cache: "/c" } };

describe("shared", () => {
  it("constants follow DESIGN §9.3 / §11.2", () => {
    expect(STATUS).toEqual([
      "received",
      "registering",
      "registered",
      "rejected",
      "marked",
      "stored",
      "withdrawn",
      "takedown",
    ]);
    expect([CODE_LOOKUP_RATE, VERIFY_UPLOAD_RATE]).toEqual([60, 10]);
  });

  it("hex <-> bytea and PDQ bits round-trip", () => {
    expect(byteaToHex(hexToBytea("0x00ff10"))).toBe("0x00ff10");
    expect(() => hexToBytea("0xabc" as `0x${string}`)).toThrow();
    const h = `0x80${"00".repeat(30)}01` as const;
    const bits = pdqHexToBits(h);
    expect(bits).toHaveLength(256);
    expect(bits.startsWith("10000000")).toBe(true);
    expect(pdqBitsToHex(bits)).toBe(h);
  });

  it("paths reject traversal", () => {
    expect(stagingPath(cfg, "6F9619FF-8B86-D011-B42D-00C04FC964FF")).toBe(
      "/s/6f9619ff-8b86-d011-b42d-00c04fc964ff",
    );
    expect(() => stagingPath(cfg, "../etc/passwd")).toThrow();
    const id = `0x${"ab".repeat(32)}` as const;
    expect(cachePath(cfg, id, "share.jpg")).toBe(`/c/ab/${"ab".repeat(32)}/share.jpg`);
    expect(() => cachePath(cfg, id, "../x")).toThrow();
    expect(() => cachePath(cfg, "0x12", "share.jpg")).toThrow();
  });

  it("sha256Stream hashes pass-through bytes; readRange is inclusive", async () => {
    const tee = sha256Stream();
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.from("ab"), Buffer.from("c")]),
      tee.stream,
      new Writable({
        write(c: Buffer, _e, cb) {
          chunks.push(c);
          cb();
        },
      }),
    );
    expect(tee.digest()).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(tee.bytes()).toBe(3);
    const p = join(mkdtempSync(join(tmpdir(), "stamper-wp06-")), "f");
    writeFileSync(p, "0123456789");
    const r = await readRange(p, 2, 4);
    let s = "";
    for await (const c of r.stream) s += String(c);
    expect(s).toBe("234");
    await expect(readRange(p, 5, 10)).rejects.toThrow(RangeError);
  });
});
