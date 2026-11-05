# @stamper/e2e — whole-flow scripts

One command proves capture → claim → register → mark → store → bind → check, locally against anvil
with the mocks (`run-local.sh`), and on Calibration with real FOC when keys exist (`run-calibration.sh`).

| File | What it does |
|---|---|
| `run-local.sh` | anvil (genesis 48 h back) → `infra/scripts/deploy-calibration.sh --dry-run` (DeployLocal + roles) → warp 172801 s → Postgres `stamper-wp12-pg` (docker) → ml from `services/ml/.venv` (optional) → api + worker from source (`FOC_MODE=mock`, `ATTEST_MODE=stub`) → `flow.ts` → `verify-independently.sh` → `next dev` + Playwright `apps/web/tests/e2e/verify.spec.ts` → `report.ts` |
| `run-calibration.sh` | same flow on 314159 with `FOC_MODE=real`; prints `SKIP …` and exits 0 when credentials are absent, or while the registrar/binder roles of `REGISTRAR_PK`/`RELAYER_PK` are still inside the 48 h `ROLE_DELAY` (the line names the activation time; `E2E_ROLE_WAIT_S` waits instead); exits 1 if a role was never announced |
| `roles.ts` | the role pre-flight: `isActiveRegistrar` / `isActiveBinder` and `*ActiveFrom` for the configured keys; exit 0 active, 3 pending (activation time on stdout), 1 missing. `run-local.sh` asserts pending before its warp and active after it |
| `flow.ts` | simulated device: secp256k1 key, stub enrolment, fixture JPEG → `@stamper/minimise` → sha256 + PieceCID (synapse and fr32 must agree) → upload in 3 chunks → signed claim → follows receipt / marked / bound / probe → chain re-verification → ladder legs ORIGINAL, STAMPER MARKED COPY, RELATED (q70 re-encode, needs ml) → 2 s H.264 video with a server-computed PieceCID |
| `verify-independently.sh` | the cast/curl recipe of `docs/verify-independently.md` (DESIGN §8.3), executed |
| `report.ts` | the five timings (capture→202, 202→receipt, receipt→marked, marked→bound, bound→probe-ok) and every leg → `out/report.json` |
| `lib/api.ts` | typed api client; `poll()` retries only transient failures (404/408/425/429/5xx, network errors, timeouts) and stops at once on anything else (a bug, a 4xx, `PollAbort`) |
| `lib/cors-proxy.ts` | local-only CORS front for the api and the mock SP so the browser page can fetch them |

## Env

All ports are free-random unless preset: `E2E_ANVIL_PORT E2E_PG_PORT E2E_API_PORT E2E_WORKER_PORT E2E_ML_PORT
E2E_WEB_PORT E2E_PROXY_PORT E2E_MOCK_SP_PORT`. Toggles: `E2E_SKIP_ML=1`, `E2E_SKIP_WEB=1`, `E2E_SKIP_VIDEO=1`,
`E2E_KEEP=1` (keep the temp work dir), `E2E_HOLD=1` (keep the stack up after the report and write the verify URL to `out/hold-url`; Ctrl-C stops it), `E2E_LOG_LEVEL`, `E2E_OUT_DIR` (default `e2e/out`).
`flow.ts` alone needs `API_URL`, `RPC_URL`, `DEPLOYMENT_JSON`; `verify-independently.sh` needs `RPC REG PDP FWSS CODE`
and `PROVIDER_URL` or `FILBEAM_BASE`. Calibration: see the header of `run-calibration.sh`.

Device options for `flow.ts` (both run scripts pass the environment through unchanged):

- `E2E_LOCATION="lat,lon[,accuracyM]"` (degrees; accuracy defaults to 10 m): the photo stamp records location
  exactly as the app does with "Record location" on (DESIGN §11.3). The public record gets only the 0.01° cell
  (`location: {latE2, lonE2, source: "fused"}`) and `privateHash`; the exact fix goes in a private record under a
  fresh random 32-byte salt, sent as the claim's `privateRecord` (the api checks it and seals it). An extra
  `location` leg checks that the published record carries the cell and commits to the private record. Example:
  `E2E_LOCATION="-23.5505,-46.6333,8" e2e/run-local.sh`.
- `E2E_PHOTO=/path/to.jpg`: stamp this JPEG instead of the generated fixture. It goes through the same
  `@stamper/minimise` step (GPS, serials and maker notes dropped). `contentHash` is first-stamp-wins, so one file
  stamps once per stack.
- `E2E_PLATFORM=ios|android` (default `android`).

## Run

```sh
pnpm --filter @stamper/e2e typecheck && pnpm --filter @stamper/e2e test   # unit tests of the helpers
e2e/run-local.sh                                                          # ~1 min warm, ~4 min with a cold forge/ml start
```

Requires built workspace packages (`packages/*/dist`), anvil/cast/forge, docker (pgvector/pgvector:pg17), ffmpeg,
and Playwright's chromium for the web leg. Logs: `e2e/out/logs/*.log`. Nothing is left running: process groups are
killed and the container removed on exit; `apps/web` files touched by `next dev` are restored.

## Stubbed / not covered

Attestation is `ATTEST_MODE=stub`; FOC is `MockFoc` + `MockPDPVerifier` + the mock SP; the relayer/registrar keys are
public anvil keys. The web leg reaches the api and the mock SP through `lib/cors-proxy.ts` because neither sends CORS
headers yet. The Calibration run needs keys and FOC funds and has not been executed here.
