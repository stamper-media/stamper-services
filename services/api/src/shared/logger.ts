import { type Logger, pino } from "pino";

export type { Logger };

/** Paths redacted from every log line; secrets must never reach logs. */
export const REDACT_PATHS = [
  "secrets",
  "*.secrets",
  "cfg.secrets",
  "*.relayerPk",
  "*.registrarPk",
  "*.focSessionPk",
  "*.resolverOwnerPk",
  "*.recordWrapKey",
  "*.playSaJson",
  "*.secretAccessKey",
  "*.mirror.secretAccessKey",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function createLogger(opts: {
  role: string;
  level?: string;
  destination?: NodeJS.WritableStream;
}): Logger {
  const options = {
    level: opts.level ?? "info",
    base: { role: opts.role, svc: "stamper-api" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
