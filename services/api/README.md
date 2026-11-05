# @stamper/api — foundation (WP-06)

One image, two processes: `ROLE=api` (custodian, holds keys) and `ROLE=worker` (key-free pipeline).
This package provides the shared skeleton; WP-07 fills `src/api/**`, WP-08 fills `src/worker/**`.

## Public API

- `src/config.ts` — `loadConfig(env): AppConfig` (zod, fail closed), `ConfigError`, `PUBLIC_ORIGIN`, `SECRET_ENV`, type `AppContext`.
  Secrets only arrive as `*_FILE` paths and only in `ROLE=api`; the worker refuses to start if any is present. `cfg.secrets` is non-enumerable (never in `JSON.stringify(cfg)`).
- `src/db/index.ts` — drizzle schema (DESIGN §9.3 + `captures`, `uploads`, `verify_jobs`, `attestation_bundles`, `stamp_events`), `createDb`, `closeDb`, `migrate` (advisory-locked, idempotent), `waitForSchema`, `ping`, `type Db`.
- `src/db/repo/index.ts` — `stamps.{byId,byCode,bySha256,setStatus}`, `bindings.{upsert,forStamp}`, `renditions.{insertPdq,knn}` (pgvector `<~>`, HNSW `bit_hamming_ops`), `chainTxs.outbox{Insert,Pending,Update}`, `challenges.{create,consume}`, `uploads.*`, `verifyJobs.*`, `stampEvents.append`.
- `src/queue/port.ts` — `JobName`, `JobPayload`, `JOB_ROLE`, `JOB_SCHEMAS`, `DEFAULT_SCHEDULES`, `Queue`, `QueueRoleError`. `queue/pgboss.ts` `createQueue(url, role, opts)`; `queue/memory.ts` `createMemoryQueue(role)` for handler unit tests.
- `src/shared/` — `STATUS`, `FINALITY`, rate limits (`CODE_LOOKUP_RATE`, `VERIFY_UPLOAD_RATE`, …), `hexToBytea`, `byteaToHex`, `pdqHexToBits`, `stagingPath`, `cachePath`, `sha256Stream`, `readRange`; `logger.ts` (pino with secret redaction), `metrics.ts` (prom-client), `context.ts` (`AppContext`, `RoleStart`).
- `src/main.ts` — `boot(env, { start?, log? })`. It loads the config, opens the DB, runs migrations (api) or waits for the schema (worker), creates the queue, calls the role's `start(ctx)` and then listens. Both roles serve `/healthz` and `/metrics`. A role adds its routes to `ctx.http` (Hono) inside `start()`.

## Queue backend

bullmq 6.3.11 lists `pg` as an optional peer, but its registry description is still "based on Redis", so the backend here is pg-boss 10 behind the port. Queues use the `short` policy: enqueue dedupes on (name, singletonKey) while a job is queued, and the default key is the canonical payload. `enqueue` returns `null` when it dedupes a job.

## Env

`ROLE PORT HOST DATABASE_URL CHAIN_ID RPC_URLS REGISTRY_ADDRESS RESOLVER_ADDRESS PDP_VERIFIER_ADDRESS FWSS_ADDRESS REORG_DEPTH RECEIPT_TIMEOUT_MS STAGING_DIR CACHE_DIR MODELS_DIR ML_URL MIRROR_S3_* PUBLIC_BASE_URL VERIFY_BASE_URL ATTEST_MODE APPLE_TEAM_ID IOS_BUNDLE_ID APPLE_APP_ATTEST_ENV ANDROID_PACKAGE ANDROID_CERT_SHA256 PLAY_CLOUD_PROJECT_NUMBER MAX_IMAGE_BYTES MAX_VIDEO_BYTES MAX_VIDEO_SECONDS CAPTURE_CHALLENGE_TTL_S NTFY_URL LOG_LEVEL SCHEMA_WAIT_MS FOC_MODE FOC_CHAIN_ID FOC_RPC_URL FOC_PAYER_ADDRESS FOC_DATASET_{A,B}_{ID,PROVIDER_ID} MOCK_SP_DIR MOCK_SP_PORT`.
Secrets (api only, as files): `RELAYER_PK_FILE REGISTRAR_PK_FILE RECORD_WRAP_KEY_FILE` (always required), `FOC_SESSION_PK_FILE` (required when FOC_MODE=real), `PLAY_SA_JSON_FILE` (required when ATTEST_MODE=strict), `RESOLVER_OWNER_PK_FILE` (optional).

`CAPTURE_CHALLENGE_TTL_S` (default 3600, range 300–86400): lifetime of the challenge `POST /v1/captures` returns. The claim consumes it only after the upload completes, so it must cover capture plus a slow upload (60 min ≈ 500 MB at ~1.1 Mbit/s). Enrolment challenges (`GET /v1/attest/challenge`) stay at 5 min. **The owner has not confirmed the 60-min default yet.** The `CAPTURE_TIME_SKEW` flag now measures from when the capture was opened to when it was claimed, so a long upload on its own does not set it.

## Ops metrics (read by `infra/scripts/healthcheck.sh`)

`src/shared/metrics.ts` defines the metrics. Every metric carries a label, so a metric that has no value yet is left out of `/metrics` instead of showing up as 0:
- worker: `stamper_queue_oldest_age_seconds{queue}`: how long the oldest runnable job in each pg-boss queue has waited. This covers the queues of both roles and comes from `Queue.stats()`. Also `stamper_probe_failures{slot}`: the number of bindings whose last probe failed. Both values are read from Postgres when `/metrics` is scraped, at most once every 10 s.
- api: `stamper_tx_latency_seconds_max{kind}`: the longest time from first broadcast to inclusion for txs that settled in the last 15 min, or the age of a tx that is still pending. A replacement tx keeps the original tx's start time. Also `stamper_runway_days{token="USDFC"}`, which the hourly `runway` job sets. It is absent until that job first runs, and while no lockup rate is set.

## Scripts

- `pnpm build` compiles to `dist/` and copies the SQL migrations.
- `pnpm typecheck` checks `src` plus every `test/*/tsconfig.json`. Each test directory brings its own tsconfig.
- `pnpm test` runs vitest. The DB tests in `test/foundation/db.test.ts` start `pgvector/pgvector:pg17` as a throwaway container on a random port, or use `TEST_DATABASE_URL`/`DATABASE_URL` as an admin URL. If neither is available they are skipped with a printed reason.
- `pnpm db:generate` regenerates migrations after a schema change.
- Docker: `docker build -f services/api/Dockerfile .` from the repo root. The image runs `node dist/main.js` and `ROLE` selects the role. It is a multi-stage build with `pnpm deploy`, and the static ffmpeg 7.1 binary is pinned by digest.

## Stubbed / placeholders

`src/api/index.ts` and `src/worker/index.ts` are empty `start(ctx)` placeholders. The FOC settings mirror `@stamper/foc`'s `FocConfig` structurally, with no workspace dependency. The `mock` mode defaults data sets A=1 and B=2.
