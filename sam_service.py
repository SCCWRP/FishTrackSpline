"""MobileSAM (ONNX) image encoder + mask decoder with an on-disk embedding cache.

Models: Hugging Face Acly/MobileSAM (MIT) — see scripts/fetch_models.py. The browser
decoder (static/js/sam/) runs the same decoder .onnx; the prompt transform below must
stay identical to static/js/sam/transform.js.
"""

import base64
import hashlib
import io
import logging
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image

ENCODER_FILE = "mobile_sam_image_encoder.onnx"
DECODER_FILE = "sam_mask_decoder_single.onnx"
TARGET_LENGTH = 1024  # SAM input: longest image side resized to this
EMBED_SHAPE = (1, 256, 64, 64)
CACHE_LIMIT_BYTES = 2 * 1024**3
MEMORY_ITEMS = 16

log = logging.getLogger("uvicorn.error")


def preprocess_shape(h: int, w: int) -> tuple[int, int]:
    """SAM's ResizeLongestSide.get_preprocess_shape: (new_h, new_w)."""
    scale = TARGET_LENGTH / max(h, w)
    return int(h * scale + 0.5), int(w * scale + 0.5)


def build_prompt(points, labels, box, orig_hw):
    """Normalized prompts -> decoder point_coords [1,N,2] / point_labels [1,N].

    points: [(x, y)] in 0..1, labels: 1 positive / 0 negative, box: (x1, y1, x2, y2) in
    0..1 or None. Coordinates go to pixels, then into the 1024-scaled frame per axis
    (ResizeLongestSide.apply_coords). No box -> a (0, 0) padding point with label -1.
    """
    h, w = orig_hw
    new_h, new_w = preprocess_shape(h, w)
    sx, sy = new_w / w, new_h / h
    coords = [(x * w * sx, y * h * sy) for x, y in points]
    labs = [float(l) for l in labels]
    if box is not None:
        x1, y1, x2, y2 = box
        coords += [(x1 * w * sx, y1 * h * sy), (x2 * w * sx, y2 * h * sy)]
        labs += [2.0, 3.0]
    else:
        coords.append((0.0, 0.0))
        labs.append(-1.0)
    return (
        np.array(coords, dtype=np.float32).reshape(1, -1, 2),
        np.array(labs, dtype=np.float32).reshape(1, -1),
    )


def mask_to_box(mask: np.ndarray):
    """Tight normalized (x1, y1, x2, y2) of a boolean HxW mask; None if empty."""
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    h, w = mask.shape
    return (float(cols[0] / w), float(rows[0] / h), float((cols[-1] + 1) / w), float((rows[-1] + 1) / h))


def mask_to_png_data_url(mask: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(mask.astype(np.uint8) * 255, mode="L").save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class SamService:
    def __init__(self, models_dir: Path, cache_dir: Path, cache_limit: int = CACHE_LIMIT_BYTES):
        self.models_dir = Path(models_dir)
        self.cache_dir = Path(cache_dir)
        self.cache_limit = cache_limit
        self._encoder = None
        self._decoder = None
        self._load_lock = threading.Lock()
        self._encode_lock = threading.Lock()
        self._memory: OrderedDict[str, tuple[np.ndarray, tuple[int, int]]] = OrderedDict()
        self._memory_lock = threading.Lock()

    # ---------- models ----------

    def available(self) -> bool:
        return (self.models_dir / ENCODER_FILE).is_file() and (self.models_dir / DECODER_FILE).is_file()

    @property
    def decoder_path(self) -> Path:
        return self.models_dir / DECODER_FILE

    def _session(self, filename: str):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = os.cpu_count() or 1
        return ort.InferenceSession(
            str(self.models_dir / filename), sess_options=opts, providers=["CPUExecutionProvider"]
        )

    def _get_encoder(self):
        with self._load_lock:
            if self._encoder is None:
                self._encoder = self._session(ENCODER_FILE)
            return self._encoder

    def _get_decoder(self):
        with self._load_lock:
            if self._decoder is None:
                self._decoder = self._session(DECODER_FILE)
            return self._decoder

    # ---------- cache ----------

    def _path(self, key: str) -> Path:
        return self.cache_dir / f"{hashlib.sha1(key.encode()).hexdigest()}.npz"

    def _remember(self, key: str, entry) -> None:
        with self._memory_lock:
            self._memory[key] = entry
            self._memory.move_to_end(key)
            while len(self._memory) > MEMORY_ITEMS:
                self._memory.popitem(last=False)

    def _load(self, key: str):
        """(float16 embedding, (h, w)) from memory or disk; KeyError if not cached."""
        with self._memory_lock:
            if key in self._memory:
                self._memory.move_to_end(key)
                return self._memory[key]
        path = self._path(key)
        if not path.is_file():
            raise KeyError(key)
        with np.load(path) as z:
            entry = (z["embedding"], (int(z["orig_size"][0]), int(z["orig_size"][1])))
        os.utime(path)  # LRU by last use
        self._remember(key, entry)
        return entry

    def has_embedding(self, key: str) -> bool:
        with self._memory_lock:
            if key in self._memory:
                return True
        return self._path(key).is_file()

    def _trim_cache(self) -> None:
        files = sorted(self.cache_dir.glob("*.npz"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for p in files:
            if total <= self.cache_limit:
                break
            total -= p.stat().st_size
            p.unlink(missing_ok=True)

    # ---------- encode / decode ----------

    def embed(self, key: str, image_bytes: bytes) -> tuple[int, int]:
        """Encode a frame (PNG/JPEG bytes) unless cached; returns its (h, w)."""
        with self._encode_lock:
            try:
                return self._load(key)[1]
            except KeyError:
                pass
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            w, h = img.size
            new_h, new_w = preprocess_shape(h, w)
            arr = np.asarray(img.resize((new_w, new_h), Image.BILINEAR), dtype=np.float32)
            t0 = time.perf_counter()
            (emb,) = self._get_encoder().run(None, {"input_image": arr})
            log.info("sam: encoded %s (%dx%d) in %.2fs", key, w, h, time.perf_counter() - t0)

            # Keep only the float16-rounded embedding (memory too) so server and
            # browser decoders see identical inputs.
            emb16 = emb.astype(np.float16)
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            path = self._path(key)
            tmp = path.with_suffix(".tmp")
            with tmp.open("wb") as f:
                np.savez(f, embedding=emb16, orig_size=np.array([h, w], dtype=np.int32))
            tmp.replace(path)
            self._remember(key, (emb16, (h, w)))
            self._trim_cache()
            return h, w

    def embedding_bytes(self, key: str) -> bytes:
        return np.ascontiguousarray(self._load(key)[0], dtype="<f2").tobytes()

    def decode(self, key: str, points, labels, box) -> dict:
        emb16, (h, w) = self._load(key)
        coords, labs = build_prompt(points, labels, box, (h, w))
        masks, iou = self._get_decoder().run(
            ["masks", "iou_predictions"],
            {
                "image_embeddings": emb16.astype(np.float32),
                "point_coords": coords,
                "point_labels": labs,
                "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
                "has_mask_input": np.zeros((1,), dtype=np.float32),
                "orig_im_size": np.array([h, w], dtype=np.float32),
            },
        )
        mask = masks[0, 0] > 0
        rect = mask_to_box(mask)
        return {
            "box": list(rect) if rect else None,
            "score": float(iou.reshape(-1)[0]),
            "mask": mask_to_png_data_url(mask) if rect else None,
        }
