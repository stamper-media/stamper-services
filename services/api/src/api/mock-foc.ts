import { mockPdpVerifierAbi } from "@stamper/contracts-abi";
import { createMockFoc, type MockFoc } from "@stamper/foc/mock";
import { encodeFunctionData, parseEventLogs } from "viem";
import type { AppConfig } from "../config.js";
import type { Relayer } from "./chain.js";

/**
 * FOC_MODE=mock (plan §4.3): MockFoc stores pieces under MOCK_SP_DIR and serves them on
 * MOCK_SP_PORT; each commit calls MockPDPVerifier.addPiece(setId, cid) with the relayer wallet and
 * returns the pieceId from the PieceAdded event.
 */
export function startMockFoc(cfg: AppConfig, relayer: Relayer): Promise<MockFoc> {
  const sp = cfg.foc.mockSp;
  if (!sp) throw new Error("FOC_MODE=mock without MOCK_SP settings");
  return createMockFoc({
    dir: sp.dir,
    port: sp.port,
    onCommit: async (ds, cid) => {
      const setId = cfg.foc.dataSets[ds].id;
      const r = await relayer.sendAndWait("mock-addPiece", {
        to: cfg.chain.pdpVerifier,
        data: encodeFunctionData({
          abi: mockPdpVerifierAbi,
          functionName: "addPiece",
          args: [setId, `0x${Buffer.from(cid).toString("hex")}`],
        }),
      });
      const [ev] = parseEventLogs({
        abi: mockPdpVerifierAbi,
        eventName: "PieceAdded",
        logs: r.logs,
      });
      if (!ev) throw new Error("PieceAdded event missing");
      return { txHash: r.transactionHash, pieceId: ev.args.pieceId, dataSetId: setId };
    },
  });
}
