import type { AppContext } from "../shared/context.js";

/**
 * ROLE=api entry. Everything that touches keys is loaded through a dynamic import so that
 * main.ts (which imports this module in both roles) never loads a secret-bearing module in
 * ROLE=worker.
 */
export async function start(ctx: AppContext): Promise<void> {
  if (ctx.cfg.role !== "api") throw new Error("api start() called in ROLE=worker");
  const { startCustodian } = await import("./custodian.js");
  await startCustodian(ctx);
}
