#!/usr/bin/env bash
# Whole flow against Filecoin Calibration with real FOC (plan §WP-12). Skips cleanly (exit 0, "SKIP" line)
# when the credentials are absent. Reuses contracts/deployments/calibration.json (deploy first with
# infra/scripts/deploy-calibration.sh when it is missing). Same flow.ts and verify-independently.sh as
# run-local.sh; the web/Playwright leg is not run here (FilBeam/provider CORS is outside this stack).
#
# Required: CALIBRATION_RPC_URL RELAYER_PK REGISTRAR_PK FOC_SESSION_PK FOC_PAYER_ADDRESS
#           FOC_DATASET_A_ID FOC_DATASET_B_ID FOC_DATASET_A_PROVIDER_ID FOC_DATASET_B_PROVIDER_ID
# Optional: RESOLVER_OWNER_PK, CALIBRATION_RPC_URL_2 (second RPC), ML_URL or the services/ml venv,
#           E2E_SKIP_ML=1, E2E_SKIP_VIDEO=1, E2E_STEP_TIMEOUT_S (default 1800), E2E_OUT_DIR (default e2e/out-calibration),
#           E2E_ROLE_WAIT_S (default 0: seconds to wait for announced roles to activate);
#           flow.ts device options pass through unchanged: E2E_LOCATION, E2E_PHOTO, E2E_PLATFORM;
#           E2E_HOLD=1 (after the report, keep api, worker and Postgres up and write out/hold.env; Ctrl-C stops).
# Role pre-flight (roles.ts), before anything starts: the REGISTRAR_PK address must be an active registrar and
# the RELAYER_PK address an active binder. A role activates 48 h (ROLE_DELAY) after its announcement; while it
# is pending the script prints "SKIP … until <activation time>" and exits 0 (or waits, within E2E_ROLE_WAIT_S).
# A role that was never announced is an error (exit 1).
# Keys are written to a 0600 temp dir that is removed on exit and are never printed.
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_DIR/.." && pwd)"
OUT="${E2E_OUT_DIR:-$E2E_DIR/out-calibration}"
PG_CONTAINER="${E2E_PG_CONTAINER:-stamper-wp12-pg-calib}"
PROTOCOL="${STAMPER_PROTOCOL_DIR:-$REPO/../stamper-protocol}"
DEP="${DEPLOYMENT_JSON:-$PROTOCOL/contracts/deployments/calibration.json}"
T0=$(date +%s)
log() { printf '\033[1;34m[e2e-calib]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[e2e-calib] error:\033[0m %s\n' "$*" >&2; exit 1; }

missing=()
for k in CALIBRATION_RPC_URL RELAYER_PK REGISTRAR_PK FOC_SESSION_PK FOC_PAYER_ADDRESS \
  FOC_DATASET_A_ID FOC_DATASET_B_ID FOC_DATASET_A_PROVIDER_ID FOC_DATASET_B_PROVIDER_ID; do
  [[ -n "${!k:-}" ]] || missing+=("$k")
