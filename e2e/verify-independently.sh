#!/usr/bin/env bash
# The independent-verification recipe of DESIGN §8.3 / docs/verify-independently.md, executed:
# chain reads with cast, the original fetched with curl, re-hashed with sha256sum and PieceCID.
# No Stamper server is trusted for any verdict input.
#
# Env (required): RPC, REG (StampRegistry), PDP (PDPVerifier), FWSS (expected data-set listener), CODE
# Env (one of):   PROVIDER_URL (SP serviceURL, fetched as {PROVIDER_URL}/piece/<cid>)
#                 FILBEAM_BASE (https://<payer>.filbeam.io or calibration.filbeam.io equivalent)
# Env (optional): GENESIS (unix time of epoch 0; default by chain id), OUT_DIR (default mktemp)
# Exits 0 only when every check holds; prints one "ok"/"FAIL" line per check.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for v in RPC REG PDP FWSS CODE; do [[ -n "${!v:-}" ]] || { echo "error: $v is required" >&2; exit 2; }; done
[[ -n "${PROVIDER_URL:-}${FILBEAM_BASE:-}" ]] || { echo "error: PROVIDER_URL or FILBEAM_BASE is required" >&2; exit 2; }
command -v cast >/dev/null && command -v curl >/dev/null && command -v sha256sum >/dev/null ||
  { echo "error: needs cast, curl, sha256sum" >&2; exit 2; }
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUT_DIR"
fails=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
check() { if [[ "$(tr A-F a-f <<<"$2")" == "$(tr A-F a-f <<<"$3")" ]]; then ok "$1"; else bad "$1: got $2, want $3"; fi; }
c() { cast call --rpc-url "$RPC" "$@"; }
# cast prints tuples as "(a, b [1.2e3], c)": drop the annotations and parens, one field per line
fields() { sed -E 's/ \[[^]]*\]//g; s/^\(//; s/\)$//' <<<"$1" | sed 's/, /\n/g'; }

