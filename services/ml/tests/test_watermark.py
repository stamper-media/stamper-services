import random

import pytest
from PIL import Image

from app.config import Settings
from app.errors import InvalidInput
from app.watermark import (
    NullWatermark,
    PAYLOAD_LIMIT,
    WeightsMissing,
    bits_to_payload,
    build_engine,
    parse_payload,
    payload_to_bits,
    weights_status,
)
from tests.conftest import SCENE


@pytest.mark.parametrize("raw,value", [("0", 0), ("123", 123), (" 42 ", 42), (str(PAYLOAD_LIMIT - 1), PAYLOAD_LIMIT - 1)])
def test_parse_payload_accepts(raw, value):
    assert parse_payload(raw) == value


@pytest.mark.parametrize("raw", [None, "", "-1", "1.5", "0x10", "abc", str(PAYLOAD_LIMIT), "9" * 30, True, "١٢"])
def test_parse_payload_rejects(raw):
    with pytest.raises(InvalidInput):
        parse_payload(raw)


def test_bits_roundtrip():
    for v in (0, 1, 0xABCDEF1234, PAYLOAD_LIMIT - 1):
        bits = payload_to_bits(v)
        assert len(bits) == 40 and bits_to_payload(bits) == v


def test_null_engine_is_noop():
    img = Image.open(SCENE).convert("RGB")
    eng = NullWatermark()
    assert eng.encode(img, 5, 1.0) is img
    assert eng.decode(img) is None
    assert eng.models == [] and eng.version == "null"


def test_weights_status_and_build_engine_fallback(tmp_path):
    ok, problems = weights_status(str(tmp_path), "Q")
    assert not ok and any("missing" in p for p in problems)
    (tmp_path / "encoder_Q.ckpt").write_bytes(b"x")
    ok, problems = weights_status(str(tmp_path), "Q")
    assert "bad checksum encoder_Q.ckpt" in problems
    auto = build_engine(Settings(models_dir=str(tmp_path), watermark_mode="auto"))
    assert isinstance(auto, NullWatermark)
    assert isinstance(build_engine(Settings(watermark_mode="null")), NullWatermark)
    with pytest.raises(WeightsMissing):
        build_engine(Settings(models_dir=str(tmp_path), watermark_mode="trustmark"))


def test_roundtrip_50_random_payloads(engine):
    img = Image.open(SCENE).convert("RGB")
    assert img.size == (1024, 768)
    rng = random.Random(20261001)
    payloads = [rng.randrange(PAYLOAD_LIMIT) for _ in range(48)] + [0, PAYLOAD_LIMIT - 1]
    failures = [p for p in payloads if engine.decode(engine.encode(img, p, 1.0)) != p]
    assert failures == []


def test_unmarked_decodes_to_none(engine):
    assert engine.decode(Image.open(SCENE).convert("RGB")) is None


def test_encode_preserves_size_and_rejects_big_payload(engine):
    img = Image.open(SCENE).convert("RGB")
    assert engine.encode(img, 7, 1.0).size == img.size
    with pytest.raises(InvalidInput):
        engine.encode(img, PAYLOAD_LIMIT, 1.0)
