import io
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.watermark import NullWatermark, TrustMarkEngine, WeightsMissing, weights_status

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
SCENE = os.path.join(FIXTURES, "scene-1024x768.jpg")
COFFEE = os.path.join(FIXTURES, "coffee-600x400.jpg")
MODELS_DIR = os.environ.get("MODELS_DIR") or os.path.join(os.path.dirname(HERE), "models")

_ok, _problems = weights_status(MODELS_DIR, "Q")
NO_WEIGHTS_REASON = (
    f"TrustMark Q weights unusable in {MODELS_DIR} ({', '.join(_problems)}); "
    "run `python scripts/fetch-weights.py` to enable the real encode/decode tests"
)
requires_weights = pytest.mark.skipif(not _ok, reason=NO_WEIGHTS_REASON)


def read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def jpeg_bytes(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


@pytest.fixture(scope="session")
def engine():
    if not _ok:
        pytest.skip(NO_WEIGHTS_REASON)
    try:
        return TrustMarkEngine(MODELS_DIR, "Q")
    except WeightsMissing as exc:  # pragma: no cover
        pytest.skip(str(exc))


@pytest.fixture()
def staging(tmp_path):
    d = tmp_path / "staging"
    d.mkdir()
    shutil.copy(SCENE, d / "scene.jpg")
    shutil.copy(COFFEE, d / "coffee.jpg")
    return d


def make_client(staging_dir, engine_obj, **overrides) -> TestClient:
    s = Settings(staging_dir=str(staging_dir), models_dir=MODELS_DIR, torch_num_threads=4, **overrides)
    return TestClient(create_app(s, engine_obj))


@pytest.fixture()
def client(staging, engine):
    with make_client(staging, engine) as c:
        yield c


@pytest.fixture()
def null_client(staging):
    with make_client(staging, NullWatermark()) as c:
        yield c
