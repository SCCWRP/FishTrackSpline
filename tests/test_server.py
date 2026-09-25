import json
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
    make_video(tmp_path / "uploads" / "clip.mp4")
    info = client.get("/api/video/info?video=uploads/clip.mp4").json()
    assert info == {"fps": 25.0, "fpsFraction": "25/1", "frames": 10}
    assert client.get("/api/video/info?video=uploads/missing.mp4").status_code == 404
    assert client.get("/api/video/info?video=uploads/../outside.mp4").status_code == 404
    assert client.get("/api/video/info?video=videos/clip.mp4").status_code == 404, "only uploads/ ids"


def test_list_videos_and_upload(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    uploads = tmp_path / "uploads"
    (uploads / "sub").mkdir()
    make_video(uploads / "sub" / "b.mp4")  # copied in by hand, in a subfolder
    (uploads / "frames.jpg").write_bytes(b"x")  # not a video
    (uploads / ".hidden.mp4").write_bytes(b"x")

    payload = (uploads / "sub" / "b.mp4").read_bytes()
    up = client.post("/api/videos/upload?name=My Clip (1).MP4", content=payload).json()
    assert up == {"id": "uploads/My_Clip_1_.mp4", "name": "My_Clip_1_.mp4", "bytes": len(payload)}
    again = client.post("/api/videos/upload?name=My Clip (1).MP4", content=payload).json()
    assert again["id"] == "uploads/My_Clip_1_-1.mp4", "never overwrites"

    assert client.get("/api/videos").json() == [
        {"id": "uploads/My_Clip_1_-1.mp4", "name": "My_Clip_1_-1.mp4"},
        {"id": "uploads/My_Clip_1_.mp4", "name": "My_Clip_1_.mp4"},
        {"id": "uploads/sub/b.mp4", "name": "sub/b.mp4"},
    ]
    assert client.get("/uploads/My_Clip_1_.mp4").content == payload
    assert client.get("/api/video/info?video=uploads/My_Clip_1_.mp4").json()["frames"] == 10
    assert client.get("/videos/sub/b.mp4").status_code == 404, "no shared videos mount any more"

    assert client.post("/api/videos/upload?name=notes.txt", content=b"x").status_code == 400
    assert client.post("/api/videos/upload?name=empty.mp4", content=b"").status_code == 400
    assert not any(p.name.startswith(".") and p.suffix == ".part" for p in uploads.iterdir()), "no partial files left"


def test_annotation_sets_are_versioned_per_video(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    make_video(tmp_path / "uploads" / "clip.mp4")
    (tmp_path / "uploads" / "other").mkdir()
    make_video(tmp_path / "uploads" / "other" / "clip.mp4")  # same stem, different video
    doc = {"objects": [{"id": 1, "name": "fish 1", "type": "box", "boxes": []}]}
    files = {
        "annotation_set.json": json.dumps(doc),
        "ground_truth/annotations.xml": "<annotations/>",
        "yolo-labels/0000000001.txt": "0 0.5 0.5 0.1 0.1\n",
    }

    v1 = client.post("/api/annotation-sets", json={"video": "uploads/clip.mp4", "files": files}).json()
    v2 = client.post("/api/annotation-sets", json={"video": "uploads/clip.mp4", "files": files, "based_on": v1["uuid"]}).json()
    o1 = client.post("/api/annotation-sets", json={"video": "uploads/other/clip.mp4", "files": files}).json()
    assert (v1["version"], v2["version"], o1["version"]) == (1, 2, 1)
    assert v1["uuid"] != v2["uuid"] and v2["based_on"] == v1["uuid"] and v1["based_on"] is None
    assert v1["video_stem"] == o1["video_stem"] == "clip"

    out = tmp_path / "out"
    for entry in (v1, v2, o1):
        d = out / entry["uuid"]
        assert (d / "ground_truth" / "annotations.xml").read_text() == "<annotations/>"
        assert (d / "yolo-labels" / "0000000001.txt").exists()
        assert json.loads((d / "meta.json").read_text()) == entry
    index = json.loads((out / "annotation_sets.json").read_text())
    assert [e["uuid"] for e in index] == [v1["uuid"], v2["uuid"], o1["uuid"]]

    listed = client.get("/api/annotation-sets?video=uploads/clip.mp4").json()
    assert [e["version"] for e in listed] == [2, 1], "newest first, only this video"
    loaded = client.get(f"/api/annotation-sets/{v2['uuid']}").json()
    assert loaded == {"set": v2, "annotations": doc}
    assert client.get("/api/annotation-sets/nope").status_code == 404


def test_annotation_set_download_zips_the_folder(client_factory, tmp_path):
    import io
    import zipfile

    client = client_factory(tmp_path / "no-models")
    make_video(tmp_path / "uploads" / "clip.mp4")
    files = {"annotation_set.json": "{}", "clip_points.csv": "a\n", "yolo-labels/0000000001.txt": "0 0.5 0.5 0.1 0.1\n"}
    s = client.post("/api/annotation-sets", json={"video": "uploads/clip.mp4", "files": files}).json()

    res = client.get(f"/api/annotation-sets/{s['uuid']}/download")
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    assert f'filename="{s["uuid"]}.zip"' in res.headers["content-disposition"]
    names = zipfile.ZipFile(io.BytesIO(res.content)).namelist()
    assert sorted(names) == sorted(f"{s['uuid']}/{n}" for n in [*files, "meta.json"])
    assert (tmp_path / "out" / f"{s['uuid']}.zip").read_bytes() == res.content
    assert client.get("/api/annotation-sets/nope/download").status_code == 404


@pytest.mark.parametrize(
    "files",
    [{"../a.txt": ""}, {"/abs.txt": ""}, {"sub/.hidden": ""}, {"a/../b.txt": ""}],
)
def test_annotation_set_rejects_unsafe_paths(client_factory, tmp_path, files):
    client = client_factory(tmp_path / "no-models")
    make_video(tmp_path / "uploads" / "clip.mp4")
    assert client.post("/api/annotation-sets", json={"video": "uploads/clip.mp4", "files": files}).status_code == 400
    assert not (tmp_path / "out" / "annotation_sets.json").exists()


def test_annotation_set_requires_a_known_video(client_factory, tmp_path):
    client = client_factory(tmp_path / "no-models")
    assert client.post("/api/annotation-sets", json={"video": "uploads/none.mp4", "files": {"a.txt": ""}}).status_code == 404
