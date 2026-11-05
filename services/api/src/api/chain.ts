import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  createPublicClient,
  createWalletClient,
  fallback,
  type Hex,
  http,
  type PublicClient,
  type TransactionReceipt,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, filecoin, filecoinCalibration } from "viem/chains";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { chainTxs } from "../db/repo/index.js";
import type { Logger } from "../shared/logger.js";
import type { TxLatency, TxSettle } from "../shared/metrics.js";

export function viemChain(id: AppConfig["chain"]["id"]): Chain {
  return id === 314 ? filecoin : id === 314159 ? filecoinCalibration : anvil;
}

export function createChainClient(cfg: AppConfig): PublicClient {
  const transport = fallback(cfg.chain.rpcUrls.map((u) => http(u, { timeout: 20_000 })));
  return createPublicClient({
    chain: viemChain(cfg.chain.id),
    transport,
    pollingInterval: cfg.chain.id === 31337 ? 100 : 4_000,
  }) as PublicClient;
}

/** A transaction that would revert (preflight estimateGas) or did revert on chain. */
export class TxRevertedError extends Error {
  override name = "TxRevertedError";
  constructor(
    readonly reason: string,
    readonly hash?: Hex,
  ) {
    super(`transaction reverted: ${reason}`);
  }
}

/** Best-effort require-string extraction from a viem error ("NonceUsed", "Dup", …). */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const inner = e.walk((x) => typeof (x as { reason?: unknown }).reason === "string") as {
      reason?: string;
    } | null;
    if (inner?.reason) return inner.reason;
    const m = /reverted with reason string '([^']+)'|reverted: ([A-Za-z0-9_ ]+)/.exec(e.message);
    if (m) return (m[1] ?? m[2] ?? "").trim();
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export type SendResult = { hash: Hex; nonce: number; wait(): Promise<TransactionReceipt> };

export type RelayerOpts = {
  pk: Hex;
  cfg: AppConfig;
  pub: PublicClient;
  db: Db;
  log: Logger;
  /** fee multiplier for the gas limit (default 1.25). */
  gasBufferPct?: number;
  /** broadcast → settled latency tracker (`stamper_tx_latency_seconds_max`). */
  latency?: TxLatency;
};

/**
 * One sender lane per key. Submissions are serialised (one nonce counter, no gaps); receipts are
 * awaited concurrently. Every submitted tx is recorded in chain_txs (the outbox ledger). A call that
 * would revert is caught by estimateGas before anything is broadcast.
 */
export class Relayer {
  readonly account: Account;
  private readonly wallet;
  private tail: Promise<unknown> = Promise.resolve();
  private nextNonce: number | null = null;

  constructor(private readonly o: RelayerOpts) {
    this.account = privateKeyToAccount(o.pk);
    this.wallet = createWalletClient({
      account: this.account,
      chain: viemChain(o.cfg.chain.id),
      transport: fallback(o.cfg.chain.rpcUrls.map((u) => http(u, { timeout: 20_000 }))),
    });
  }

  get address(): Address {
    return this.account.address;
  }

  balance(): Promise<bigint> {
    return this.o.pub.getBalance({ address: this.address });
  }

