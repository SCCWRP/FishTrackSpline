"""Video library (UPLOADS_DIR, the only video source) and versioned annotation sets.

Video ids are URL paths without the leading slash: "uploads/<path under UPLOADS_DIR>"
(uploaded files, or videos copied in by hand). Every saved annotation set is a new, never-overwritten
OUTPUT_DIR/<uuid>/ with a meta.json, indexed in OUTPUT_DIR/annotation_sets.json
as {uuid, video_stem, video_path, version, saved_at, based_on}; version counts
up per video_path.
"""

import json
import os
import re
import threading
import uuid as uuidlib
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm"}
INDEX_FILE = "annotation_sets.json"
META_FILE = "meta.json"
_UPLOAD_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class LibraryError(ValueError):
    """Bad client input (-> HTTP 400/404)."""


def list_videos(uploads_dir: Path) -> list[dict]:
    """Videos under UPLOADS_DIR (subfolders included): [{id, name}], sorted by name."""
    found = []
    if uploads_dir.is_dir():
        for dirpath, dirnames, filenames in os.walk(uploads_dir):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for f in filenames:
                if not f.startswith(".") and Path(f).suffix.lower() in VIDEO_EXTENSIONS:
                    found.append(Path(dirpath, f).relative_to(uploads_dir).as_posix())
    return [{"id": f"uploads/{rel}", "name": rel} for rel in sorted(found, key=str.lower)]


def resolve_video(video_id: str, uploads_dir: Path) -> Path:
    """Video id -> file on disk (must stay inside UPLOADS_DIR and exist)."""
    source, _, rel = video_id.partition("/")
    if source != "uploads" or not rel:
        raise LibraryError(f"unknown video: {video_id!r}")
    path = (uploads_dir / rel).resolve()
    if not path.is_relative_to(uploads_dir.resolve()) or not path.is_file():
        raise LibraryError(f"video not found: {video_id!r}")
    return path


def upload_path(uploads_dir: Path, filename: str) -> Path:
    """Sanitized, non-clobbering destination for an uploaded video."""
    name = _UPLOAD_NAME.sub("_", Path(filename).name).strip("._")
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    if not stem or ext not in VIDEO_EXTENSIONS:
        raise LibraryError(f"not a supported video file ({', '.join(sorted(VIDEO_EXTENSIONS))}): {filename!r}")
    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest, n = uploads_dir / f"{stem}{ext}", 1
    while dest.exists():
        dest, n = uploads_dir / f"{stem}-{n}{ext}", n + 1
    return dest


def _relative_file(rel: str) -> PurePosixPath:
    p = PurePosixPath(rel)
    if not p.parts or p.is_absolute() or any(part in ("", ".", "..") or part.startswith(".") for part in p.parts):
        raise LibraryError(f"invalid path: {rel!r}")
    return p


class AnnotationStore:
    def __init__(self, output_dir: Path):
        self.output_dir = Path(output_dir)
        self._lock = threading.Lock()

    @property
    def index_path(self) -> Path:
        return self.output_dir / INDEX_FILE

    def _read_index(self) -> list[dict]:
        if not self.index_path.is_file():
            return []
        return json.loads(self.index_path.read_text(encoding="utf-8"))

    def _write_index(self, entries: list[dict]) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.index_path)

    def save(self, video_path: str, files: dict[str, str], based_on: str | None = None) -> dict:
        """Write files into a new OUTPUT_DIR/<uuid>/ and record it as the video's next version."""
        writes = [(_relative_file(rel), content) for rel, content in files.items()]
        with self._lock:
            self.output_dir.mkdir(parents=True, exist_ok=True)
            entries = self._read_index()
            entry = {
                "uuid": str(uuidlib.uuid4()),
                "video_stem": PurePosixPath(video_path).stem,
                "video_path": video_path,
                "version": 1 + max((e["version"] for e in entries if e["video_path"] == video_path), default=0),
                "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "based_on": based_on,
            }
            base = self.output_dir / entry["uuid"]
            for rel, content in writes:
                dest = base.joinpath(*rel.parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(content, encoding="utf-8")
            (base / META_FILE).write_text(json.dumps(entry, indent=2) + "\n", encoding="utf-8")
            self._write_index(entries + [entry])
        return entry

    def list(self, video_path: str | None = None) -> list[dict]:
        """Index entries (optionally for one video), newest version first."""
        entries = [e for e in self._read_index() if video_path is None or e["video_path"] == video_path]
        return sorted(entries, key=lambda e: (e["video_path"], -e["version"]))

    def load(self, set_uuid: str) -> dict:
        """The saved annotation JSON (<stem>_points.json) of a set."""
        entry = next((e for e in self._read_index() if e["uuid"] == set_uuid), None)
        if entry is None:
            raise LibraryError(f"unknown annotation set: {set_uuid!r}")
        path = self.output_dir / entry["uuid"] / f"{entry['video_stem']}_points.json"
        if not path.is_file():
            raise LibraryError(f"annotation file missing for set {set_uuid}")
        return {"set": entry, "annotations": json.loads(path.read_text(encoding="utf-8"))}
