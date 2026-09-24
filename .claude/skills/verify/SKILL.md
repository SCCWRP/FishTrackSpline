---
name: verify
description: Build, launch, and drive FishTrackSpline (Dockerized FastAPI + vanilla-JS video annotation SPA) to verify changes end-to-end.
---

# Verifying FishTrackSpline

## Launch
```bash
docker compose up --build -d          # serves http://localhost:8000
docker compose logs --tail 20         # expect "Application startup complete."
```
Server code (`server.py`, `sam_service.py`) and `static/` are bind-mounted with `--reload`, so frontend/backend edits apply without rebuilding; rebuild only when deps change.
MobileSAM models are bind-mounted read-only from `../_MODELS/MOBILESAM` (= `_COMMON/_MODELS/MOBILESAM`; fetch with `uv run python scripts/fetch_models.py`). Embeddings cache in `_CACHE/`.

## Unit tests
```bash
uv run pytest -q          # sam_service (transform, mask->box, cache, SAM endpoints, real models if present); server (video info, export bundle)
node --test tests/js/     # spline, undo history, render cache, CVAT/YOLO formats, JS prompt-transform parity
```

## Smoke checks (curl)
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/                  # 200
curl -sI -H "Range: bytes=0-99" \
  http://localhost:8000/videos/720p/GOPR7611_trim_720_16s.mp4 | head -1          # 206 (mp4 seeking)
curl -s http://localhost:8000/api/videos | head -c 300                          # [{id:"videos/720p/...",name,source}, ... uploads]
curl -s "http://localhost:8000/api/video/info?video=videos/720p/GOPR7611_trim_720_16s.mp4" # {"fps":59.94...,"frames":977}
curl -s http://localhost:8000/api/annotation-sets                                # index entries (uuid, video_stem, video_path, version, saved_at, based_on)
curl -s http://localhost:8000/api/sam/status                                     # {"available":true,...} when models mounted
```

## Drive the UI (Playwright, system Chrome)
No repo-local Playwright; install in a scratch dir: `npm i playwright` then
`chromium.launch({ channel: 'chrome', headless: true })` (uses installed Google Chrome, no browser download).

Video ids: `videos/<path under _VIDEOS_COMMON>` or `uploads/<file>` (`?video=720p/x.mp4` or `?video=uploads/x.mp4`). Uploads land in `_UPLOADS/` (mounted rw).
Key selectors: `#videoSelect #uploadBtn #uploadInput #setSelect #libraryStatus #video #overlay #stage #pointsHead #pointsBody #pointsCaption #objectList #addObjectBtn #addObjectMenu #playBtn #scrubber #undoBtn #redoBtn #boxToolbar #inputMode #samDecode #isolateBtn #samStatus #saveOutputBtn #downloadBtn #exportStatus #stageHint`.
`#addObjectBtn` opens a menu: click `#addObjectMenu button[data-type=point|box]`.
Mode toggle (top bar): `#modeToggle button[data-mode=edit|view]`. Box rows have `.render-btn` + `.render-status` (`✓` fresh, `stale` after a box edit). Point rows have a `.render-btn` "→ Box" (shows `n/N` while running): MobileSAM on each point keyframe → new box object `<name> box` (one undo entry); the video seeks through the points and returns.

