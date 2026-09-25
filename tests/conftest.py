import importlib
import sys
from pathlib import Path

import pytest


@pytest.fixture
def client_factory(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    def make(models_dir: Path):
        (tmp_path / "uploads").mkdir(exist_ok=True)
        monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
        monkeypatch.setenv("MODELS_DIR", str(models_dir))
        monkeypatch.setenv("CACHE_DIR", str(tmp_path / "cache"))
        monkeypatch.setenv("UPLOADS_DIR", str(tmp_path / "uploads"))
        sys.modules.pop("server", None)
        return TestClient(importlib.import_module("server").app)

    return make
