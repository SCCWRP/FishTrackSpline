"""FishTrackSpline server: static frontend, uploaded videos (with Range), versioned
annotation sets, MobileSAM."""

import os
from pathlib import Path

import av

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from library import AnnotationStore, LibraryError, list_videos, resolve_video, upload_path
from sam_service import SamService

OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "_OUTPUT")).resolve()
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", "_UPLOADS")).resolve()  # the only video source
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "_COMMON/_MODELS/MOBILESAM")).resolve()
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "_CACHE/sam")).resolve()
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="FishTrackSpline")
sam = SamService(MODELS_DIR, CACHE_DIR)
store = AnnotationStore(OUTPUT_DIR)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def video_file(video: str) -> Path:
    try:
        return resolve_video(video, UPLOADS_DIR)
    except LibraryError as err:
        raise HTTPException(status_code=404, detail=str(err))


# ---------- videos ----------


@app.get("/api/videos")
def videos():
    """Videos in UPLOADS_DIR: [{id, name}] (id = URL path, e.g. "uploads/x.mp4")."""
    return list_videos(UPLOADS_DIR)


@app.post("/api/videos/upload")
async def upload_video(name: str, request: Request):
    """Stream the raw request body into UPLOADS_DIR under a sanitized, unused name."""
    try:
        dest = upload_path(UPLOADS_DIR, name)
    except LibraryError as err:
        raise HTTPException(status_code=400, detail=str(err))
    tmp = dest.with_name(f".{dest.name}.part")
    size = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                f.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="empty upload")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return {"id": f"uploads/{dest.name}", "name": dest.name, "bytes": size}


@app.get("/api/video/info")
def video_info(video: str):
    """Frame rate and frame count of a video (for frame-numbered exports)."""
    path = video_file(video)
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            rate = stream.guessed_rate or stream.average_rate
            frames = stream.frames or round(float(container.duration / av.time_base) * rate)
    except (av.error.FFmpegError, IndexError) as err:
        raise HTTPException(status_code=400, detail=f"cannot read video: {err}")
    return {"fps": float(rate), "fpsFraction": f"{rate.numerator}/{rate.denominator}", "frames": frames}


# ---------- annotation sets ----------


class SaveRequest(BaseModel):
    video: str  # video id
    files: dict[str, str]  # relative path (e.g. "yolo-labels/0000000001.txt") -> content
    based_on: str | None = None  # uuid of the set this one was loaded from


@app.post("/api/annotation-sets")
def save_annotation_set(req: SaveRequest):
    """Every save is a new OUTPUT_DIR/<uuid>/ and the video's next version."""
    video_file(req.video)
    try:
        return store.save(req.video, req.files, req.based_on)
    except LibraryError as err:
        raise HTTPException(status_code=400, detail=str(err))


@app.get("/api/annotation-sets")
def annotation_sets(video: str | None = None):
    return store.list(video)


@app.get("/api/annotation-sets/{set_uuid}")
def load_annotation_set(set_uuid: str):
    try:
        return store.load(set_uuid)
    except LibraryError as err:
        raise HTTPException(status_code=404, detail=str(err))


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


app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
