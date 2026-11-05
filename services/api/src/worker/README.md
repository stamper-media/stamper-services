# worker (ROLE=worker): key-free pipeline

This process decodes media and talks to storage providers. It holds no secrets, and `start()` refuses any.

## Public API
- `start(ctx)` in `index.ts` builds `WorkerDeps` from config (`createWorkerDeps`) and calls `registerWorker`.
- `registerWorker(ctx, deps)` in `app.ts` registers the worker jobs `ingest`, `mark`, `store`, `probe`, `verify-upload`, `pdp-monitor`, `probe-sample` and `mirror-gc`. It schedules the last three using `DEFAULT_SCHEDULES`.
- Every handler is `handleX(deps, payload)` in `jobs/*.ts` and returns an outcome object, which makes it testable.
- `mirror.ts` provides `createS3Mirror`, `ensureMirrored` and `mirrorKey`. Originals go to `originals/<sha256hex>` (the api reads this key) and derivatives to `d/<sha256hex>`. A PUT sends Content-MD5 and checks the ETag.
- `chain-reads.ts` holds the read-only viem registry reads. `notify.ts` posts to ntfy. `media.ts` holds the staged-original lookup, the decode check, ffprobe and the first video frame.

## Flow
1. `ingest` runs the decode/ffprobe checks, then minimiser inspection (no GPS, serial, MakerNote or udta; Orientation must be present). It checks size, codec and duration limits, and adds exact-duplicate and PDQ near-duplicate (≤ 10 bits) notes. The result goes to the `moderation` row and `stamps.ingest`. On pass it enqueues `mark` and `store`. On fail it sets `rejected` and enqueues `flag(RejectedPrePublication)`.
2. `mark` picks the badge family by effective level (F1 when ≥ 1, else F0) and applies the badge. For images it then applies TrustMark (skipped when ML_URL is unset). It writes `share.jpg|mp4`, a `derivatives` row (kind 1|2) with `paramsHash`, and 12 PDQ rows (original, marked copy, 10 variants). It also renders `preview.jpg`, `thumb.webp` and `share-card.png` (kind 3), puts the derivative on the mirror, and enqueues `attach`.
3. `store` puts the original on the mirror first, then runs FOC `storeOriginal` on A and then B, then enqueues `commit` A and B. Under FOC_MODE=mock there is no FOC reader, because the api stores from staging at commit.
4. `probe` runs `downloadAndVerify` against the bound URL, the provider URL and FilBeam (slot A). It updates `last_ok_at` only when the hash matches. When failures last 3 days (or 3 failures with no success ever), it sends the ntfy alert "repair needed".
5. `verify-upload` runs DESIGN §8.1 through core `decide()`: exact, then derivative, then watermark code, then PDQ k-NN (k=20, ≤ 31 bits, SSIM re-rank, every candidate within 5 bits). For a RELATED result it writes a pixelmatch diff PNG to `CACHE_DIR/verify/`. It also writes a `verifications` row.
6. `pdp-monitor` updates `data_sets` and sends ntfy alerts for: not live, a listener that is not FWSS, `pdpEndEpoch≠0`, proving overdue, and 2 or more consecutive faults. `probe-sample` probes 2 % of bound slots. `mirror-gc` removes staged originals older than 30 days that have a mirror object of the same size, plus finished verify uploads older than 1 day.

## Env
The worker uses the WP-06 set. ML_URL is optional: without it there is no watermark and no PDQ, and a warning is logged. MIRROR_S3_* is optional in dev, with a warning. NTFY_URL is optional; without it alerts are only logged. FFMPEG_PATH and FFPROBE_PATH are honoured through @stamper/marking.

## Tests
`pnpm --filter @stamper/api test` covers `test/worker/{unit,jobs,pipeline}.test.ts`. The DB tests use docker pgvector, or TEST_DATABASE_URL. The pipeline test starts `services/ml/.venv` (or uses ML_URL); without it, it falls back to nullWatermark and a stand-in hash.

## Stubbed or not exercised
- Real FOC (`createFocReader`): needs Calibration or mainnet.
- Real S3: tests use an in-memory mirror and a stubbed S3 client.
- Abuse score is a stub (0).
- vPDQ for video is v1.
