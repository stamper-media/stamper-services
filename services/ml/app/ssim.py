"""Structural similarity between two images of equal size (optional endpoint)."""

from __future__ import annotations

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

from .errors import InvalidInput


def ssim(a: Image.Image, b: Image.Image) -> float:
    if a.size != b.size:
        raise InvalidInput(f"images differ in size: {a.size} vs {b.size}")
    if min(a.size) < 7:
        raise InvalidInput("images must be at least 7x7 pixels")
    xa = np.asarray(a.convert("RGB"), dtype=np.uint8)
    xb = np.asarray(b.convert("RGB"), dtype=np.uint8)
    return float(structural_similarity(xa, xb, channel_axis=2, data_range=255))
