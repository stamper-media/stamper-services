#!/usr/bin/env bash
# Local Stamper stack on Filecoin Calibration, kept running for hands-on use: the app (browser capture,
# web key, level 0) and the Explorer (check site), against the real registry, real FOC storage and the
# owner's testnet keys. The app and the Explorer run from their own repos, cloned beside this one
# (or STAMPER_APP_DIR / STAMPER_EXPLORER_DIR); the deployment comes from stamper-protocol.
#   e2e/stack-calibration.sh            # Ctrl-C stops everything (Postgres data is kept)
# Same env as run-calibration.sh (source ~/.config/stamper/calibration.env and calibration-foc.env).
# Ports come from the environment (STACK_*_PORT); defaults avoid the usual dev ports.
# Postgres keeps its data in the docker volume STACK_PG_VOLUME, and staged uploads in STACK_DATA_DIR,
# so stamps survive a restart. Keys are written to a 0600 temp dir that is removed on exit.
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_DIR/.." && pwd)"
PROTOCOL="${STAMPER_PROTOCOL_DIR:-$REPO/../stamper-protocol}"
EXPLORER="${STAMPER_EXPLORER_DIR:-$REPO/../stamper-explorer}"
APP="${STAMPER_APP_DIR:-$REPO/../stamper-app}"
DEP="${DEPLOYMENT_JSON:-$PROTOCOL/contracts/deployments/calibration.json}"
DATA="${STACK_DATA_DIR:-$E2E_DIR/.stack-calibration}"
PG_CONTAINER="${STACK_PG_CONTAINER:-stamper-stack-calib-pg}"
PG_VOLUME="${STACK_PG_VOLUME:-stamper-stack-calib-pg}"
WEB_PORT="${STACK_WEB_PORT:-13310}" APP_PORT="${STACK_APP_PORT:-13311}" API_PORT="${STACK_API_PORT:-18310}" WORKER_PORT="${STACK_WORKER_PORT:-18311}"
PROXY_PORT="${STACK_PROXY_PORT:-18312}" ML_PORT="${STACK_ML_PORT:-18313}" PG_PORT="${STACK_PG_PORT:-15310}"
log() { printf '\033[1;34m[stack-calib]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[stack-calib] error:\033[0m %s\n' "$*" >&2; exit 1; }

for k in CALIBRATION_RPC_URL RELAYER_PK REGISTRAR_PK FOC_SESSION_PK FOC_PAYER_ADDRESS \
  FOC_DATASET_A_ID FOC_DATASET_B_ID FOC_DATASET_A_PROVIDER_ID FOC_DATASET_B_PROVIDER_ID; do
  [[ -n "${!k:-}" ]] || die "$k is not set (source ~/.config/stamper/calibration.env and calibration-foc.env)"
done
[[ -f "$DEP" ]] || die "$DEP is missing (clone stamper-protocol beside this repo, or set DEPLOYMENT_JSON)"
for d in "$EXPLORER/apps/web" "$APP/apps/web"; do
  [[ -x "$d/node_modules/.bin/next" ]] || die "$d is missing or not installed (clone it beside this repo and run pnpm install)"
done
unset FOC_PAYER_PK DEPLOYER_PK # ceremony keys; the api refuses to start with them
for b in docker curl node python3 openssl; do command -v "$b" >/dev/null || die "$b is not on PATH"; done
[[ -d "$REPO/services/api/node_modules/@stamper/core" ]] || die "run pnpm install first"

mkdir -p "$DATA"/{logs,staging,cache,models}
WORK="$(mktemp -d "${TMPDIR:-/tmp}/stamper-stack-calib-XXXXXX")"
chmod 700 "$WORK"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  docker stop "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  log "stopped; logs in $DATA/logs"
}
trap cleanup EXIT
trap 'exit 0' INT TERM
start() {
  local name=$1 dir=$2
  shift 2
  (cd "$dir" && exec setsid "$@") >>"$DATA/logs/$name.log" 2>&1 &
  PIDS+=($!)
}
wait_http() {
  local i
  for ((i = 0; i < $3 * 2; i++)); do curl -fsS -o /dev/null -m 5 "$2" 2>/dev/null && return 0; sleep 0.5; done
  tail -25 "$DATA/logs/$1.log" >&2 || true
  return 1
}
json_get() { node -e 'const j=require(process.argv[1]);const v=j[process.argv[2]];process.stdout.write(Array.isArray(v)?v.join(","):String(v??""))' "$1" "$2"; }

