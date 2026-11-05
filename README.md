# stamper-services

The server side of Stamper: the custodian **api** and the key-free **worker** (one image,
`ROLE=api|worker`), the **ml** sidecar (TrustMark watermark, PDQ perceptual hash), and the whole-flow
**e2e** scripts that run capture → chain → Filecoin → check, locally and on Calibration.

## Stamper repos

| Repo | What |
|---|---|
| [stamper-protocol](https://github.com/stamper-media/stamper-protocol) | FEVM contracts, the shared `@stamper/*` packages (npm), infra and design docs |
| [stamper-services](https://github.com/stamper-media/stamper-services) | custodian api + worker, ml sidecar, whole-flow e2e |
| [stamper-app](https://github.com/stamper-media/stamper-app) | stamp from the browser (web) and the phone (iOS, Android) |
| [stamper-explorer](https://github.com/stamper-media/stamper-explorer) | the public check site: stamp pages, QR, compare, check a file |

Clone them side by side (`stamper-protocol/`, `stamper-services/`, … in one folder): scripts that need
another repo look for it there, or in `STAMPER_<NAME>_DIR`.

## What is here

| Path | What |
|---|---|
| `services/api` | `@stamper/api`: relayer, registrar, FOC commit/bind (`ROLE=api`); ingest, marking, storage, probes (`ROLE=worker`) |
| `services/ml` | Python sidecar: TrustMark Q + PDQ (`make venv`, weights fetched by `scripts/fetch-weights.py`) |
| `e2e/` | `run-local.sh` (anvil + mocks), `run-calibration.sh`, `stack-calibration.sh` (a running testnet stack) |

## Commands

```sh
pnpm install
pnpm build && pnpm test          # api tests use Docker Postgres
pnpm lint && pnpm typecheck
pnpm test:ml                     # pytest in services/ml (venv first)
pnpm e2e:local                   # needs stamper-protocol (and stamper-explorer for the web leg) beside this repo
pnpm stack:calibration           # api + worker + ml + Postgres on Calibration, with the app and Explorer
```

`stack:calibration` uses the owner's testnet keys
(`set -a; . ~/.config/stamper/calibration.env; . ~/.config/stamper/calibration-foc.env; set +a`) and
starts the Explorer on http://localhost:13310 and the app (browser capture) on http://localhost:13311.

## @stamper/* packages

They come from npm once `stamper-protocol` publishes them. Until then they install from `vendor/*.tgz`
(see the `overrides` in `pnpm-workspace.yaml`); `scripts/sync-protocol.sh --pack` rebuilds them from a
protocol checkout beside this repo.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
