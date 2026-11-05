import io

import pytest
from PIL import Image

from app.config import ConfigError, Settings
from app.watermark import PAYLOAD_LIMIT
from tests.conftest import COFFEE, SCENE, jpeg_bytes, make_client, read


def files(name, path, fname="x.jpg"):
    return {name: (fname, read(path), "image/jpeg")}


# ---- independent of the TrustMark weights -------------------------------------------------


def test_health_null(null_client):
    body = null_client.get("/health").json()
    assert body["ok"] is True and body["models"] == [] and body["watermark"] == "null"
    assert body["torch_threads"] == 4


def test_payload_too_big_is_422(null_client):
    r = null_client.post(
        "/watermark/encode", files=files("image", SCENE), data={"payload": str(PAYLOAD_LIMIT)}
    )
    assert r.status_code == 422 and r.json()["error"] == "invalid_input"
    r = null_client.post("/watermark/encode", files=files("image", SCENE), data={"payload": "12", "strength": "9"})
    assert r.status_code == 422


def test_null_encode_returns_jpeg(null_client):
    r = null_client.post("/watermark/encode", files=files("image", SCENE), data={"payload": "12"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.headers["x-trustmark-version"] == "null" and r.headers["x-payload"] == "12"
    assert Image.open(io.BytesIO(r.content)).size == (1024, 768)
    d = null_client.post("/watermark/decode", files={"image": ("d.jpg", r.content, "image/jpeg")})
    assert d.json() == {"ok": False, "payload": None, "schema": "BCH_SUPER", "bits": 40}


def test_pdq_multipart_and_path_mode_agree(null_client):
    a = null_client.post("/pdq", files=files("image", SCENE)).json()
    b = null_client.post("/pdq", json={"path": "scene.jpg"}).json()
    assert a == b and len(a["hash"]) == 64


def test_pdq_batch(null_client):
    multi = [("images", ("a.jpg", read(SCENE), "image/jpeg")), ("images", ("b.jpg", read(COFFEE), "image/jpeg"))]
    r1 = null_client.post("/pdq/batch", files=multi).json()
    r2 = null_client.post("/pdq/batch", json={"paths": ["scene.jpg", "coffee.jpg"]}).json()
    assert r1 == r2 and [x["index"] for x in r1] == [0, 1]
    assert null_client.post("/pdq/batch", json={"paths": []}).status_code == 422


def test_path_confinement(null_client, staging, tmp_path):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(read(SCENE))
    assert null_client.post("/pdq", json={"path": str(outside)}).status_code == 403
    assert null_client.post("/pdq", json={"path": "../outside.jpg"}).status_code == 403
    assert null_client.post("/pdq", json={"path": "nope.jpg"}).status_code == 404
    assert null_client.post("/pdq", json={"path": 5}).status_code == 422


def test_bad_inputs(null_client):
    assert null_client.post("/pdq", files={"image": ("x.jpg", b"not an image", "image/jpeg")}).status_code == 422
    assert null_client.post("/pdq", content=b"x", headers={"content-type": "text/plain"}).status_code == 422
    assert null_client.post("/pdq", json=[1]).status_code == 422
    assert null_client.post("/watermark/decode", json={}).status_code == 422


def test_oversize_image_rejected(staging):
    from app.watermark import NullWatermark

    with make_client(staging, NullWatermark(), max_image_pixels=500_000) as c:
        r = c.post("/pdq", files=files("image", SCENE))
        assert r.status_code == 413 and r.json()["error"] == "too_large"
        assert c.post("/pdq", files=files("image", COFFEE)).status_code == 200
    with make_client(staging, NullWatermark(), max_upload_bytes=1000) as c:
        assert c.post("/pdq", files=files("image", SCENE)).status_code == 413
        assert c.post("/pdq", json={"path": "scene.jpg"}).status_code == 413


def test_ssim(null_client):
    same = null_client.post("/ssim", json={"a": "scene.jpg", "b": "scene.jpg"}).json()["ssim"]
    assert same == pytest.approx(1.0)
    img = Image.open(SCENE).convert("RGB")
    lossy = jpeg_bytes(img, 20)
    r = null_client.post(
        "/ssim",
        files={"a": ("a.jpg", read(SCENE), "image/jpeg"), "b": ("b.jpg", lossy, "image/jpeg")},
    ).json()
    assert 0.3 < r["ssim"] < 1.0
    assert null_client.post("/ssim", json={"a": "scene.jpg", "b": "coffee.jpg"}).status_code == 422


def test_settings_from_env():
    s = Settings.from_env({"ML_PORT": "1234", "TRUSTMARK_STRENGTH": "1.2", "ML_WATERMARK": "null"})
    assert s.port == 1234 and s.trustmark_strength == 1.2 and s.watermark_mode == "null"
    assert Settings.from_env({}).models_dir == "/models"
    for bad in ({"ML_PORT": "x"}, {"TRUSTMARK_VARIANT": "C"}, {"TORCH_NUM_THREADS": "0"}, {"ML_WATERMARK": "on"}):
        with pytest.raises(ConfigError):
            Settings.from_env(bad)


# ---- real TrustMark Q (skipped with a visible reason when the weights are absent) ----------


def test_health_lists_model(client):
    body = client.get("/health").json()
    assert body["models"] == ["trustmark-Q"] and body["watermark"] == "trustmark"


def test_decode_unmarked_is_not_ok(client):
    r = client.post("/watermark/decode", files=files("image", SCENE)).json()
    assert r == {"ok": False, "payload": None, "schema": "BCH_SUPER", "bits": 40}


def test_encode_path_and_multipart_identical(client):
    a = client.post("/watermark/encode", files=files("image", SCENE), data={"payload": "777"})
    b = client.post("/watermark/encode", json={"path": "scene.jpg", "payload": "777"})
    assert a.status_code == b.status_code == 200
    assert a.content == b.content
    assert a.headers["x-trustmark-version"] == "trustmark/0.9.2/Q/BCH_SUPER"
    d1 = client.post("/watermark/decode", files={"image": ("m.jpg", a.content, "image/jpeg")}).json()
    assert d1["ok"] is True and d1["payload"] == "777"


def test_roundtrip_through_jpeg(client):
    payload = str(0xC3C3C3C3C3)
    r = client.post(
        "/watermark/encode", files=files("image", SCENE), data={"payload": payload, "strength": "1.0"}
    )
    assert r.status_code == 200 and r.headers["x-payload"] == payload
    marked = Image.open(io.BytesIO(r.content)).convert("RGB")
    q75 = Image.open(io.BytesIO(jpeg_bytes(marked, 75))).convert("RGB")
    small = q75.resize((int(q75.width * 0.6), int(q75.height * 0.6)), Image.BILINEAR)
    d = client.post(
        "/watermark/decode", files={"image": ("s.jpg", jpeg_bytes(small, 75), "image/jpeg")}
    ).json()
    assert d == {"ok": True, "payload": payload, "schema": "BCH_SUPER", "bits": 40}