# 1. code → 40-bit value → stampId
ALPHA=0123456789ABCDEFGHJKMNPQRSTVWXYZ
code="$(tr a-z A-Z <<<"$CODE" | tr -d ' -' | tr IL 11 | tr O 0)"
[[ ${#code} -eq 9 ]] || { echo "error: CODE must have 9 symbols" >&2; exit 2; }
val=0
for ((i = 0; i < 8; i++)); do
  ch="${code:i:1}"; idx="${ALPHA%%"$ch"*}"
  [[ ${#idx} -lt 32 ]] || { echo "error: bad symbol $ch" >&2; exit 2; }
  val=$(((val << 5) | ${#idx}))
done
CHECKS="${ALPHA}*~\$=U"
[[ "${CHECKS:$((val % 37)):1}" == "${code:8:1}" ]] && ok "check symbol of $code" || bad "check symbol of $code"
echo "1. stampByCode($val)"
ID="$(c "$REG" "stampByCode(uint40)(bytes32)" "$val")"
[[ "$ID" != 0x0000000000000000000000000000000000000000000000000000000000000000 ]] && ok "stampId $ID" ||
  { bad "code $code is not registered"; exit 1; }

# 2. getStamp / getKey / getBindings
echo "2. getStamp, getKey, getBindings"
mapfile -t S < <(fields "$(c "$REG" "getStamp(bytes32)((bytes32,bytes,uint64,uint8,uint64,bytes32,bytes32,uint64,uint8,uint8,address,uint64,uint40,bytes,bytes))" "$ID")")
contentHash=${S[0]} pieceCid=${S[1]} contentLength=${S[2]} mediaKind=${S[3]} capturedAt=${S[4]} recordHash=${S[5]}
keyId=${S[6]} nonce=${S[7]} flags=${S[8]} level=${S[9]} countersigner=${S[10]} registeredEpoch=${S[11]} sig=${S[13]} authData=${S[14]}
echo "   contentHash $contentHash  pieceCid $pieceCid  level $level  countersigner $countersigner  epoch $registeredEpoch"
mapfile -t K < <(fields "$(c "$REG" "getKey(bytes32)((uint8,uint8,uint8,bytes32,bytes32,address,bytes32,bytes32,address,uint64,uint64,uint64,uint8))" "$keyId")")
keyType=${K[0]} keyAddr=${K[5]} registrar=${K[8]} revokedEpoch=${K[11]}
echo "   key $keyId type $keyType addr $keyAddr registrar $registrar revokedEpoch $revokedEpoch"
binds="$(c "$REG" "getBindings(bytes32)((uint8,uint256,uint256,address,address,uint64,bool)[])" "$ID")"

# 3. EIP-712 digest from the claim fields (deadline is derived: capturedAt/1000 + 1 h, or 72 h offline)
echo "3. claim digest and device signature"
chainId="$(cast chain-id --rpc-url "$RPC")"
DOMAIN_TH="$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")"
CLAIM_TH="$(cast keccak "CaptureClaim(bytes32 contentHash,bytes pieceCid,uint64 contentLength,uint8 mediaKind,uint64 capturedAt,bytes32 recordHash,bytes32 keyId,uint64 nonce,uint8 flags,uint64 deadline)")"
check "CLAIM_TYPEHASH" "$CLAIM_TH" 0xe768d8433c9f9a1f6a4b35ee02435838088f38c938fc215e2ce68b78116c010d
if (((flags & 2) != 0)); then win=259200; else win=3600; fi
deadline=$((capturedAt / 1000 + win))
domSep="$(cast keccak "$(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" "$DOMAIN_TH" "$(cast keccak Stamper)" "$(cast keccak 1)" "$chainId" "$REG")")"
structHash="$(cast keccak "$(cast abi-encode "f(bytes32,bytes32,bytes32,uint64,uint8,uint64,bytes32,bytes32,uint64,uint8,uint64)" \
  "$CLAIM_TH" "$contentHash" "$(cast keccak "$pieceCid")" "$contentLength" "$mediaKind" "$capturedAt" "$recordHash" "$keyId" "$nonce" "$flags" "$deadline")")"
digest="$(cast keccak "0x1901${domSep:2}${structHash:2}")"
check "digest == stampId" "$digest" "$ID"
if [[ "$keyType" == 0 ]]; then
  # secp256k1: recover r ‖ s ‖ v over the raw digest locally (noble via core). Not an eth_call to the ecrecover
  # precompile: FEVM answers a direct call to 0x01 with empty data (precompiles are reachable only from contracts)
  k1="$(cd "$here" && node --input-type=module -e "
    import { verifyDeviceSignature } from '@stamper/core';
    const [addr, d, s] = process.argv.slice(1);
    process.stdout.write(String(verifyDeviceSignature({ keyType: 0, addr }, d, s, '0x', 0n)));" \
    "$keyAddr" "$digest" "$sig")"
  check "secp256k1 signature recovers to key addr" "$k1" true
elif [[ "$keyType" == 1 || "$keyType" == 2 ]]; then
  # P-256 raw: sig over sha256(digest); App Attest: over sha256(authData ‖ sha256(digest)) (noble P-256 via core)
  p256="$(cd "$here" && node --input-type=module -e "
    import { verifyDeviceSignature } from '@stamper/core';
    const [kt, x, y, rp, d, s, a, n] = process.argv.slice(1);
    process.stdout.write(String(verifyDeviceSignature({ keyType: Number(kt), x, y, rpIdHash: rp }, d, s, a, BigInt(n))));" \
    "$keyType" "${K[3]}" "${K[4]}" "${K[6]}" "$digest" "$sig" "$authData" "$nonce")"
  check "P-256 signature (key type $keyType) over digest" "$p256" true
elif [[ "$keyType" == 3 ]]; then
  check "ERC-1271 isValidSignature(digest, sig)" "$(c "$keyAddr" "isValidSignature(bytes32,bytes)(bytes4)" "$digest" "$sig")" 0x1626ba7e
else
  bad "unknown key type $keyType"
fi

# 4. per binding: PDPVerifier + FWSS listener + StateView
echo "4. storage bindings"
VIEW="$(c "$FWSS" "viewContractAddress()(address)")"
nb=0
while read -r t; do
  [[ -n "$t" ]] || continue
  mapfile -t B < <(fields "$t")
  set_id=${B[1]} piece=${B[2]} trusted=${B[6]}
  [[ "$set_id" != 0 ]] || continue
  nb=$((nb + 1))
  echo "   set $set_id piece $piece provider ${B[3]} trusted $trusted"
  check "dataSetLive($set_id)" "$(c "$PDP" "dataSetLive(uint256)(bool)" "$set_id")" true
  check "pieceLive($set_id,$piece)" "$(c "$PDP" "pieceLive(uint256,uint256)(bool)" "$set_id" "$piece")" true
  check "getPieceCid($set_id,$piece) == pieceCid" "$(c "$PDP" "getPieceCid(uint256,uint256)((bytes))" "$set_id" "$piece" | tr -d '()')" "$pieceCid"
  check "getDataSetListener($set_id) == FWSS" "$(c "$PDP" "getDataSetListener(uint256)(address)" "$set_id")" "$FWSS"
  echo "   provenThisPeriod $(c "$VIEW" "provenThisPeriod(uint256)(bool)" "$set_id")  provingDeadline $(c "$VIEW" "provingDeadline(uint256)(uint256)" "$set_id" | sed -E 's/ \[.*//')"
done < <(grep -oE '\([^()]*\)' <<<"$binds")
((nb >= 1)) && ok "$nb storage binding(s)" || bad "no storage bindings yet"

# 5–6. fetch the original from a storage provider (or FilBeam) and re-hash
echo "5. fetch the original"
cid_text="$(cd "$here" && node --input-type=module -e "
  import { pieceCidString, parsePieceCid } from '@stamper/core';
  process.stdout.write(pieceCidString(parsePieceCid(process.argv[1])));" "$pieceCid")"
if [[ -n "${PROVIDER_URL:-}" ]]; then url="${PROVIDER_URL%/}/piece/$cid_text"; else url="${FILBEAM_BASE%/}/$cid_text"; fi
curl -fsS -o "$OUT_DIR/original.bin" "$url" && ok "GET $url ($(wc -c <"$OUT_DIR/original.bin") bytes)" || { bad "GET $url"; exit 1; }
echo "6. re-hash"
check "sha256(original) == contentHash" "0x$(sha256sum "$OUT_DIR/original.bin" | cut -d' ' -f1)" "$contentHash"
got_cid="$(cd "$here" && node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { pieceCidOf, pieceCidHex } from '@stamper/core';
  process.stdout.write(pieceCidHex(await pieceCidOf(new Uint8Array(readFileSync(process.argv[1])))));" "$OUT_DIR/original.bin")"
check "PieceCID(original) == pieceCid" "$got_cid" "$pieceCid"
check "contentLength" "$(wc -c <"$OUT_DIR/original.bin" | tr -d ' ')" "$contentLength"

# 7. registration time and finality
echo "7. time"
case "$chainId" in
  314) GENESIS="${GENESIS:-1598306400}" ;;
  314159) GENESIS="${GENESIS:-1667326380}" ;;
esac
if [[ -n "${GENESIS:-}" ]]; then
  echo "   registered $(date -u -d @$((GENESIS + 30 * registeredEpoch)) +%FT%TZ) (epoch $registeredEpoch)"
else
  echo "   registered $(date -u -d @"$(cast block "$registeredEpoch" -f timestamp --rpc-url "$RPC")" +%FT%TZ) (block $registeredEpoch, chain $chainId)"
fi
fin="$(cast block finalized -f number --rpc-url "$RPC" 2>/dev/null || echo "?")"
echo "   finalized head $fin; stamp block $registeredEpoch"

if ((fails > 0)); then echo "verify-independently: $fails check(s) failed"; exit 1; fi
echo "verify-independently: all checks hold for $code"
