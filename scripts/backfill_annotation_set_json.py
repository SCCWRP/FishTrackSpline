"""Rename older sets' OUTPUT_DIR/<uuid>/<stem>_points.json to annotation_set.json.

Usage: uv run scripts/backfill_annotation_set_json.py [OUTPUT_DIR] [--dry-run]
(OUTPUT_DIR defaults to $OUTPUT_DIR, else _OUTPUT.) Also drops a stale OUTPUT_DIR/<uuid>.zip,
so the next Download rebuilds it with the new name.
"""

import argparse
import json
import os
from pathlib import Path

ANNOTATIONS_FILE = "annotation_set.json"
INDEX_FILE = "annotation_sets.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output_dir", nargs="?", default=os.environ.get("OUTPUT_DIR", "_OUTPUT"))
    parser.add_argument("--dry-run", action="store_true", help="only print what would be renamed")
    args = parser.parse_args()
    out = Path(args.output_dir)
    index = out / INDEX_FILE
    if not index.is_file():
        raise SystemExit(f"no {INDEX_FILE} in {out}")

    renamed = skipped = 0
    for entry in json.loads(index.read_text(encoding="utf-8")):
        base = out / entry["uuid"]
        old, new = base / f"{entry['video_stem']}_points.json", base / ANNOTATIONS_FILE
        if not old.is_file():
            continue
        if new.exists():
            print(f"skip {base.name}: both {old.name} and {ANNOTATIONS_FILE} exist")
            skipped += 1
            continue
        print(f"{'would rename' if args.dry_run else 'rename'} {old} -> {new.name}")
        if not args.dry_run:
            old.rename(new)
            (out / f"{entry['uuid']}.zip").unlink(missing_ok=True)
        renamed += 1
    print(f"{renamed} {'to rename' if args.dry_run else 'renamed'}, {skipped} skipped")


if __name__ == "__main__":
    main()
