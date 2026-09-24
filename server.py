"""FishTrackSpline server: static frontend, video files (with Range), export, MobileSAM."""

import os
import shutil
from pathlib import Path

import av

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from sam_service import SamService

VIDEOS_DIR = Path(os.environ.get("VIDEOS_DIR", "_VIDEOS_COMMON")).resolve()
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "_OUTPUT")).resolve()
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "_COMMON/_MODELS/MOBILESAM")).resolve()
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "_CACHE/sam")).resolve()
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="FishTrackSpline")
sam = SamService(MODELS_DIR, CACHE_DIR)


@app.get("/api/video/info")
def video_info(path: str):
    """Frame rate and frame count of a video under VIDEOS_DIR (for frame-numbered exports)."""
    video = (VIDEOS_DIR / path).resolve()
    if not video.is_relative_to(VIDEOS_DIR) or not video.is_file():
        raise HTTPException(status_code=404, detail="video not found")
    try:
        with av.open(str(video)) as container:
            stream = container.streams.video[0]
            rate = stream.guessed_rate or stream.average_rate
            frames = stream.frames or round(float(container.duration / av.time_base) * rate)
    except (av.error.FFmpegError, IndexError) as err:
        raise HTTPException(status_code=400, detail=f"cannot read video: {err}")
    return {"fps": float(rate), "fpsFraction": f"{rate.numerator}/{rate.denominator}", "frames": frames}


def safe_part(name: str) -> str:
    if not name or name.startswith(".") or Path(name).name != name:
        raise HTTPException(status_code=400, detail=f"invalid name: {name!r}")
    return name


class ExportBundle(BaseModel):
    dir: str  # subdirectory of OUTPUT_DIR (the video stem)
    files: dict[str, str]  # relative path (e.g. "yolo-labels/0000000001.txt") -> content
    replace: list[str] = []  # subdirectories emptied first so stale files don't linger


@app.post("/api/export")
def export_bundle(req: ExportBundle):
    # Validate everything before touching the disk.
    base = OUTPUT_DIR / safe_part(req.dir)
    stale = [base / safe_part(sub) for sub in req.replace]
    writes = []
    for rel, content in req.files.items():
        parts = Path(rel).parts
        if not parts or Path(rel).is_absolute():
            raise HTTPException(status_code=400, detail=f"invalid path: {rel!r}")
        writes.append((base.joinpath(*(safe_part(p) for p in parts)), content))

    for d in stale:
        shutil.rmtree(d, ignore_errors=True)
    for dest, content in writes:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
    return {"saved": str(base), "count": len(writes)}


# ---------- MobileSAM ----------


def require_sam():
    if not sam.available():
        raise HTTPException(status_code=503, detail="MobileSAM models not found on the server")


@app.get("/api/sam/status")
def sam_status():
    return {"available": sam.available(), "decoderUrl": "/models/decoder.onnx"}


@app.head("/api/sam/embed")
def sam_embed_cached(key: str):
    require_sam()
    if not sam.has_embedding(key):
        raise HTTPException(status_code=404)
    return Response(status_code=200)


@app.post("/api/sam/embed")
async def sam_embed(key: str, request: Request):
    require_sam()
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty frame image")
    try:
        h, w = await run_in_threadpool(sam.embed, key, body)
    except OSError as err:  # PIL.UnidentifiedImageError is an OSError
        raise HTTPException(status_code=400, detail=f"bad frame image: {err}")
    return {"key": key, "origSize": [h, w]}


@app.get("/api/sam/embedding")
def sam_embedding(key: str):
    require_sam()
    try:
        data = sam.embedding_bytes(key)
    except KeyError:
        raise HTTPException(status_code=404, detail="embedding not cached")
    return Response(content=data, media_type="application/octet-stream")


class DecodeRequest(BaseModel):
    key: str
    points: list[tuple[float, float]] = []  # normalized (x, y)
    labels: list[int] = []  # 1 positive, 0 negative
    box: tuple[float, float, float, float] | None = None  # normalized (x1, y1, x2, y2)


@app.post("/api/sam/decode")
def sam_decode(req: DecodeRequest):
    require_sam()
    if len(req.points) != len(req.labels):
        raise HTTPException(status_code=400, detail="points/labels length mismatch")
    try:
        return sam.decode(req.key, req.points, req.labels, req.box)
    except KeyError:
        raise HTTPException(status_code=404, detail="embedding not cached")


@app.get("/models/decoder.onnx")
def decoder_model():
    require_sam()
    return FileResponse(sam.decoder_path, media_type="application/octet-stream")


app.mount("/videos", StaticFiles(directory=VIDEOS_DIR), name="videos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
