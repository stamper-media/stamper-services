#!/usr/bin/env bash
# Whole-flow e2e on this machine (plan §WP-12):
#   anvil (genesis 48 h in the past) → DeployLocal via infra deploy-calibration.sh --dry-run → warp past the
#   48 h role delay → throwaway Postgres (docker) → ml (services/ml venv, optional) → api + worker from source
#   (ATTEST_MODE=stub, FOC_MODE=mock; the api serves the mock SP) → flow.ts (simulated device, photo + video,
#   ladder legs, chain re-verification) → verify-independently.sh (cast/curl recipe) → web (next dev) +
#   Playwright verify.spec → report.ts (e2e/out/report.json).
# Every port is free-random unless preset (E2E_*_PORT). Toggles: E2E_SKIP_ML=1, E2E_SKIP_WEB=1, E2E_SKIP_VIDEO=1,
# E2E_KEEP=1 (keep logs dir), E2E_HOLD=1 (after the report, keep the stack up and print the verify URL
# until Ctrl-C). Device options pass through to flow.ts unchanged: E2E_LOCATION="lat,lon[,accuracyM]",
# E2E_PHOTO=/path/to.jpg, E2E_PLATFORM (see flow.ts). Leaves nothing running: background processes are killed and the
# stamper-wp12-pg container is removed on exit.
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_DIR/.." && pwd)"
OUT="${E2E_OUT_DIR:-$E2E_DIR/out}"
HEAVY_LOCK="$REPO/.heavy.flock"
PG_CONTAINER="${E2E_PG_CONTAINER:-stamper-wp12-pg}"
T0=$(date +%s)

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[e2e] error:\033[0m %s\n' "$*" >&2; exit 1; }
PROTOCOL="${STAMPER_PROTOCOL_DIR:-$REPO/../stamper-protocol}"
EXPLORER="${STAMPER_EXPLORER_DIR:-$REPO/../stamper-explorer}"
[[ -x "$PROTOCOL/infra/scripts/deploy-calibration.sh" ]] ||
  die "stamper-protocol not found at $PROTOCOL (clone it beside this repo or set STAMPER_PROTOCOL_DIR)"
if [[ "${E2E_SKIP_WEB:-0}" != 1 && ! -x "$EXPLORER/apps/web/node_modules/.bin/next" ]]; then
  log "stamper-explorer not installed at $EXPLORER: skipping the web leg (set STAMPER_EXPLORER_DIR)"
  E2E_SKIP_WEB=1
fi
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
for b in anvil cast forge docker curl node python3 ffmpeg openssl flock; do
  command -v "$b" >/dev/null || die "$b is not on PATH"
done
[[ -d "$REPO/services/api/node_modules/@stamper/core" ]] || die "run pnpm install first"

for k in ANVIL PG API WORKER ML WEB PROXY MOCK_SP; do
  v="E2E_${k}_PORT"
  [[ -n "${!v:-}" ]] || printf -v "$v" '%s' "$(free_port)"
done
rm -rf "$OUT" && mkdir -p "$OUT/logs"
WORK="$(mktemp -d /tmp/stamper-wp12-XXXXXX)"
mkdir -p "$WORK"/{env,secrets,staging,cache,models,mock-sp}
PIDS=()

# `next dev` writes into apps/web (next-env.d.ts, .next/dev, and on Next 16 AGENTS.md/CLAUDE.md):
# snapshot what exists before and put apps/web back exactly as it was afterwards.
WEB_DIR="$EXPLORER/apps/web"
WEB_SNAP=""
snapshot_web() {
  WEB_SNAP="$WORK/web-snap"
  mkdir -p "$WEB_SNAP"
  for f in next-env.d.ts AGENTS.md CLAUDE.md; do [[ -e "$WEB_DIR/$f" ]] && cp -p "$WEB_DIR/$f" "$WEB_SNAP/$f"; done
  [[ -e "$WEB_DIR/.next/dev" ]] && touch "$WEB_SNAP/.had-next-dev"
  return 0
}
restore_web() {
  [[ -n "$WEB_SNAP" && -d "$WEB_SNAP" ]] || return 0
  for f in next-env.d.ts AGENTS.md CLAUDE.md; do
    if [[ -e "$WEB_SNAP/$f" ]]; then cp -p "$WEB_SNAP/$f" "$WEB_DIR/$f"; else rm -f "$WEB_DIR/$f"; fi
  done
  [[ -e "$WEB_SNAP/.had-next-dev" ]] || rm -rf "$WEB_DIR/.next/dev"
}

cleanup() {
  local rc=$?
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; done
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  restore_web
  [[ "${E2E_KEEP:-0}" == 1 ]] || rm -rf "$WORK"
  log "elapsed $(($(date +%s) - T0)) s; logs in $OUT/logs"
  if [[ $rc -eq 0 ]]; then log "PASS"; else log "FAIL (rc=$rc)"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# start <name> <dir> <cmd…>: own session/process group so cleanup kills the whole tree (tsx, next, uvicorn)
start() {
  local name=$1 dir=$2
  shift 2
  (cd "$dir" && exec setsid "$@") >"$OUT/logs/$name.log" 2>&1 &
  PIDS+=($!)
}
wait_http() { # wait_http <name> <url> <timeout-s>
  local name=$1 url=$2 n=$3 i
  for ((i = 0; i < n * 2; i++)); do
    curl -fsS -o /dev/null -m 5 "$url" 2>/dev/null && { log "$name up ($url)"; return 0; }
    sleep 0.5
  done
  tail -25 "$OUT/logs/$name.log" >&2 || true
  return 1
}

# ── chain ────────────────────────────────────────────────────────────────────────────────────────
RPC="http://127.0.0.1:$E2E_ANVIL_PORT"
# genesis 48 h + 3 s in the past, so after the role-delay warp chain time ≈ wall time and claims signed
# with Date.now() fall inside their deadline
start anvil "$WORK" anvil --port "$E2E_ANVIL_PORT" --host 127.0.0.1 --timestamp $(($(date +%s) - 172803))
for ((i = 0; i < 60; i++)); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == 31337 ]] || die "anvil did not start"
log "deploy (DeployLocal + roles) → $RPC"
ANVIL_RPC_URL="$RPC" STAMPER_HEAVY_LOCK="$HEAVY_LOCK" \
  "$PROTOCOL/infra/scripts/deploy-calibration.sh" --dry-run --out-dir "$WORK/env" >"$OUT/logs/deploy.log" 2>&1 ||
  { tail -20 "$OUT/logs/deploy.log" >&2; die "deploy failed"; }