# ── Postgres (persistent volume) ──
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$PG_CONTAINER" -e POSTGRES_USER=stamper -e POSTGRES_PASSWORD=stamper -e POSTGRES_DB=stamper \
  -v "$PG_VOLUME:/var/lib/postgresql/data" -p "127.0.0.1:$PG_PORT:5432" --memory 512m pgvector/pgvector:pg17 >/dev/null
for ((i = 0; i < 60; i++)); do docker exec "$PG_CONTAINER" pg_isready -U stamper -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 0.5; done

# ── ml (TrustMark + PDQ), when its venv exists ──
ML_URL="${ML_URL:-}"
if [[ -z "$ML_URL" && -x "$REPO/services/ml/.venv/bin/python" ]]; then
  start ml "$REPO/services/ml" env ML_PORT="$ML_PORT" MODELS_DIR="$REPO/services/ml/models" \
    STAGING_DIR="$DATA/staging" ML_WATERMARK=auto ./.venv/bin/python -m app.main
  wait_http ml "http://127.0.0.1:$ML_PORT/health" 150 && ML_URL="http://127.0.0.1:$ML_PORT"
fi
[[ -n "$ML_URL" ]] || log "ml is not running: no watermark or perceptual-hash search"

# ── api + worker ──
umask 077
mkdir -p "$WORK/secrets"
printf '%s' "$RELAYER_PK" >"$WORK/secrets/relayer_pk"
printf '%s' "$REGISTRAR_PK" >"$WORK/secrets/registrar_pk"
printf '%s' "$FOC_SESSION_PK" >"$WORK/secrets/foc_session_pk"
[[ -f "$DATA/record_wrap_key" ]] || openssl rand -hex 32 >"$DATA/record_wrap_key" # stable: sealed records stay readable
umask 022
RPCS="$CALIBRATION_RPC_URL${CALIBRATION_RPC_URL_2:+,$CALIBRATION_RPC_URL_2}"
API="http://127.0.0.1:$API_PORT"
PROXY="http://localhost:$PROXY_PORT"
WEB="http://localhost:$WEB_PORT"
APPURL="http://localhost:$APP_PORT"
common=(DATABASE_URL="postgres://stamper:stamper@127.0.0.1:$PG_PORT/stamper" CHAIN_ID=314159 RPC_URLS="$RPCS"
  REGISTRY_ADDRESS="$(json_get "$DEP" registry)" RESOLVER_ADDRESS="$(json_get "$DEP" resolver)"
  PDP_VERIFIER_ADDRESS="$(json_get "$DEP" pdpVerifier)" FWSS_ADDRESS="$(json_get "$DEP" fwss)"
  FOC_MODE=real FOC_CHAIN_ID=314159 FOC_RPC_URL="$CALIBRATION_RPC_URL" FOC_PAYER_ADDRESS="$FOC_PAYER_ADDRESS"
  FOC_DATASET_A_ID="$FOC_DATASET_A_ID" FOC_DATASET_B_ID="$FOC_DATASET_B_ID"
  FOC_DATASET_A_PROVIDER_ID="$FOC_DATASET_A_PROVIDER_ID" FOC_DATASET_B_PROVIDER_ID="$FOC_DATASET_B_PROVIDER_ID"
  ATTEST_MODE=stub WEB_CAPTURE=1 STAGING_DIR="$DATA/staging" CACHE_DIR="$DATA/cache" MODELS_DIR="$DATA/models"
  PUBLIC_BASE_URL="$PROXY/api" VERIFY_BASE_URL="$WEB" LOG_LEVEL="${STACK_LOG_LEVEL:-info}" HOST=127.0.0.1)
