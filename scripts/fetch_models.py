"""Download the MobileSAM ONNX models (MIT, Hugging Face Acly/MobileSAM) for runs outside Docker.

Usage: uv run python scripts/fetch_models.py [dest_dir]   (default: _COMMON/_MODELS/MOBILESAM)
Docker bind-mounts the same folder at /models (docker-compose.yml).
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

REPO = "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8"
FILES = {
    "mobile_sam_image_encoder.onnx": "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749",
    "sam_mask_decoder_single.onnx": "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d",
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "_COMMON/_MODELS/MOBILESAM")
    dest.mkdir(parents=True, exist_ok=True)
    for name, sha in FILES.items():
        path = dest / name
        if path.exists() and sha256_of(path) == sha:
            print(f"ok       {path}")
            continue
        tmp = path.with_suffix(".part")
        print(f"download {name} ...")
        urllib.request.urlretrieve(f"{REPO}/{name}", tmp)
        if sha256_of(tmp) != sha:
            tmp.unlink()
            sys.exit(f"checksum mismatch for {name}")
        tmp.replace(path)
        print(f"saved    {path}")


if __name__ == "__main__":
    main()