# throwaway public anvil keys: registrar #1, relayer = binder #2 (resolver owner #3 below)
ANVIL_REGISTRAR_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ANVIL_RELAYER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
# the role pre-flight run-calibration.sh relies on: pending (exit 3) before the warp, active (exit 0) after it
roles() {
  REGISTRAR_PK="$ANVIL_REGISTRAR_PK" RELAYER_PK="$ANVIL_RELAYER_PK" RPC_URL="$RPC" DEPLOYMENT_JSON="$WORK/env/anvil.json" \
    E2E_ROLE_WAIT_S=0 "$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/roles.ts" 2>>"$OUT/logs/roles.log"
}
roles_rc=0
roles_at="$(roles)" || roles_rc=$?
[[ $roles_rc -eq 3 && -n "$roles_at" ]] || die "role pre-flight before the warp: want pending (exit 3), got exit $roles_rc (logs/roles.log)"
cast rpc evm_increaseTime 172801 --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
roles >/dev/null || die "role pre-flight after the warp: roles not active (logs/roles.log)"
log "role pre-flight: pending until $roles_at before the warp, active after it"
log "warped past the 48 h role delay (chain $(cast block latest -f timestamp --rpc-url "$RPC"), wall $(date +%s))"
cp "$WORK/env/anvil.json" "$OUT/deployment.json"
set -a
# shellcheck disable=SC1091
. "$WORK/env/anvil.env"
set +a
REG="$REGISTRY_ADDRESS"

# ── postgres ─────────────────────────────────────────────────────────────────────────────────────
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=stamper -e POSTGRES_PASSWORD=stamper -e POSTGRES_DB=stamper \
  -p "127.0.0.1:$E2E_PG_PORT:5432" --memory 512m pgvector/pgvector:pg17 >/dev/null
for ((i = 0; i < 60; i++)); do
  docker exec "$PG_CONTAINER" pg_isready -U stamper -d stamper -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$PG_CONTAINER" pg_isready -U stamper -d stamper -h 127.0.0.1 >/dev/null || die "postgres did not start"
export DATABASE_URL="postgres://stamper:stamper@127.0.0.1:$E2E_PG_PORT/stamper"
log "postgres up ($PG_CONTAINER :$E2E_PG_PORT)"

