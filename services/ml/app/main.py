"""FastAPI app: /health, /watermark/{encode,decode}, /pdq, /pdq/batch, /ssim.

Every image endpoint takes either multipart uploads or a JSON body naming files
on the shared staging volume (`{"path": ...}`, `{"paths": [...]}`, `{"a":..., "b":...}`).
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Tuple

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from . import __version__
from .config import Settings
from .errors import InvalidInput, MlError, TooLarge
from .images import load_rgb, read_path_bytes, to_jpeg
from .pdq import pdq_hash
from .ssim import ssim
from .watermark import SCHEMA, PAYLOAD_BITS, WatermarkEngine, build_engine, parse_payload

log = logging.getLogger("stamper.ml")

Fields = Dict[str, Any]


class _Inputs:
    """Parsed request: named image byte blobs (lists for repeated fields) plus scalar fields."""

    def __init__(self) -> None:
        self.files: Dict[str, List[bytes]] = {}
        self.fields: Fields = {}

    def one(self, name: str) -> bytes:
        blobs = self.files.get(name) or []
        if len(blobs) != 1:
            raise InvalidInput(f"exactly one '{name}' image is required")
        return blobs[0]


async def _read_upload(up: UploadFile, limit: int) -> bytes:
    data = await up.read(limit + 1)
    if len(data) > limit:
        raise TooLarge("upload exceeds MAX_UPLOAD_BYTES")
    return data


async def _parse(request: Request, s: Settings, path_keys: Dict[str, str]) -> _Inputs:
    """`path_keys` maps JSON key -> file name; a key ending in 's' holding a list yields many."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > s.max_upload_bytes * 2:
        raise TooLarge("request body too large")
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    out = _Inputs()
    if ctype == "application/json":
        try:
            body = json.loads(await request.body())
        except ValueError as exc:
            raise InvalidInput("body is not valid JSON") from exc
        if not isinstance(body, dict):
            raise InvalidInput("JSON body must be an object")
        for key, fname in path_keys.items():
            if key not in body:
                continue
            val = body[key]
            paths = val if isinstance(val, list) else [val]
            if isinstance(val, list) and len(val) > s.max_batch:
                raise InvalidInput(f"at most {s.max_batch} paths per request")
            blobs = [
                await run_in_threadpool(read_path_bytes, p, s.staging_dir, s.max_upload_bytes)
                for p in paths
            ]
            out.files.setdefault(fname, []).extend(blobs)
        out.fields = {k: v for k, v in body.items() if k not in path_keys}
        return out
    if ctype == "multipart/form-data":
        try:
            form = await request.form(max_files=s.max_batch + 2, max_fields=16)
        except Exception as exc:
            raise InvalidInput(f"cannot parse multipart body: {exc}") from exc
        try:
            for key, val in form.multi_items():
                if isinstance(val, UploadFile):
                    name = key[:-2] if key.endswith("[]") else key
                    out.files.setdefault(name, []).append(
                        await _read_upload(val, s.max_upload_bytes)
                    )
                else:
                    out.fields[key] = val
        finally:
            await form.close()
        return out
    raise InvalidInput("content-type must be multipart/form-data or application/json")


def _strength(fields: Fields, default: float) -> float:
    raw = fields.get("strength")
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise InvalidInput("strength must be a number") from exc
    if not 0.05 <= value <= 4.0:
        raise InvalidInput("strength must be in [0.05, 4.0]")
    return value


def create_app(
    settings: Optional[Settings] = None, engine: Optional[WatermarkEngine] = None
) -> FastAPI:
    s = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        torch.set_num_threads(s.torch_num_threads)
        app.state.engine = engine if engine is not None else build_engine(s)
        log.info("ml ready: watermark=%s threads=%d", app.state.engine.name, s.torch_num_threads)
        yield

    app = FastAPI(title="stamper-ml", version=__version__, lifespan=lifespan)

    @app.exception_handler(MlError)
    async def _ml_error(_req: Request, exc: MlError) -> JSONResponse:
        return JSONResponse({"error": exc.code, "detail": exc.detail}, status_code=exc.status)

    def _engine(request: Request) -> WatermarkEngine:
        return request.app.state.engine

    @app.get("/health")
    async def health(request: Request) -> Dict[str, Any]:
        eng = _engine(request)
        return {
            "ok": True,
            "models": list(eng.models),
            "watermark": eng.name,
            "torch_threads": torch.get_num_threads(),
        }

    @app.post("/watermark/encode")
    async def wm_encode(request: Request) -> Response:
        inp = await _parse(request, s, {"path": "image"})
        payload = parse_payload(inp.fields.get("payload"))
        strength = _strength(inp.fields, s.trustmark_strength)
        data = inp.one("image")
        eng = _engine(request)

        def work() -> bytes:
            img = load_rgb(data, s.max_image_pixels)
            icc = img.info.get("icc_profile")
            return to_jpeg(eng.encode(img, payload, strength), s.jpeg_quality, icc)

        out = await run_in_threadpool(work)
        return Response(
            content=out,
            media_type="image/jpeg",
            headers={
                "X-Trustmark-Version": eng.version,
                "X-Payload": str(payload),
                "X-Strength": repr(strength),
            },
        )

    @app.post("/watermark/decode")
    async def wm_decode(request: Request) -> Dict[str, Any]:
        inp = await _parse(request, s, {"path": "image"})
        data = inp.one("image")
        eng = _engine(request)

        def work() -> Optional[int]:
            return eng.decode(load_rgb(data, s.max_image_pixels))

        found = await run_in_threadpool(work)
        return {
            "ok": found is not None,
            "payload": None if found is None else str(found),
            "schema": SCHEMA,
            "bits": PAYLOAD_BITS,
        }

    def _hash_one(data: bytes) -> Tuple[str, int]:
        return pdq_hash(load_rgb(data, s.max_image_pixels))

    @app.post("/pdq")
    async def pdq(request: Request) -> Dict[str, Any]:
        inp = await _parse(request, s, {"path": "image"})
        h, q = await run_in_threadpool(_hash_one, inp.one("image"))
        return {"hash": h, "quality": q}

    @app.post("/pdq/batch")
    async def pdq_batch(request: Request) -> List[Dict[str, Any]]:
        inp = await _parse(request, s, {"paths": "images"})
        blobs = inp.files.get("images") or []
        if not blobs:
            raise InvalidInput("at least one image is required in 'images'")
        if len(blobs) > s.max_batch:
            raise InvalidInput(f"at most {s.max_batch} images per request")
        out = []
        for i, blob in enumerate(blobs):
            h, q = await run_in_threadpool(_hash_one, blob)
            out.append({"index": i, "hash": h, "quality": q})
        return out

    @app.post("/ssim")
    async def ssim_ep(request: Request) -> Dict[str, Any]:
        inp = await _parse(request, s, {"a": "a", "b": "b"})
        a, b = inp.one("a"), inp.one("b")

        def work() -> float:
            return ssim(load_rgb(a, s.max_image_pixels), load_rgb(b, s.max_image_pixels))

        return {"ssim": await run_in_threadpool(work)}

    return app




def run() -> None:  # pragma: no cover - process entry point
    import uvicorn

    s = Settings.from_env()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(create_app(s), host="0.0.0.0", port=s.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    run()
