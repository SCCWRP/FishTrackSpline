"""FishTrackSpline server: static frontend, video files (with Range), point export."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

VIDEOS_DIR = Path(os.environ.get("VIDEOS_DIR", "_VIDEOS_COMMON")).resolve()
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "_OUTPUT")).resolve()
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="FishTrackSpline")


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


app.mount("/videos", StaticFiles(directory=VIDEOS_DIR), name="videos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
