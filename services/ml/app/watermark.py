"""TrustMark Q `BCH_SUPER` watermark engine (40-bit payload) and the null fallback.

Weights are read from MODELS_DIR only and checked against the md5 list shipped
with the `trustmark` package; nothing is ever downloaded at request time.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from typing import Dict, List, Optional, Tuple

from PIL import Image

from .config import Settings
from .errors import InvalidInput

log = logging.getLogger("stamper.ml.watermark")

PAYLOAD_BITS = 40
PAYLOAD_LIMIT = 1 << PAYLOAD_BITS
SCHEMA = "BCH_SUPER"
TRUSTMARK_PKG_VERSION = "0.9.2"


class WeightsMissing(RuntimeError):
    pass


def parse_payload(raw: object) -> int:
    """Validate a decimal-string payload in [0, 2^40)."""
    if isinstance(raw, bool) or raw is None:
        raise InvalidInput("payload is required (decimal string < 2^40)")
    text = str(raw).strip()
    if not text.isdigit() or not text.isascii() or len(text) > 13:
        raise InvalidInput("payload must be a decimal string < 2^40")
    value = int(text, 10)
    if value >= PAYLOAD_LIMIT:
        raise InvalidInput("payload must be < 2^40")
    return value


def payload_to_bits(value: int) -> str:
    return format(value, f"0{PAYLOAD_BITS}b")


def bits_to_payload(bits: str) -> int:
    return int(bits, 2)


def required_files(variant: str) -> List[str]:
    return [f"trustmark_{variant}.yaml", f"encoder_{variant}.ckpt", f"decoder_{variant}.ckpt"]


def expected_checksums() -> Dict[str, str]:
    from trustmark import trustmark as tm_mod

    return dict(tm_mod.MODEL_CHECKSUMS)


def md5_file(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def weights_status(models_dir: str, variant: str) -> Tuple[bool, List[str]]:
    """Return (all present and valid, problems)."""
    sums = expected_checksums()
    problems = []
    for name in required_files(variant):
        path = os.path.join(models_dir, name)
        if not os.path.isfile(path):
            problems.append(f"missing {name}")
        elif md5_file(path) != sums.get(name):
            problems.append(f"bad checksum {name}")
    return (not problems, problems)


class WatermarkEngine:
    """Interface shared by the TrustMark engine and the null engine."""

    name = "null"
    models: List[str] = []

    @property
    def version(self) -> str:
        return "null"

    def encode(self, img: Image.Image, payload: int, strength: float) -> Image.Image:
        raise NotImplementedError

    def decode(self, img: Image.Image) -> Optional[int]:
        raise NotImplementedError


class NullWatermark(WatermarkEngine):
    """No-op engine used when TrustMark weights are unavailable: encode returns the
    image unchanged and decode never finds a payload. `/health` reports it."""

    name = "null"
    models: List[str] = []

    def encode(self, img: Image.Image, payload: int, strength: float) -> Image.Image:
        return img

    def decode(self, img: Image.Image) -> Optional[int]:
        return None


class TrustMarkEngine(WatermarkEngine):
    name = "trustmark"

    def __init__(self, models_dir: str, variant: str = "Q", device: str = "cpu") -> None:
        ok, problems = weights_status(models_dir, variant)
        if not ok:
            raise WeightsMissing(f"TrustMark {variant} weights unusable in {models_dir}: {problems}")
        from trustmark import TrustMark

        models_dir_abs = os.path.abspath(models_dir)

        class _LocalTrustMark(TrustMark):  # type: ignore[misc, valid-type]
            def load_model(self, config_path, weight_path, device, secret_len, part="all"):
                return super().load_model(
                    os.path.join(models_dir_abs, os.path.basename(config_path)),
                    os.path.join(models_dir_abs, os.path.basename(weight_path)),
                    device,
                    secret_len,
                    part=part,
                )

            def check_and_download(self, filename):
                if not os.path.isfile(filename):
                    raise WeightsMissing(f"missing {filename}")

        self._tm = _LocalTrustMark(
            verbose=False,
            model_type=variant,
            encoding_type=TrustMark.Encoding.BCH_SUPER,
            use_ECC=True,
            device=device,
            loadRemover=False,
            loadBBoxDetector=False,
        )
        if self._tm.encoder is None or self._tm.decoder is None:
            raise WeightsMissing("TrustMark failed to load encoder/decoder")
        capacity = self._tm.schemaCapacity()
        if capacity < PAYLOAD_BITS:
            raise RuntimeError(f"schema capacity {capacity} < {PAYLOAD_BITS}")
        self._capacity = capacity
        self._lock = threading.Lock()
        self.variant = variant
        self.models = [f"trustmark-{variant}"]

    @property
    def version(self) -> str:
        return f"trustmark/{TRUSTMARK_PKG_VERSION}/{self.variant}/{SCHEMA}"

    def encode(self, img: Image.Image, payload: int, strength: float) -> Image.Image:
        if not 0 <= payload < PAYLOAD_LIMIT:
            raise InvalidInput("payload must be < 2^40")
        bits = payload_to_bits(payload).rjust(self._capacity, "0")
        with self._lock:
            return self._tm.encode(img, bits, MODE="binary", WM_STRENGTH=strength)

    def decode(self, img: Image.Image) -> Optional[int]:
        with self._lock:
            secret, detected, _version = self._tm.decode(img, MODE="binary")
        if not detected or not secret:
            return None
        bits = str(secret)
        if len(bits) > PAYLOAD_BITS and set(bits[: len(bits) - PAYLOAD_BITS]) - {"0"}:
            return None
        return bits_to_payload(bits[-PAYLOAD_BITS:])


def build_engine(settings: Settings) -> WatermarkEngine:
    if settings.watermark_mode == "null":
        log.warning("ML_WATERMARK=null: watermark encode is a no-op, decode never finds a payload")
        return NullWatermark()
    try:
        return TrustMarkEngine(settings.models_dir, settings.trustmark_variant)
    except WeightsMissing as exc:
        if settings.watermark_mode == "trustmark":
            raise
        log.warning("falling back to the null watermark: %s", exc)
        return NullWatermark()
