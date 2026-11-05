#!/usr/bin/env bash
# Refreshes vendor/ with the @stamper/* tarballs packed by stamper-protocol, then reinstalls.
# Needed only until the packages are published on npm (see the overrides in pnpm-workspace.yaml).
#   scripts/sync-protocol.sh                    # protocol checkout beside this repo
#   STAMPER_PROTOCOL_DIR=/path scripts/sync-protocol.sh
#   scripts/sync-protocol.sh --pack             # also build and pack in the protocol repo first
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTOCOL="${STAMPER_PROTOCOL_DIR:-$ROOT/../stamper-protocol}"
[[ -d "$PROTOCOL/packages" ]] || { echo "stamper-protocol not found at $PROTOCOL (set STAMPER_PROTOCOL_DIR)" >&2; exit 1; }
if [[ "${1:-}" == --pack ]]; then (cd "$PROTOCOL" && pnpm install --frozen-lockfile && node scripts/pack-packages.mjs); fi
[[ -d "$PROTOCOL/.packs" ]] || { echo "no $PROTOCOL/.packs: run 'node scripts/pack-packages.mjs' there (or pass --pack)" >&2; exit 1; }
mkdir -p "$ROOT/vendor"
for f in $(sed -n 's/.*file:\.\/vendor\/\(stamper-[a-z-]*\.tgz\).*/\1/p' "$ROOT/pnpm-workspace.yaml"); do
  cp "$PROTOCOL/.packs/$f" "$ROOT/vendor/$f"
  echo "vendor/$f"
done
cd "$ROOT" && pnpm install --no-frozen-lockfile