secrets=(RELAYER_PK_FILE="$WORK/secrets/relayer_pk" REGISTRAR_PK_FILE="$WORK/secrets/registrar_pk"
  FOC_SESSION_PK_FILE="$WORK/secrets/foc_session_pk" RECORD_WRAP_KEY_FILE="$DATA/record_wrap_key")
TSX="$REPO/services/api/node_modules/.bin/tsx"
start api "$REPO/services/api" env -u RELAYER_PK -u REGISTRAR_PK -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  "${common[@]}" "${secrets[@]}" ROLE=api PORT="$API_PORT" "$TSX" src/main.ts
wait_http api "$API/healthz" 120 || die "api did not start"
start worker "$REPO/services/api" env -u RELAYER_PK -u REGISTRAR_PK -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  "${common[@]}" ${ML_URL:+ML_URL=$ML_URL} ROLE=worker PORT="$WORKER_PORT" "$TSX" src/main.ts
wait_http worker "http://127.0.0.1:$WORKER_PORT/healthz" 120 || die "worker did not start"

# ── CORS front for the browser (the api sends no CORS; prod is same-origin behind Caddy) ──
start cors-proxy "$E2E_DIR" env CORS_PROXY_PORT="$PROXY_PORT" CORS_PROXY_ROUTES="api=$API" \
  ./node_modules/.bin/tsx lib/cors-proxy.ts
wait_http cors-proxy "$PROXY/api/healthz" 30 || die "cors proxy did not start"

# ── Explorer (check site) and app (browser capture) ──
# the Explorer's "try an example" chips: the Calibration demo stamp T1AQ-QJ5V-3 (the harbour photo, also
# stamped as PDSE-8WYH-H; this stack's own stamp, so its search index is here), opened as is and as an
# edited copy (resized, a boat removed) that the api search finds (override with NEXT_PUBLIC_EXAMPLES)
CALIBRATION_EXAMPLES="T1AQ-QJ5V-3|Harbour at dusk|/examples/PDSE8WYHH.jpg|demo;T1AQ-QJ5V-3|Harbour at dusk, a boat removed|/examples/PDSE8WYHH-edited-thumb.jpg|demo|/examples/PDSE8WYHH-edited.jpg"
web_env=(NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_CHAIN_ID=314159 NEXT_PUBLIC_RPC_URLS="$RPCS"
  NEXT_PUBLIC_REGISTRY_ADDRESS="$(json_get "$DEP" registry)" NEXT_PUBLIC_RESOLVER_ADDRESS="$(json_get "$DEP" resolver)"
  NEXT_PUBLIC_API_URL="$PROXY/api" NEXT_PUBLIC_VERIFY_BASE_URL="$WEB")
# the QR scanner loads public/zxing_reader.wasm, which `pnpm dev`/`pnpm build` copy and `next dev` alone does not
(cd "$EXPLORER/apps/web" && node scripts/copy-wasm.mjs)
start explorer "$EXPLORER/apps/web" env "${web_env[@]}" NEXT_PUBLIC_ORIGIN="$WEB" NEXT_PUBLIC_APP_URL="$APPURL" \
  NEXT_PUBLIC_MIRROR_URL="$PROXY/api/m" NEXT_PUBLIC_FILBEAM_PAYER="$FOC_PAYER_ADDRESS" \
  NEXT_PUBLIC_EXAMPLES="${NEXT_PUBLIC_EXAMPLES:-$CALIBRATION_EXAMPLES}" \
  ./node_modules/.bin/next dev -H 127.0.0.1 -p "$WEB_PORT"
start app "$APP/apps/web" env "${web_env[@]}" NEXT_PUBLIC_ORIGIN="$APPURL" \
  ./node_modules/.bin/next dev -H 127.0.0.1 -p "$APP_PORT"
wait_http explorer "$WEB/" 180 || die "the Explorer did not start"
wait_http app "$APPURL/" 180 || die "the app did not start"

log "up: Explorer $WEB · app (capture) $APPURL · api $PROXY/api · logs $DATA/logs"
log "Ctrl-C stops everything; Postgres data stays in the docker volume $PG_VOLUME"
while :; do sleep 3600 & wait $!; done