Recipe that works:
- Wait for load: `page.waitForFunction(() => document.getElementById('video')?.videoWidth > 0)`.
- Seek deterministically via `video.currentTime = t` in `page.evaluate`, then waitForFunction on it (don't rely on playback timing).
- Click the overlay at fractional coords of `#overlay`'s boundingBox; the app stores normalized 0-1 coords, so a click at fraction (0.3, 0.4) must produce a table row `x=0.300 y=0.400` exactly.
- Assert canvas actually painted via `getImageData` alpha counts (or count pixels near an object's palette color, e.g. `#F28E2B` for fish 2, ±25 tolerance).
- `confirm()` dialogs (object delete): `page.on('dialog', d => d.accept())`.
- Points table rows read as `"2.000.3000.400⌖✕"` (concatenated tds); box rows are t, cx, cy, w, h, source (`✎` = hand-edited).
- SAM: pause (seek), select `sam-points`/`sam-box` in `#inputMode`, wait for `#samStatus` == `Ready` (~0.7 s at 720p), then click/drag. Default clip, t=5 s: a fish at normalized (0.1875, 0.192) → box ≈ cx 0.193, cy 0.196, w 0.064, h 0.056. Browser decode (`#samDecode` = browser) must give the same box.
- Simulate missing models with `page.route('**/api/sam/status', r => r.fulfill({ json: { available: false } }))`.

## Worth re-driving after changes
Click-to-add + EPS_T replace (re-click same paused time → still 1 row) · drag a point (t fixed, x/y change) · click point = seek; click other object's point = switch active + seek · right-click = delete · visibility eye zeroes that object's painted pixels · Space/←/→ keys (arrow step = 1/30 s) · Save to _OUTPUT writes a **new** `_OUTPUT/<uuid>/` per save (+ `meta.json`, and an entry in `_OUTPUT/annotation_sets.json`; version counts up per video path, `based_on` = the set loaded/saved before) = `_points.json`, `_points.csv`, `_boxes.csv`, `ground_truth/annotations.xml` (CVAT for video 1.1, 0-based frames, box tracks only, label `fish`, `outside="1"` after the last keyframe) and `yolo-labels/NNNNNNNNNN.txt` (1-based frame, class = track id); Download still gives the 3 JSON/CSV files · `?video=bad.mp4` shows the stage-hint error · viewport resize keeps table coords identical and canvas backing store == rect×DPR · wide/short windows (e.g. 2400×900, 3000×700): `#overlay` rect must equal the video *picture* rect (object-fit contain) — a click at 25%/75% of the picture stores (0.250, 0.750).
Box objects: drag draws a keyframe (a frame that already has one → new object) · corner/edge drag resizes, interior drag moves (marks ✎) · Undo/Redo buttons (drag = 1 entry) · dashed interpolated box between keyframes · right-click inside the box deletes it (manual box mode) · SAM points: left = +, right = −, right-click a marker removes it · SAM box: right-click adds a negative point to the frame's box prompt (marker right-click removes it; with no box prompt on the frame it does nothing) · SAM controls disabled when models are missing. · ISOLATE (`#isolateBtn`, toggle): only the active box object's keyframe on the current frame is drawn (nothing on frames without one); other boxes aren't clickable; editing still works.
Viewing mode: point objects show only the crosshair (alpha 255), box objects only their rendered fill (canvas alpha ≈ 64 = 25%) — no dots, splines or outlines; canvas clicks do nothing; box toolbar hidden, undo/redo disabled; a stale render is hidden until Render is pressed again.

## Gotchas
- `favicon.ico` 404s in console — pre-existing noise, filter it when collecting console errors (by `msg.location().url`; the text has no URL).
- The first `HEAD /api/sam/embed` for a new frame is a 404 by design (not cached yet) and also shows as a console error.
- Test exports land in `_OUTPUT/<uuid>/` + `_OUTPUT/annotation_sets.json` on the host, test uploads in `_UPLOADS/` — delete them after verifying (only your test entries).
- The video dropdown fills after `/api/videos` answers (~0.4 s walking `_VIDEOS_COMMON`): wait for `#videoSelect option` count > 1 before asserting on it.
- Loading a set (`#setSelect`) or switching/uploading a video asks `confirm()` only when annotations changed since the last load/save.
- The default clip has a burned-in **0-based** frame counter (top-left): `frameIndex(t)` in `static/js/formats.js` must equal it (checked at t = 2, 5, 7.5 and ±1 ms around a frame boundary). YOLO file N = counter N−1.
