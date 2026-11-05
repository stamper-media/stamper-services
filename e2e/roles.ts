/**
 * Role pre-flight for run-calibration.sh (plan §WP-12): is the registrar key an active registrar and the
 * relayer key an active binder on the registry? StampRegistry activates every announced role ROLE_DELAY
 * (48 h) after the announcement. Before that, enrolment reverts NotRegistrar and the relayer's bindings
 * land untrusted, so the flow cannot pass.
 *
 * CLI env: RPC_URL, DEPLOYMENT_JSON, REGISTRAR_PK, RELAYER_PK (keys come from the environment only and are
 * never printed); E2E_ROLE_WAIT_S (default 0) waits up to that many seconds for announced roles to activate.
 * Exit 0: both roles active. Exit 3: announced, not active yet; stdout carries the activation time (ISO 8601).
 * Exit 1: a role was never announced (or was removed), or the check failed. Status lines go to stderr.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDeployment, stampRegistryAbi } from "@stamper/contracts-abi";
import { type Address, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Role = "registrar" | "binder";
export type RoleCheck = {
  role: Role;
  /** Name of the env var holding the key that needs the role (never its value). */
  key: string;
  addr: Address;
  /** isActiveRegistrar / isActiveBinder at the latest block. */
  active: boolean;
  /** registrarActiveFrom / binderActiveFrom in unix seconds; 0 = never announced, or removed. */
  activeFrom: bigint;
};
export type RoleState = "active" | "pending" | "missing";

export function roleState(c: RoleCheck): RoleState {
  if (c.active) return "active";
  return c.activeFrom === 0n ? "missing" : "pending";
}

/** When the last pending role activates (unix seconds); undefined when none is pending. */
export function activationTime(checks: readonly RoleCheck[]): bigint | undefined {
  let at: bigint | undefined;
  for (const c of checks)
    if (roleState(c) === "pending" && (at === undefined || c.activeFrom > at)) at = c.activeFrom;
  return at;
}

export const isoOf = (unixS: bigint): string =>
  new Date(Number(unixS) * 1000).toISOString().replace(".000Z", "Z");

/** "in 47 h 12 min", "in 3 min" or "due now". */
export function untilText(seconds: number): string {
  if (seconds <= 0) return "due now";
  const m = Math.ceil(seconds / 60);
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

export function describeRole(c: RoleCheck, chainNowS: bigint): string {
  const who = `${c.role.padEnd(9)} ${c.addr} (${c.key})`;
  switch (roleState(c)) {
    case "active":
      return `${who}: active since ${isoOf(c.activeFrom)}`;
    case "pending":
      return `${who}: announced, active from ${isoOf(c.activeFrom)} (${untilText(Number(c.activeFrom - chainNowS))})`;
    case "missing":
      return `${who}: holds no ${c.role} role (never announced, or removed)`;
  }
}

/** Address of a hex private key (with or without 0x). Errors name the variable, never the value. */
export function addressOfKey(name: string, value: string | undefined): Address {
  const v = (value ?? "").trim();
  const hex = `0x${/^0x/i.test(v) ? v.slice(2) : v}` as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte hex private key`);
  try {
    return privateKeyToAccount(hex).address;
  } catch {
    throw new Error(`${name} is not a valid secp256k1 private key`);
  }
}

/** Read both roles from the registry at the latest block. */
export async function readRoles(
  pub: PublicClient,
  registry: Address,
  who: { registrar: Address; binder: Address },
  keys: { registrar: string; binder: string } = { registrar: "REGISTRAR_PK", binder: "RELAYER_PK" },
): Promise<RoleCheck[]> {
  const c = { address: registry, abi: stampRegistryAbi } as const;
  const [ra, rf, ba, bf] = await Promise.all([
    pub.readContract({ ...c, functionName: "isActiveRegistrar", args: [who.registrar] }),
    pub.readContract({ ...c, functionName: "registrarActiveFrom", args: [who.registrar] }),
    pub.readContract({ ...c, functionName: "isActiveBinder", args: [who.binder] }),
    pub.readContract({ ...c, functionName: "binderActiveFrom", args: [who.binder] }),
  ]);
  return [
    {
      role: "registrar",
      key: keys.registrar,
      addr: who.registrar,
      active: ra,
      activeFrom: BigInt(rf),
    },
    { role: "binder", key: keys.binder, addr: who.binder, active: ba, activeFrom: BigInt(bf) },
  ];
}

const say = (m: string) => console.error(`[roles] ${m}`);

async function cli(): Promise<number> {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const waitS = Number(process.env.E2E_ROLE_WAIT_S ?? "0");
  if (!Number.isFinite(waitS) || waitS < 0) throw new Error("E2E_ROLE_WAIT_S must be seconds >= 0");
  const dep = parseDeployment(JSON.parse(readFileSync(need("DEPLOYMENT_JSON"), "utf8")));
  const pub = createPublicClient({ transport: http(need("RPC_URL")) }) as PublicClient;
  const who = {
    registrar: addressOfKey("REGISTRAR_PK", process.env.REGISTRAR_PK),
    binder: addressOfKey("RELAYER_PK", process.env.RELAYER_PK),
  };
  const deadline = Date.now() + waitS * 1000;
  for (let first = true; ; first = false) {
    const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
    const checks = await readRoles(pub, dep.registry, who);
    const at = activationTime(checks);
    if (first || at === undefined) for (const c of checks) say(describeRole(c, now));
    if (checks.some((c) => roleState(c) === "missing")) {
      say(
        `registry ${dep.registry}: the governor must announce the missing role (contracts/script/Roles.s.sol); it activates 48 h later`,
      );
      return 1;
    }
    if (at === undefined) return 0;
    const leftS = Number(at - now);
    if (Date.now() + leftS * 1000 > deadline) {
      console.log(isoOf(at));
      return 3;
    }
    if (first)
      say(`waiting for activation at ${isoOf(at)} (${untilText(leftS)}; E2E_ROLE_WAIT_S=${waitS})`);
    // sleep until a minute before activation (at most an hour per nap), then poll every 15 s
    await new Promise((r) =>
      setTimeout(r, leftS > 120 ? Math.min(leftS - 60, 3600) * 1000 : 15_000),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cli().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      // viem's shortMessage leaves out the request details (an RPC URL can carry an API key)
      const m =
        e instanceof Error
          ? ((e as { shortMessage?: string }).shortMessage ?? e.message)
          : String(e);
      say(`error: ${m}`);
      process.exitCode = 1;
    },
  );
}
