"""Environment-driven settings for the ml sidecar (read once at start-up)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional

WATERMARK_MODES = ("auto", "trustmark", "null")
SUPPORTED_VARIANTS = ("Q",)
SUPPORTED_SCHEMAS = ("BCH_SUPER",)


class ConfigError(ValueError):
    """Raised when an environment variable holds an unusable value."""


def _int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be in [{lo}, {hi}], got {value}")
    return value


def _float(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be in [{lo}, {hi}], got {value}")
    return value


def _choice(env: Mapping[str, str], name: str, default: str, choices: tuple) -> str:
    value = env.get(name) or default
    if value not in choices:
        raise ConfigError(f"{name} must be one of {choices}, got {value!r}")
    return value


@dataclass(frozen=True)
class Settings:
    port: int = 8000
    models_dir: str = "/models"
    trustmark_variant: str = "Q"
    trustmark_schema: str = "BCH_SUPER"
    trustmark_strength: float = 1.0
    torch_num_threads: int = 4
    staging_dir: str = "/srv/staging"
    max_image_pixels: int = 50_000_000
    max_upload_bytes: int = 200 * 1024 * 1024
    max_batch: int = 32
    jpeg_quality: int = 95
    # auto: TrustMark when the weights are present, else the null watermark.
    # trustmark: refuse to start without weights. null: never load TrustMark.
    watermark_mode: str = "auto"

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Settings":
        e = os.environ if env is None else env
        return cls(
            port=_int(e, "ML_PORT", 8000, 1, 65535),
            models_dir=e.get("MODELS_DIR") or "/models",
            trustmark_variant=_choice(e, "TRUSTMARK_VARIANT", "Q", SUPPORTED_VARIANTS),
            trustmark_schema=_choice(e, "TRUSTMARK_SCHEMA", "BCH_SUPER", SUPPORTED_SCHEMAS),
            trustmark_strength=_float(e, "TRUSTMARK_STRENGTH", 1.0, 0.05, 4.0),
            torch_num_threads=_int(e, "TORCH_NUM_THREADS", 4, 1, 256),
            staging_dir=e.get("STAGING_DIR") or "/srv/staging",
            max_image_pixels=_int(e, "MAX_IMAGE_PIXELS", 50_000_000, 1, 1_000_000_000),
            max_upload_bytes=_int(e, "MAX_UPLOAD_BYTES", 200 * 1024 * 1024, 1, 4 * 1024**3),
            max_batch=_int(e, "ML_MAX_BATCH", 32, 1, 1024),
            jpeg_quality=_int(e, "ML_JPEG_QUALITY", 95, 1, 100),
            watermark_mode=_choice(e, "ML_WATERMARK", "auto", WATERMARK_MODES),
        )
