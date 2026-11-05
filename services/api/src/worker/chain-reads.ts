import { stampRegistryAbi } from "@stamper/contracts-abi";
import { createPublicClient, fallback, type Hex, http, type PublicClient } from "viem";
import type { AppConfig } from "../config.js";
import type { ChainReads } from "./deps.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

/** Read-only viem client over the registry (no wallet, no keys). */
export function createChainReads(cfg: AppConfig, client?: PublicClient): ChainReads {
  const pub =
    client ??
    createPublicClient({
      transport: fallback(cfg.chain.rpcUrls.map((u) => http(u, { timeout: 15_000 }))),
    });
  const base = { address: cfg.chain.registry, abi: stampRegistryAbi } as const;
  return {
    firstStampOf: (sha256) =>
      pub.readContract({ ...base, functionName: "firstStampOf", args: [sha256] }),
    stampByDerivativeHash: (sha256) =>
      pub.readContract({ ...base, functionName: "stampByDerivativeHash", args: [sha256] }),
    stampByCode: (code) =>
      pub.readContract({ ...base, functionName: "stampByCode", args: [Number(code)] }),
    async getStamp(stampId) {
      const s = await pub.readContract({ ...base, functionName: "getStamp", args: [stampId] });
      if (!s || s.contentHash === ZERO32) return null;
      return { contentHash: s.contentHash, pieceCid: s.pieceCid, code: BigInt(s.code) };
    },
    blockNumber: () => pub.getBlockNumber(),
  };
}