  /** Serialised submit; resolves once the tx is broadcast and recorded. */
  send(kind: string, tx: { to: Address; data: Hex; stampId?: Hex }): Promise<SendResult> {
    const run = this.tail.then(() => this.submit(kind, tx));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async sendAndWait(
    kind: string,
    tx: { to: Address; data: Hex; stampId?: Hex },
  ): Promise<TransactionReceipt> {
    const s = await this.send(kind, tx);
    return s.wait();
  }

  private async fees(bump = 100n) {
    const f = await this.o.pub.estimateFeesPerGas();
    return {
      maxFeePerGas: ((f.maxFeePerGas ?? 0n) * bump) / 100n,
      maxPriorityFeePerGas: ((f.maxPriorityFeePerGas ?? 0n) * bump) / 100n,
    };
  }

  private async submit(
    kind: string,
    tx: { to: Address; data: Hex; stampId?: Hex },
    replace?: { nonce: number; bump: bigint; gas: bigint; settle?: TxSettle },
  ): Promise<SendResult> {
    let gas = replace?.gas;
    if (gas === undefined) {
      try {
        const est = await this.o.pub.estimateGas({
          account: this.account,
          to: tx.to,
          data: tx.data,
        });
        gas = (est * BigInt(this.o.gasBufferPct ?? 125)) / 100n;
      } catch (e) {
        throw new TxRevertedError(revertReason(e));
      }
    }
    const fees = await this.fees(replace?.bump ?? 100n);
    for (let attempt = 0; ; attempt++) {
      const nonce =
        replace?.nonce ??
        this.nextNonce ??
        (await this.o.pub.getTransactionCount({ address: this.address, blockTag: "pending" }));
      try {
        const hash = await this.wallet.sendTransaction({
          account: this.account,
          chain: viemChain(this.o.cfg.chain.id),
          to: tx.to,
          data: tx.data,
          nonce,
          gas,
          ...fees,
        });
        if (!replace) this.nextNonce = nonce + 1;
        await chainTxs.outboxInsert(this.o.db, {
          hash,
          kind,
          stampId: tx.stampId ?? null,
          sender: this.address,
          nonce: BigInt(nonce),
        });
        this.o.log.info({ kind, hash, nonce, stampId: tx.stampId }, "tx submitted");
        const g = gas;
        // a replacement keeps the first broadcast's clock
        const settle = replace?.settle ?? this.o.latency?.begin(kind);
        return {
          hash,
          nonce,
          wait: () => this.wait(kind, tx, hash, nonce, g, replace?.bump, settle),
        };
      } catch (e) {
        this.nextNonce = null;
        if (!replace && attempt === 0 && /nonce/i.test(String((e as Error).message))) continue;
        throw e;
      }
    }
  }

  private async wait(
    kind: string,
    tx: { to: Address; data: Hex; stampId?: Hex },
    hash: Hex,
    nonce: number,
    gas: bigint,
    bump?: bigint,
    settle?: TxSettle,
  ): Promise<TransactionReceipt> {
    let handedOff = false;
    try {
      return await this.waitOnce(kind, tx, hash, nonce, gas, bump, settle, () => {
        handedOff = true;
      });
    } finally {
      // included, reverted, dropped or abandoned: stop the clock (a replacement settles itself)
      if (!handedOff) settle?.();
    }
  }

  private async waitOnce(
    kind: string,
    tx: { to: Address; data: Hex; stampId?: Hex },
    hash: Hex,
    nonce: number,
    gas: bigint,
    bump: bigint | undefined,
    settle: TxSettle | undefined,
    handOff: () => void,
  ): Promise<TransactionReceipt> {
    const { reorgDepth, receiptTimeoutMs } = this.o.cfg.chain;
    let receipt: TransactionReceipt;
    try {
      receipt = await this.o.pub.waitForTransactionReceipt({
        hash,
        confirmations: reorgDepth + 1,
        timeout: receiptTimeoutMs,
      });
    } catch (e) {
      if (!(e instanceof WaitForTransactionReceiptTimeoutError)) throw e;
      if (bump !== undefined) {
        await chainTxs.outboxUpdate(this.o.db, hash, { status: "dropped", error: "timeout" });
        throw new Error(`tx ${hash} not included after replacement`);
      }
      // same nonce, fees +25 % (replacement needs ≥ 10 %); serialised through the lane
      this.o.log.warn({ kind, hash, nonce }, "receipt timeout; replacing with higher fees");
      await chainTxs.outboxUpdate(this.o.db, hash, { status: "replaced", error: "timeout" });
      const run = this.tail.then(() => this.submit(kind, tx, { nonce, bump: 125n, gas, settle }));
      this.tail = run.catch(() => undefined);
      const replacement = await run;
      handOff();
      return replacement.wait();
    }
    if (reorgDepth > 0) {
      // re-read after REORG_DEPTH blocks: the receipt must still be in the same block
      const again = await this.o.pub.getTransactionReceipt({ hash });
      if (again.blockHash !== receipt.blockHash) throw new Error(`tx ${hash} reorged; retry`);
    }
    if (receipt.status !== "success") {
      await chainTxs.outboxUpdate(this.o.db, hash, {
        status: "failed",
        includedEpoch: receipt.blockNumber,
        error: "reverted",
      });
      throw new TxRevertedError("reverted", hash);
    }
    await chainTxs.outboxUpdate(this.o.db, hash, {
      status: "included",
      includedEpoch: receipt.blockNumber,
    });
    return receipt;
  }
}