# ── ml (optional) ────────────────────────────────────────────────────────────────────────────────
ML_URL=""
if [[ "${E2E_SKIP_ML:-0}" != 1 ]]; then
  if [[ -x "$REPO/services/ml/.venv/bin/python" ]]; then
    start ml "$REPO/services/ml" env ML_PORT="$E2E_ML_PORT" MODELS_DIR="$REPO/services/ml/models" \
      STAGING_DIR="$WORK/staging" ML_WATERMARK=auto ./.venv/bin/python -m app.main
    if wait_http ml "http://127.0.0.1:$E2E_ML_PORT/health" 150; then ML_URL="http://127.0.0.1:$E2E_ML_PORT"; fi
  fi
  [[ -n "$ML_URL" ]] || { log "ml unavailable: RELATED leg will be skipped"; export E2E_SKIP_ML=1; }
fi

# ── api + worker from source ─────────────────────────────────────────────────────────────────────
printf '%s' "$ANVIL_REGISTRAR_PK" >"$WORK/secrets/registrar_pk"
printf '%s' "$ANVIL_RELAYER_PK" >"$WORK/secrets/relayer_pk"
printf '%s' 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 >"$WORK/secrets/resolver_owner_pk"
openssl rand -hex 32 >"$WORK/secrets/record_wrap_key"
API="http://127.0.0.1:$E2E_API_PORT"
WEB="http://127.0.0.1:$E2E_WEB_PORT"
PROXY="http://127.0.0.1:$E2E_PROXY_PORT"
export FOC_MODE=mock ATTEST_MODE=stub LOG_LEVEL="${E2E_LOG_LEVEL:-info}" RECEIPT_TIMEOUT_MS=30000
export FOC_DATASET_A_ID=1 FOC_DATASET_B_ID=2 FOC_DATASET_A_PROVIDER_ID=1 FOC_DATASET_B_PROVIDER_ID=2 FOC_RPC_URL="$RPC"
export MOCK_SP_DIR="$WORK/mock-sp" MOCK_SP_PORT="$E2E_MOCK_SP_PORT"
export STAGING_DIR="$WORK/staging" CACHE_DIR="$WORK/cache" MODELS_DIR="$WORK/models"
export PUBLIC_BASE_URL="$API" VERIFY_BASE_URL="$WEB"
TSX="$REPO/services/api/node_modules/.bin/tsx"
start api "$REPO/services/api" env ROLE=api HOST=127.0.0.1 PORT="$E2E_API_PORT" \
  REGISTRAR_PK_FILE="$WORK/secrets/registrar_pk" RELAYER_PK_FILE="$WORK/secrets/relayer_pk" \
  RESOLVER_OWNER_PK_FILE="$WORK/secrets/resolver_owner_pk" RECORD_WRAP_KEY_FILE="$WORK/secrets/record_wrap_key" \
  "$TSX" src/main.ts
wait_http api "$API/healthz" 90 || die "api did not start"
start worker "$REPO/services/api" env ROLE=worker HOST=127.0.0.1 PORT="$E2E_WORKER_PORT" ${ML_URL:+ML_URL=$ML_URL} \
  "$TSX" src/main.ts
wait_http worker "http://127.0.0.1:$E2E_WORKER_PORT/healthz" 90 || die "worker did not start"
wait_http mock-sp "http://127.0.0.1:$E2E_MOCK_SP_PORT/health" 10 || log "mock SP has no /health (continuing)"

# ── simulated device flow ────────────────────────────────────────────────────────────────────────
LEGS=()
log "flow.ts (simulated device)"
flow_rc=0
API_URL="$API" RPC_URL="$RPC" DEPLOYMENT_JSON="$OUT/deployment.json" E2E_OUT_DIR="$OUT" E2E_MODE=local \
  "$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/flow.ts" 2>&1 | tee "$OUT/logs/flow.log" || flow_rc=$?
[[ -f "$OUT/flow.json" ]] || die "flow.ts wrote no flow.json"