done
if ((${#missing[@]} > 0)); then
  echo "SKIP run-calibration: missing ${missing[*]} (no Calibration keys or FOC funds on this machine)"
  exit 0
fi
[[ -f "$DEP" ]] || die "$DEP is missing: clone stamper-protocol beside this repo (or set DEPLOYMENT_JSON)"
# the payer and deployer keys are for ceremonies only (the api refuses to start with them), so sourcing the
# owner's env files whole is safe
unset FOC_PAYER_PK DEPLOYER_PK
for b in cast docker curl node python3 ffmpeg openssl; do command -v "$b" >/dev/null || die "$b is not on PATH"; done
[[ "$(cast chain-id --rpc-url "$CALIBRATION_RPC_URL")" == 314159 ]] || die "CALIBRATION_RPC_URL is not chain 314159"

# role pre-flight: keys reach roles.ts through the environment only (bash prefix assignments, not argv)
roles_rc=0
ACTIVE_AT="$(REGISTRAR_PK="$REGISTRAR_PK" RELAYER_PK="$RELAYER_PK" env -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  RPC_URL="$CALIBRATION_RPC_URL" DEPLOYMENT_JSON="$DEP" E2E_ROLE_WAIT_S="${E2E_ROLE_WAIT_S:-0}" \
  "$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/roles.ts")" || roles_rc=$?
case $roles_rc in
0) log "roles active: registrar (REGISTRAR_PK) and binder (RELAYER_PK)" ;;
3)
  echo "SKIP run-calibration: registry roles are announced but not active until $ACTIVE_AT (48 h ROLE_DELAY); re-run after that, or set E2E_ROLE_WAIT_S to wait"
  exit 0
  ;;
*) die "role pre-flight failed (see the [roles] lines above)" ;;
esac

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
API_PORT="${E2E_API_PORT:-$(free_port)}" WORKER_PORT="${E2E_WORKER_PORT:-$(free_port)}"
PG_PORT="${E2E_PG_PORT:-$(free_port)}" ML_PORT="${E2E_ML_PORT:-$(free_port)}"
rm -rf "$OUT" && mkdir -p "$OUT/logs"
WORK="$(mktemp -d /tmp/stamper-wp12-calib-XXXXXX)"
chmod 700 "$WORK"
mkdir -p "$WORK"/{secrets,staging,cache,models}
PIDS=()
cleanup() {
  local rc=$?
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  log "elapsed $(($(date +%s) - T0)) s; logs in $OUT/logs"
  [[ $rc -eq 0 ]] && log PASS || log "FAIL (rc=$rc)"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
start() {
  local name=$1 dir=$2
  shift 2
  (cd "$dir" && exec setsid "$@") >"$OUT/logs/$name.log" 2>&1 &
  PIDS+=($!)
}
wait_http() {
  local i
  for ((i = 0; i < $3 * 2; i++)); do curl -fsS -o /dev/null -m 5 "$2" 2>/dev/null && return 0; sleep 0.5; done
  tail -25 "$OUT/logs/$1.log" >&2 || true
  return 1
}
json_get() { node -e 'const j=require(process.argv[1]);const v=j[process.argv[2]];process.stdout.write(Array.isArray(v)?v.join(","):String(v??""))' "$1" "$2"; }

docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=stamper -e POSTGRES_PASSWORD=stamper -e POSTGRES_DB=stamper \
  -p "127.0.0.1:$PG_PORT:5432" --memory 512m pgvector/pgvector:pg17 >/dev/null
for ((i = 0; i < 60; i++)); do docker exec "$PG_CONTAINER" pg_isready -U stamper -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 0.5; done

ML_URL="${ML_URL:-}"
if [[ "${E2E_SKIP_ML:-0}" != 1 && -z "$ML_URL" && -x "$REPO/services/ml/.venv/bin/python" ]]; then
  start ml "$REPO/services/ml" env ML_PORT="$ML_PORT" MODELS_DIR="$REPO/services/ml/models" \
    STAGING_DIR="$WORK/staging" ML_WATERMARK=auto ./.venv/bin/python -m app.main
  wait_http ml "http://127.0.0.1:$ML_PORT/health" 150 && ML_URL="http://127.0.0.1:$ML_PORT"
fi
[[ -n "$ML_URL" ]] || export E2E_SKIP_ML=1

umask 077
printf '%s' "$RELAYER_PK" >"$WORK/secrets/relayer_pk"
printf '%s' "$REGISTRAR_PK" >"$WORK/secrets/registrar_pk"
printf '%s' "$FOC_SESSION_PK" >"$WORK/secrets/foc_session_pk"
[[ -z "${RESOLVER_OWNER_PK:-}" ]] || printf '%s' "$RESOLVER_OWNER_PK" >"$WORK/secrets/resolver_owner_pk"
openssl rand -hex 32 >"$WORK/secrets/record_wrap_key"
umask 022
RPCS="$CALIBRATION_RPC_URL${CALIBRATION_RPC_URL_2:+,$CALIBRATION_RPC_URL_2}"
API="http://127.0.0.1:$API_PORT"
common=(DATABASE_URL="postgres://stamper:stamper@127.0.0.1:$PG_PORT/stamper" CHAIN_ID=314159 RPC_URLS="$RPCS"
  REGISTRY_ADDRESS="$(json_get "$DEP" registry)" RESOLVER_ADDRESS="$(json_get "$DEP" resolver)"
  PDP_VERIFIER_ADDRESS="$(json_get "$DEP" pdpVerifier)" FWSS_ADDRESS="$(json_get "$DEP" fwss)"
  FOC_MODE=real FOC_CHAIN_ID=314159 FOC_RPC_URL="$CALIBRATION_RPC_URL" FOC_PAYER_ADDRESS="$FOC_PAYER_ADDRESS"
  FOC_DATASET_A_ID="$FOC_DATASET_A_ID" FOC_DATASET_B_ID="$FOC_DATASET_B_ID"
  FOC_DATASET_A_PROVIDER_ID="$FOC_DATASET_A_PROVIDER_ID" FOC_DATASET_B_PROVIDER_ID="$FOC_DATASET_B_PROVIDER_ID"
  ATTEST_MODE=stub STAGING_DIR="$WORK/staging" CACHE_DIR="$WORK/cache" MODELS_DIR="$WORK/models"
  PUBLIC_BASE_URL="$API" VERIFY_BASE_URL="$API" LOG_LEVEL="${E2E_LOG_LEVEL:-info}" HOST=127.0.0.1)
secrets=(RELAYER_PK_FILE="$WORK/secrets/relayer_pk" REGISTRAR_PK_FILE="$WORK/secrets/registrar_pk"
  FOC_SESSION_PK_FILE="$WORK/secrets/foc_session_pk" RECORD_WRAP_KEY_FILE="$WORK/secrets/record_wrap_key")
[[ -z "${RESOLVER_OWNER_PK:-}" ]] || secrets+=(RESOLVER_OWNER_PK_FILE="$WORK/secrets/resolver_owner_pk")
TSX="$REPO/services/api/node_modules/.bin/tsx"
start api "$REPO/services/api" env -u RELAYER_PK -u REGISTRAR_PK -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  "${common[@]}" "${secrets[@]}" ROLE=api PORT="$API_PORT" "$TSX" src/main.ts
wait_http api "$API/healthz" 120 || die "api did not start"
start worker "$REPO/services/api" env -u RELAYER_PK -u REGISTRAR_PK -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  "${common[@]}" ${ML_URL:+ML_URL=$ML_URL} ROLE=worker PORT="$WORKER_PORT" "$TSX" src/main.ts
wait_http worker "http://127.0.0.1:$WORKER_PORT/healthz" 120 || die "worker did not start"

LEGS=()
flow_rc=0
env -u RELAYER_PK -u REGISTRAR_PK -u FOC_SESSION_PK -u RESOLVER_OWNER_PK \
  API_URL="$API" RPC_URL="$CALIBRATION_RPC_URL" DEPLOYMENT_JSON="$DEP" E2E_OUT_DIR="$OUT" E2E_MODE=calibration \
  E2E_STEP_TIMEOUT_S="${E2E_STEP_TIMEOUT_S:-1800}" \
  "$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/flow.ts" 2>&1 | tee "$OUT/logs/flow.log" || flow_rc=$?
[[ -f "$OUT/flow.json" ]] || die "flow.ts wrote no flow.json"
if [[ -f "$OUT/flow.env" ]]; then
  # shellcheck disable=SC1091
  . "$OUT/flow.env"
  if RPC="$CALIBRATION_RPC_URL" REG="$(json_get "$DEP" registry)" PDP="$(json_get "$DEP" pdpVerifier)" \
    FWSS="$(json_get "$DEP" fwss)" CODE="$STAMP_CODE" PROVIDER_URL="$STAMP_PROVIDER_URL" OUT_DIR="$WORK/indep" \
    "$E2E_DIR/verify-independently.sh" 2>&1 | tee "$OUT/logs/verify-independently.log"; then
    LEGS+=(--leg "verify-independently=pass:cast/curl recipe on Calibration")
  else
    LEGS+=(--leg "verify-independently=fail:see logs/verify-independently.log")
  fi
fi
LEGS+=(--leg "playwright=skip:not run on Calibration")
"$E2E_DIR/node_modules/.bin/tsx" "$E2E_DIR/report.ts" "$OUT/flow.json" "${LEGS[@]}"

# ── hold (E2E_HOLD=1): keep api, worker and Postgres up so a web page can show the stamp's record; Ctrl-C stops ──
if [[ "${E2E_HOLD:-0}" == 1 && -n "${STAMP_CODE:-}" ]]; then
  printf 'STAMP_CODE=%s\nAPI=%s\n' "$STAMP_CODE" "$API" >"$OUT/hold.env"
  log "holding: stamp $STAMP_CODE, api $API; Ctrl-C to stop"
  trap 'exit 0' INT TERM # the verdict is the report above; stopping the hold is not a failure
  while :; do sleep 3600 & wait $!; done
fi
