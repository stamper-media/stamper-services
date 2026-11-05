import type { FocReader } from "@stamper/foc";
import type { PdqClient, WatermarkClient } from "@stamper/marking";
import type { Hex } from "viem";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Queue } from "../queue/port.js";
import type { Logger } from "../shared/logger.js";
import type { Mirror } from "./mirror.js";

/** The FOC surface the worker uses: storage-provider uploads and read-only health (no keys). */
export type FocStore = Pick<FocReader, "storeOriginal" | "retrievalUrls" | "dataSetHealth">;

/** Read-only registry lookups (verify ladder) plus the chain head (pdp-monitor). */
export type ChainReads = {
  firstStampOf(sha256: Hex): Promise<Hex>;
  stampByDerivativeHash(sha256: Hex): Promise<Hex>;
  stampByCode(code: bigint): Promise<Hex>;
  getStamp(stampId: Hex): Promise<{ contentHash: Hex; pieceCid: Hex; code: bigint } | null>;
  blockNumber(): Promise<bigint>;
};

export type Notice = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
};
export type Notifier = (n: Notice) => Promise<void>;

export type VideoProbe = {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodecs: string[];
};

/** Everything a worker job needs; built from config in index.ts, faked in tests. */
export type WorkerDeps = {
  cfg: AppConfig;
  db: Db;
  queue: Queue;
  log: Logger;
  /** null under FOC_MODE=mock when the mock SP lives in the api process (the api stores itself). */
  foc: FocStore | null;
  /** null when MIRROR_S3_* is unset (dev only; logged). */
  mirror: Mirror | null;
  watermark: WatermarkClient;
  /** false when ML_URL is unset: the derivative carries the badge only. */
  watermarkEnabled: boolean;
  /** null when ML_URL is unset: no PDQ rows are written and the perceptual step is skipped. */
  pdq: PdqClient | null;
  chain: ChainReads;
  notify: Notifier;
  probeVideo(path: string): Promise<VideoProbe>;
  /** First video frame as JPEG bytes (previews and share-card thumbnail for videos). */
  videoFrame(path: string): Promise<Uint8Array>;
  fetch: typeof fetch;
  now(): Date;
};

export const ACTOR = "worker";
