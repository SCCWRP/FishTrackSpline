from pathlib import Path

import numpy as np
import pytest


def make_video(path: Path, fps: int = 25, n: int = 10) -> None:
    import av

    with av.open(str(path), "w") as out:
        stream = out.add_stream("mpeg4", rate=fps)
        stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
        for i in range(n):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), i * 20, dtype=np.uint8), format="rgb24")
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)


def test_video_info(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    make_video(tmp_path / "videos" / "clip.mp4")
    info = client.get("/api/video/info?path=clip.mp4").json()
    assert info == {"fps": 25.0, "fpsFraction": "25/1", "frames": 10}
    assert client.get("/api/video/info?path=missing.mp4").status_code == 404
    assert client.get("/api/video/info?path=../outside.mp4").status_code == 404


def test_export_bundle_writes_subdir_and_replaces_labels(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    out = tmp_path / "out" / "clip"
    files = {
        "clip_points.json": "{}",
        "ground_truth/annotations.xml": "<annotations/>",
        "yolo-labels/0000000001.txt": "0 0.5 0.5 0.1 0.1\n",
        "yolo-labels/0000000002.txt": "0 0.5 0.5 0.1 0.1\n",
    }
    res = client.post("/api/export", json={"dir": "clip", "files": files, "replace": ["yolo-labels"]})
    assert res.json()["count"] == 4
    assert (out / "ground_truth" / "annotations.xml").read_text() == "<annotations/>"
    assert sorted(p.name for p in (out / "yolo-labels").iterdir()) == ["0000000001.txt", "0000000002.txt"]

    # A later save with fewer frames must not leave stale label files behind.
    files2 = {"yolo-labels/0000000005.txt": "0 0.5 0.5 0.1 0.1\n"}
    client.post("/api/export", json={"dir": "clip", "files": files2, "replace": ["yolo-labels"]})
    assert [p.name for p in (out / "yolo-labels").iterdir()] == ["0000000005.txt"]
    assert (out / "clip_points.json").exists()


@pytest.mark.parametrize(
    "payload",
    [
        {"dir": "../x", "files": {"a.txt": ""}},
        {"dir": "clip", "files": {"../a.txt": ""}},
        {"dir": "clip", "files": {"/abs.txt": ""}},
        {"dir": "clip", "files": {"sub/.hidden": ""}},
        {"dir": "clip", "files": {"a.txt": ""}, "replace": [".."]},
    ],
)
def test_export_bundle_rejects_unsafe_paths(client_factory, tmp_path, payload):
    client = client_factory(tmp_path / "no-models")
    assert client.post("/api/export", json=payload).status_code == 400
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").rglob("*.txt"))
