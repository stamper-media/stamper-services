# services/api/src/api — custodian (ROLE=api)

The only process that holds keys. It serves the `/v1` HTTP surface (DESIGN §9.2, plan WP-07),
checks capture claims (§7.4), countersigns and relays transactions, commits originals to FOC,
binds storage and serves presentation data.

## Entry and layout
- `index.ts` `start(ctx)` loads `custodian.ts` through a dynamic import, so ROLE=worker never loads
  a module that touches keys. `startCustodian(ctx, opts)` returns `{ services, close }`.
- `routes.ts`: Hono routes, error mapping (`{ error, ...extra }`) and token-bucket rate limits (`ratelimit.ts`, 429 + Retry-After).
- `schemas.ts`: zod request and DTO schemas (`StampPresentation`). `GET /v1/openapi.json` is generated from them.
- `attest/`: `DeviceAttestation` covering the stub, App Attest (node-app-attest) and Play Integrity (googleapis) verifiers, plus `challenge.ts`.
- `captures/`: `upload.ts` handles resumable `Content-Range` uploads and tees sha256 and PieceCID into staging. `validate-claim.ts` implements §7.4. `service.ts` creates captures, accepts claims and reports status.
- `registrar.ts`: EIP-712 signatures for the countersignature, the KeyEnrolment endorsement and DerivativeAttachment.
- `chain.ts`: `Relayer`, one serialised nonce lane per key. Each tx is preflighted with estimateGas, gas gets a 1.25× buffer, and every tx is recorded in chain_txs. A receipt timeout triggers one same-nonce replacement. The receipt is re-read after REORG_DEPTH.
- `jobs.ts`: the api-role jobs register, attach, commit, bind, flag, finality (two passes per minute) and runway.
- `stamps.ts`: presentation, rendition files, `/original` (302 or a hash-checked proxy), evidence.json and withdraw.
- `mock-foc.ts`: under FOC_MODE=mock, MockFoc's onCommit calls `MockPDPVerifier.addPiece` with the relayer wallet.

## Wire contracts other packages rely on
- Stub token (ATTEST_MODE=stub only): `stub:<ios|android>:<hex sha256(binding)>`. At enrolment `binding = sha256(addr ‖ challenge)`; per capture `binding = sha256(stampId ‖ challenge)`.
- App Attest: the app passes `binding` as lowercase hex without `0x` as the challenge string to attestKey and generateAssertion.
- Play Integrity: `requestHash` may be `base64url(sha256(binding))` (plan) or `base64url(binding)` (DESIGN §7.2).
- Proof of possession: the device key signs the raw EIP-712 `KeyPossession` digest (x = y = 0 for secp256k1).
- Withdraw: the device key signs the EIP-191 text `Stamper withdraw <stampId lowercase> at <issuedAtMs>`, sent as `{ issuedAt, sig }`.
- Rendition files are read from `cachePath(cfg, stampId, "<file name>")`, for example `share.jpg`. The S3 mirror object key is `originals/<sha256 hex>`.
- The staged original stays at `uploads.path` (joined through `captures.stamp_id`). verify-upload files are written to `stagingPath(cfg, jobId)`.
- Server flags live in `stamps.flags`. Bit 0 is CAPTURE_TIME_SKEW (|capturedAt − now| > 10 min). Claim flags stay in `stamps.claim`.
- The commit job enqueues `bind` once data sets A (provisional slot 0) and B (slot 1) both have piece ids. After `StorageBound`, rows are re-keyed to the on-chain slot and one `probe` is enqueued per slot.

## Env
WP-06 config plus ATTEST_MODE, APPLE_TEAM_ID, IOS_BUNDLE_ID, APPLE_APP_ATTEST_ENV, ANDROID_PACKAGE,
ANDROID_CERT_SHA256, PLAY_CLOUD_PROJECT_NUMBER, the `*_PK_FILE` secrets (RELAYER, REGISTRAR,
FOC_SESSION, RESOLVER_OWNER), RECORD_WRAP_KEY_FILE, PLAY_SA_JSON_FILE and MAX_*.

## Tests
`pnpm --filter @stamper/api test` (or `test:anvil`) runs these files:
- `test/api/unit.test.ts`: pure unit tests.
- `test/api/http.test.ts`: needs Postgres in docker, or TEST_DATABASE_URL / DATABASE_URL.
- `test/api/flow.anvil.test.ts`: needs anvil and forge. It uses ANVIL_RPC_URL when set, otherwise it spawns anvil on a free port, runs DeployLocal into `contracts/deployments/wp07-test-<pid>.json` and deletes that file afterwards.

Each file skips with a printed reason when its prerequisites are missing.

## Stubbed or not exercised here
- The App Attest x5c chain to the Apple root comes from node-app-attest. Its root CA is hard-coded, so the tests inject a fake verifier and do not use synthetic certificates.
- Play Integrity is decoded through googleapis with PLAY_SA_JSON. The tests inject the decoder.
- Real FOC (`createFocCustodian` with the session key) needs funded keys. Only FOC_MODE=mock is exercised.
