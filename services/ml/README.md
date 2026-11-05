# services/ml — TrustMark + PDQ sidecar

The only Python in Stamper. It runs TrustMark Q `BCH_SUPER` watermarking with a 40-bit payload (the stamp code), PDQ perceptual hashing and an optional SSIM endpoint. It holds no secrets and has no chain or DB access. Weights load once at start-up from `MODELS_DIR` and are checked against the md5 list in `trustmark` 0.9.2. They are never fetched at request time.

## HTTP API
| Method / path | Input | Output |
|---|---|---|
| `GET /health` | none | `{ ok, models: ["trustmark-Q"], watermark: "trustmark"\|"null", torch_threads }` |
| `POST /watermark/encode` | `image` file + `payload` (decimal string < 2^40) + optional `strength` (0.05–4, default `TRUSTMARK_STRENGTH`) | `image/jpeg` (q `ML_JPEG_QUALITY`, 4:4:4). Headers `X-Trustmark-Version` (`trustmark/0.9.2/Q/BCH_SUPER`, or `null`), `X-Payload`, `X-Strength` |
| `POST /watermark/decode` | `image` | `{ ok, payload: "123"\|null, schema: "BCH_SUPER", bits: 40 }` |
| `POST /pdq` | `image` | `{ hash: "<64 hex>", quality }` |
| `POST /pdq/batch` | `images` (repeated; `images[]` is also accepted) | `[{ index, hash, quality }]` |
| `POST /ssim` | `a`, `b` (same size) | `{ ssim }` |

Every endpoint takes either multipart uploads or a JSON body that points at files on the shared staging volume: `{"path": "...", "payload": "..."}`, `{"paths": [...]}` or `{"a": "...", "b": "..."}`. Relative paths resolve against `STAGING_DIR`, and anything outside it is refused.

Errors come back as `{error, detail}`:
- 422: invalid input or payload
- 413: too many pixels or bytes
- 403: path outside staging
- 404: missing path

PDQ hex uses the ThreatExchange layout: sixteen 16-bit words, printed from word 15 down to word 0, where bit *k* is in word *k*/16. Note `pdqhash.compute` returns the bit vector reversed (element 0 is bit 255); `app/pdq.py` handles that. Images are EXIF-rotated before hashing and watermarking.

## Env
| Variable | Default |
|---|---|
| `ML_PORT` | `8000` |
| `MODELS_DIR` | `/models` |
| `TRUSTMARK_VARIANT` | `Q` |
| `TRUSTMARK_SCHEMA` | `BCH_SUPER` |
| `TRUSTMARK_STRENGTH` | `1.0` |
| `TORCH_NUM_THREADS` | `4` |
| `STAGING_DIR` | `/srv/staging` |
| `MAX_IMAGE_PIXELS` | `50000000` |
| `MAX_UPLOAD_BYTES` | `209715200` |
| `ML_MAX_BATCH` | `32` |
| `ML_JPEG_QUALITY` | `95` |
| `ML_WATERMARK` | `auto` (the image sets `trustmark`) |

`ML_WATERMARK` takes one of three values:
- `auto`: use TrustMark if the weights are valid, otherwise use the null watermark.
- `trustmark`: refuse to start without valid weights.
- `null`: always use the null watermark.

The **null watermark** returns the image unchanged as a JPEG, and its decode always gives `ok:false`. With it, the pipeline can run before the weights are mirrored. `/health` reports `watermark:"null"` and `models:[]`.

## Run / test (host, python 3.10)
```
virtualenv --system-site-packages .venv   # host lacks ensurepip; the system torch 2.10 CPU is reused
.venv/bin/pip install trustmark==0.9.2 pdqhash fastapi "uvicorn[standard]" python-multipart scikit-image pytest httpx
.venv/bin/pip install --no-deps torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cpu  # keep pip from pulling CUDA torch
.venv/bin/python scripts/fetch-weights.py      # -> ./models (TRUSTMARK_WEIGHTS_URL = our mirror, else the Adobe CDN)
.venv/bin/python -m pytest -q                  # tests that need the real model skip with a visible reason when ./models is empty
ML_PORT=<free port> MODELS_DIR=models STAGING_DIR=/tmp .venv/bin/python -m app.main
```
Docker (python 3.12): `make image` (weights are fetched at build time; use `--build-arg FETCH_WEIGHTS=0` and mount `/models` to skip that), and `make test-docker` runs pytest inside the image.

## Stubbed / not here
- Nothing in this service is stubbed.
- The ONNX export fallback for weights is documented but not implemented. It is only needed if the CDN starts refusing again (see `docs/spikes/trustmark.md`).
- The browser decoder is v1.
