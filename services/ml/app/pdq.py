"""PDQ perceptual hash (Meta ThreatExchange algorithm via the `pdqhash` binding)."""

from __future__ import annotations

from typing import Tuple

import numpy as np
import pdqhash
from PIL import Image


def bits_to_hex(bits: "np.ndarray") -> str:
    """Canonical PDQ hex (ThreatExchange `Hash256::toHexString`: words 15..0, 16 bits each).

    `bits` is the vector returned by `pdqhash.compute`, which is already reversed
    (`bits[i]` is hash bit 255 - i, see `pdqhash.hash_to_vector`), so packing it
    MSB-first yields the canonical big-endian hex directly.
    """
    flat = np.asarray(bits, dtype=np.uint8).reshape(-1)
    if flat.size != 256:
        raise ValueError("PDQ hash must have 256 bits")
    return np.packbits(flat & 1).tobytes().hex()


def hamming(a_hex: str, b_hex: str) -> int:
    return bin(int(a_hex, 16) ^ int(b_hex, 16)).count("1")


def pdq_hash(img: Image.Image) -> Tuple[str, int]:
    """Return (64-hex hash, quality 0-100) for an RGB image."""
    arr = np.ascontiguousarray(np.asarray(img.convert("RGB"), dtype=np.uint8))
    vector, quality = pdqhash.compute(arr)
    return bits_to_hex(vector), int(quality)
