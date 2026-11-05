import re

import numpy as np
from pdqhash import bindings as pdq_bindings
from PIL import Image

from app.pdq import bits_to_hex, hamming, pdq_hash
from tests.conftest import COFFEE, SCENE


def test_bits_to_hex_word_order():
    # pdqhash.compute returns a reversed vector: element 0 is hash bit 255.
    bits = np.zeros(256, dtype=np.uint8)
    bits[0] = 1
    assert bits_to_hex(bits) == "8" + "0" * 63
    bits[:] = 0
    bits[255] = 1
    assert bits_to_hex(bits) == "0" * 63 + "1"


def test_bits_to_hex_follows_threatexchange_words():
    # Build the vector with the binding's own converter from known Hash256 words:
    # toHexString prints w[15]..w[0] as %04x.
    words = [0] * 16
    words[0] = 0x0001
    words[1] = 0xABCD
    words[15] = 0x8001
    vec = pdq_bindings.hash_to_vector(words)
    expected = "".join(f"{w:04x}" for w in reversed(words))
    assert bits_to_hex(vec) == expected


def test_hash_is_64_hex_and_stable():
    img = Image.open(SCENE).convert("RGB")
    h1, q1 = pdq_hash(img)
    h2, q2 = pdq_hash(img)
    assert re.fullmatch(r"[0-9a-f]{64}", h1)
    assert (h1, q1) == (h2, q2)
    assert 0 <= q1 <= 100


def test_half_downscale_within_10_bits():
    for path in (SCENE, COFFEE):
        img = Image.open(path).convert("RGB")
        small = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
        assert hamming(pdq_hash(img)[0], pdq_hash(small)[0]) <= 10


def test_different_images_are_far_apart():
    a = pdq_hash(Image.open(SCENE).convert("RGB"))[0]
    b = pdq_hash(Image.open(COFFEE).convert("RGB"))[0]
    assert hamming(a, b) > 64


def test_load_rgb_applies_exif_orientation_and_keeps_icc():
    import io

    from app.images import load_rgb, to_jpeg

    src = Image.new("RGB", (60, 40), (200, 10, 10))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    buf = io.BytesIO()
    src.save(buf, format="JPEG", exif=exif.tobytes(), icc_profile=b"fake-icc")
    img = load_rgb(buf.getvalue(), 10_000)
    assert img.size == (40, 60)
    out = Image.open(io.BytesIO(to_jpeg(img, 90, img.info.get("icc_profile"))))
    assert out.info.get("icc_profile") == b"fake-icc"
