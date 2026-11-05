import type { FocCustodian } from "@stamper/foc";
import type { Address, PublicClient, TypedDataDomain } from "viem";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Queue } from "../queue/port.js";
import type { AppContext } from "../shared/context.js";
import type { Logger } from "../shared/logger.js";
import type { DeviceAttestation } from "./attest/index.js";
import type { UploadManager } from "./captures/upload.js";
import type { Relayer } from "./chain.js";
import type { Registrar } from "./registrar.js";

/** Everything the custodian's routes and job handlers share. Built once in custodian.ts. */
export type Services = {
  ctx: AppContext;
  cfg: AppConfig;
  db: Db;
  queue: Queue;
  log: Logger;
  domain: TypedDataDomain & { chainId: number; verifyingContract: Address };
  pub: PublicClient;
  relayer: Relayer;
  resolverOwner: Relayer | null;
  registrar: Registrar;
  attest: DeviceAttestation;
  foc: FocCustodian;
  uploads: UploadManager;
  now: () => number;
  /** finality loop spacing (30 s in production). */
  finalityIntervalMs: number;
};