if [[ -f "$OUT/flow.env" ]]; then
  # shellcheck disable=SC1091
  . "$OUT/flow.env"
  log "verify-independently.sh $STAMP_CODE"
  if RPC="$RPC" REG="$REG" PDP="$PDP_VERIFIER_ADDRESS" FWSS="$FWSS_ADDRESS" CODE="$STAMP_CODE" \
    PROVIDER_URL="$STAMP_PROVIDER_URL" OUT_DIR="$WORK/indep" "$E2E_DIR/verify-independently.sh" \
    2>&1 | tee "$OUT/logs/verify-independently.log"; then
    LEGS+=(--leg "verify-independently=pass:cast/curl recipe, $(grep -c '  ok ' "$OUT/logs/verify-independently.log") checks")
  else
    LEGS+=(--leg "verify-independently=fail:see logs/verify-independently.log")
  fi
else
  LEGS+=(--leg "verify-independently=fail:no stamp to check")
fi

# ── web + Playwright ─────────────────────────────────────────────────────────────────────────────
if [[ "${E2E_SKIP_WEB:-0}" == 1 ]]; then
  LEGS+=(--leg "playwright=skip:E2E_SKIP_WEB=1")
elif [[ -z "${STAMP_CODE:-}" ]]; then
  LEGS+=(--leg "playwright=fail:no stamp to show")
else
  # the browser needs CORS on the api and on the piece source; see lib/cors-proxy.ts
  start cors-proxy "$E2E_DIR" env CORS_PROXY_PORT="$E2E_PROXY_PORT" \
    CORS_PROXY_ROUTES="api=$API,sp=http://127.0.0.1:$E2E_MOCK_SP_PORT" ./node_modules/.bin/tsx lib/cors-proxy.ts
  snapshot_web
  # the QR scanner loads public/zxing_reader.wasm, which `pnpm dev`/`pnpm build` copy and `next dev` alone does not
  (cd "$WEB_DIR" && node scripts/copy-wasm.mjs)
  start web "$WEB_DIR" env NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_CHAIN_ID=31337 \
    NEXT_PUBLIC_RPC_URLS="$RPC,http://localhost:$E2E_ANVIL_PORT" \
    NEXT_PUBLIC_REGISTRY_ADDRESS="$REG" NEXT_PUBLIC_RESOLVER_ADDRESS="$RESOLVER_ADDRESS" \
    NEXT_PUBLIC_API_URL="$PROXY/api" NEXT_PUBLIC_MIRROR_URL="$PROXY/sp/piece" NEXT_PUBLIC_FILBEAM_BASE="$PROXY/sp/piece" \
    NEXT_PUBLIC_ORIGIN="$WEB" NEXT_PUBLIC_VERIFY_BASE_URL="$WEB" \
    ./node_modules/.bin/next dev -p "$E2E_WEB_PORT" -H 127.0.0.1
  if wait_http web "$WEB/about" 240; then
    curl -fsS -o /dev/null -m 180 "$WEB/v/$STAMP_CODE" || true # compile the verify route before the clock starts
    log "playwright verify.spec against $WEB/v/$STAMP_CODE"
    if (cd "$WEB_DIR" && PLAYWRIGHT_BASE_URL="$WEB" STAMP_CODE="$STAMP_CODE" \
      flock "$HEAVY_LOCK" ./node_modules/.bin/playwright test --reporter=line --output "$OUT/playwright" 2>&1 | tee "$OUT/logs/playwright.log"); then
      LEGS+=(--leg "playwright=pass:$(grep -oE '[0-9]+ passed' "$OUT/logs/playwright.log" | tail -1)")
    else
      LEGS+=(--leg "playwright=fail:$(grep -oE '[0-9]+ (failed|passed)' "$OUT/logs/playwright.log" | paste -sd, -)")
    fi
  else
    LEGS+=(--leg "playwright=fail:next dev did not start")
  fi
fi

# ── report ───────────────────────────────────────────────────────────────────────────────────────
"$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/report.ts" "$OUT/flow.json" "${LEGS[@]}" --total-s $(($(date +%s) - T0))

# ── hold (E2E_HOLD=1): keep the stack up for a person to look at; Ctrl-C or TERM tears it down ──
if [[ "${E2E_HOLD:-0}" == 1 && -n "${STAMP_CODE:-}" && "${E2E_SKIP_WEB:-0}" != 1 ]]; then
  printf '%s/v/%s\n' "$WEB" "$STAMP_CODE" >"$OUT/hold-url"
  log "holding: $WEB/v/$STAMP_CODE (api $API, rpc $RPC); Ctrl-C to stop"
  trap 'exit 0' INT TERM # the verdict is the report above; stopping the hold is not a failure
  while :; do sleep 3600 & wait $!; done
fi
