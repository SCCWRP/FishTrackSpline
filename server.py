"""FishTrackSpline server: static frontend, video files (with Range), export, MobileSAM."""

import os
from pathlib import Path

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


class ExportRequest(BaseModel):
    filename: str
    content: str


@app.post("/api/export")
def export_points(req: ExportRequest):
    name = Path(req.filename).name  # strip any directory components
    if not name or name.startswith("."):
        raise HTTPException(status_code=400, detail="invalid filename")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUTPUT_DIR / name
    dest.write_text(req.content, encoding="utf-8")
    return {"saved": str(dest)}


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
