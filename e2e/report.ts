/**
 * Timings report: capture→202, 202→receipt, receipt→marked, marked→bound, bound→probe-ok.
 * `tsx report.ts [flow.json]` prints it and writes out/report.json next to the flow file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type LegStatus = "pass" | "fail" | "skip";
export type Leg = { status: LegStatus; detail: string; ms?: number };
/** Wall-clock marks (ms since epoch) recorded by flow.ts for the photo stamp. */
export type Marks = Partial<
  Record<"captureStart" | "accepted" | "receipt" | "marked" | "bound" | "probeOk", number>
>;
export type FlowResult = {
  mode: string;
  chainId: number;
  startedAt: string;
  finishedAt?: string;
  code9?: string;
  stampId?: string;
  marks: Marks;
  legs: Record<string, Leg>;
};

export const TIMING_LEGS = [
  ["capture→202", "captureStart", "accepted"],
  ["202→receipt", "accepted", "receipt"],
  ["receipt→marked", "receipt", "marked"],
  ["marked→bound", "marked", "bound"],
  ["bound→probe-ok", "bound", "probeOk"],
] as const;

export type Report = {
  mode: string;
  chainId: number;
  code9?: string;
  timingsMs: Record<string, number | null>;
  legs: Record<string, Leg>;
  timingsGreen: boolean;
  ok: boolean;
};

export function buildReport(f: FlowResult): Report {
  const timingsMs: Record<string, number | null> = {};
  for (const [name, a, b] of TIMING_LEGS) {
    const x = f.marks[a];
    const y = f.marks[b];
    // receipt and shareReady can land in the same poll tick: clamp to 0, never negative
    timingsMs[name] = x !== undefined && y !== undefined ? Math.max(0, y - x) : null;
  }
  const timingsGreen = Object.values(timingsMs).every((v) => v !== null);
  const legsOk = Object.values(f.legs).every((l) => l.status !== "fail");
  return {
    mode: f.mode,
    chainId: f.chainId,
    ...(f.code9 ? { code9: f.code9 } : {}),
    timingsMs,
    legs: f.legs,
    timingsGreen,
    ok: timingsGreen && legsOk && Object.keys(f.legs).length > 0,
  };
}

export function formatReport(r: Report): string {
  const lines = [`Stamper e2e (${r.mode}, chain ${r.chainId}) code ${r.code9 ?? "-"}`];
  for (const [k, v] of Object.entries(r.timingsMs))
    lines.push(
      `  ${v === null ? "FAIL" : "ok  "}  ${k.padEnd(16)} ${v === null ? "-" : `${(v / 1000).toFixed(2)} s`}`,
    );
  for (const [k, l] of Object.entries(r.legs))
    lines.push(
      `  ${l.status === "pass" ? "ok  " : l.status === "skip" ? "skip" : "FAIL"}  ${k.padEnd(22)} ${l.detail}`,
    );
  lines.push(r.ok ? "RESULT: green" : "RESULT: red");
  return lines.join("\n");
}

/** `--leg name=pass|fail|skip[:detail]` (legs run outside flow.ts: shell recipe, Playwright). */
export function parseLegArg(arg: string): [string, Leg] {
  const m = /^([\w.-]+)=(pass|fail|skip)(?::(.*))?$/s.exec(arg);
  if (!m) throw new Error(`bad --leg "${arg}"`);
  return [m[1] as string, { status: m[2] as LegStatus, detail: m[3] ?? "" }];
}

export function writeReport(
  flowFile: string,
  extra: Array<[string, Leg]> = [],
  totalS?: number,
): Report {
  const f = JSON.parse(readFileSync(flowFile, "utf8")) as FlowResult;
  for (const [k, l] of extra) f.legs[k] = l;
  if (totalS !== undefined)
    f.legs["total<10min"] = { status: totalS < 600 ? "pass" : "fail", detail: `${totalS} s` };
  const r = buildReport(f);
  writeFileSync(join(dirname(flowFile), "report.json"), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const extra: Array<[string, Leg]> = [];
  let file = join(import.meta.dirname, "out/flow.json");
  let total: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--leg") extra.push(parseLegArg(args[++i] ?? ""));
    else if (a === "--total-s") total = Number(args[++i]);
    else file = a;
  }
  const r = writeReport(resolve(file), extra, total);
  console.log(formatReport(r));
  process.exit(r.ok ? 0 : 1);
}
