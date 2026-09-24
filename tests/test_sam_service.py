import importlib
import io
import os
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import sam_service
from sam_service import SamService, build_prompt, mask_to_box, preprocess_shape

MODELS_DIR = Path(os.environ.get("MODELS_DIR", Path(__file__).resolve().parent.parent / "_COMMON/_MODELS/MOBILESAM"))
HAVE_MODELS = SamService(MODELS_DIR, MODELS_DIR).available()


def png_bytes(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


# ---------- prompt transform (parity values shared with tests/js/transform.test.mjs) ----------


def test_preprocess_shape():
    assert preprocess_shape(720, 1280) == (576, 1024)
    assert preprocess_shape(1080, 1917) == (577, 1024)  # per-axis rounding matters here
    assert preprocess_shape(1280, 720) == (1024, 576)


def test_build_prompt_points_get_padding_point():
    coords, labels = build_prompt([(0.5, 0.5), (0.25, 0.75)], [1, 0], None, (1080, 1917))
    np.testing.assert_allclose(coords, [[[512.0, 288.5], [256.0, 432.75], [0.0, 0.0]]], rtol=1e-6)
    np.testing.assert_array_equal(labels, [[1, 0, -1]])
    assert coords.dtype == np.float32 and labels.dtype == np.float32


def test_build_prompt_box_has_no_padding():
    coords, labels = build_prompt([], [], (0.25, 0.25, 0.75, 0.75), (1080, 1917))
    np.testing.assert_allclose(coords, [[[256.0, 144.25], [768.0, 432.75]]], rtol=1e-6)
    np.testing.assert_array_equal(labels, [[2, 3]])


def test_mask_to_box():
    mask = np.zeros((10, 20), dtype=bool)
    assert mask_to_box(mask) is None
    mask[2:5, 4:10] = True
    assert mask_to_box(mask) == pytest.approx((4 / 20, 2 / 10, 10 / 20, 5 / 10))


# ---------- cache (fake encoder, no models needed) ----------


class FakeEncoder:
    def __init__(self):
        self.calls = 0

    def run(self, _outputs, feeds):
        self.calls += 1
        assert max(feeds["input_image"].shape[:2]) == 1024
        return [np.full(sam_service.EMBED_SHAPE, 0.1, dtype=np.float32)]


def make_service(tmp_path, **kw):
    svc = SamService(tmp_path / "models", tmp_path / "cache", **kw)
    svc._encoder = FakeEncoder()
    return svc


def test_embed_caches_to_disk_and_memory(tmp_path):
    svc = make_service(tmp_path)
    img = png_bytes(np.zeros((72, 128, 3), dtype=np.uint8))
    assert not svc.has_embedding("v.mp4@0")
    assert svc.embed("v.mp4@0", img) == (72, 128)
    assert svc.embed("v.mp4@0", img) == (72, 128)
    assert svc._encoder.calls == 1
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 1

    # A fresh service (e.g. after a restart) finds it on disk.
    svc2 = make_service(tmp_path)
    assert svc2.has_embedding("v.mp4@0")
    emb, size = svc2._load("v.mp4@0")
    assert emb.dtype == np.float16 and emb.shape == sam_service.EMBED_SHAPE and size == (72, 128)
    assert len(svc2.embedding_bytes("v.mp4@0")) == 256 * 64 * 64 * 2


def test_cache_trims_least_recently_used(tmp_path):
    one = 256 * 64 * 64 * 2  # ~2 MiB per float16 embedding
    svc = make_service(tmp_path, cache_limit=int(one * 2.5))
    img = png_bytes(np.zeros((10, 10, 3), dtype=np.uint8))
    for i in range(3):
        svc.embed(f"k{i}", img)
        path = svc._path(f"k{i}")
        os.utime(path, (1000 + i, 1000 + i))  # deterministic LRU order
    svc.embed("k3", img)
    remaining = {p.name for p in (tmp_path / "cache").glob("*.npz")}
    assert svc._path("k0").name not in remaining
    assert svc._path("k3").name in remaining
    assert len(remaining) == 2


# ---------- HTTP endpoints ----------


@pytest.fixture
def client_factory(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    def make(models_dir: Path):
        (tmp_path / "videos").mkdir(exist_ok=True)
        monkeypatch.setenv("VIDEOS_DIR", str(tmp_path / "videos"))
        monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
        monkeypatch.setenv("MODELS_DIR", str(models_dir))
        monkeypatch.setenv("CACHE_DIR", str(tmp_path / "cache"))
        sys.modules.pop("server", None)
        return TestClient(importlib.import_module("server").app)

    return make


def test_endpoints_degrade_without_models(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    assert client.get("/api/sam/status").json() == {"available": False, "decoderUrl": "/models/decoder.onnx"}
    assert client.post("/api/sam/embed?key=a", content=b"x").status_code == 503
    assert client.post("/api/sam/decode", json={"key": "a", "points": [[0.5, 0.5]], "labels": [1]}).status_code == 503
    assert client.get("/models/decoder.onnx").status_code == 503
    assert client.get("/").status_code == 200  # the app itself still serves


@pytest.mark.skipif(not HAVE_MODELS, reason="run scripts/fetch_models.py first")
def test_real_models_segment_a_square(client_factory):
    client = client_factory(MODELS_DIR)
    img = np.full((360, 640, 3), 30, dtype=np.uint8)
    img[100:220, 200:360] = (240, 200, 40)  # bright rectangle: x 200..360, y 100..220
    key = "synthetic@0"

    assert client.head(f"/api/sam/embed?key={key}").status_code == 404
    res = client.post(f"/api/sam/embed?key={key}", content=png_bytes(img))
    assert res.json() == {"key": key, "origSize": [360, 640]}
    assert client.head(f"/api/sam/embed?key={key}").status_code == 200
    assert len(client.get(f"/api/sam/embedding?key={key}").content) == 256 * 64 * 64 * 2

    out = client.post("/api/sam/decode", json={"key": key, "points": [[280 / 640, 160 / 360]], "labels": [1]}).json()
    x1, y1, x2, y2 = out["box"]
    assert abs(x1 * 640 - 200) < 6 and abs(x2 * 640 - 360) < 6
    assert abs(y1 * 360 - 100) < 6 and abs(y2 * 360 - 220) < 6
    assert out["mask"].startswith("data:image/png;base64,")

    assert client.post("/api/sam/decode", json={"key": "missing", "points": [[0.5, 0.5]], "labels": [1]}).status_code == 404
