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
uv run pytest -q          # sam_service: prompt transform, mask->box, cache, endpoints (+ real-model test if models present)
node --test tests/js/     # spline (box == corner interpolation, w/h clamp), undo history, JS prompt-transform parity
```

## Smoke checks (curl)
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/                  # 200
curl -sI -H "Range: bytes=0-99" \
  http://localhost:8000/videos/720p/GOPR7611_trim_720_16s.mp4 | head -1          # 206 (mp4 seeking)
curl -s -X POST http://localhost:8000/api/export -H 'Content-Type: application/json' \
  -d '{"filename":"t.csv","content":"x"}'                                        # writes _OUTPUT/t.csv on host
curl -s http://localhost:8000/api/sam/status                                     # {"available":true,...} when models mounted
```

## Drive the UI (Playwright, system Chrome)
No repo-local Playwright; install in a scratch dir: `npm i playwright` then
`chromium.launch({ channel: 'chrome', headless: true })` (uses installed Google Chrome, no browser download).

Key selectors: `#video #overlay #stage #pointsHead #pointsBody #pointsCaption #objectList #addObjectBtn #addObjectMenu #playBtn #scrubber #undoBtn #redoBtn #boxToolbar #inputMode #samDecode #samStatus #saveOutputBtn #downloadBtn #exportStatus #stageHint`.
`#addObjectBtn` opens a menu: click `#addObjectMenu button[data-type=point|box]`.
Mode toggle (top bar): `#modeToggle button[data-mode=edit|view]`. Box rows have `.render-btn` + `.render-status` (`✓` fresh, `stale` after a box edit).

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
Click-to-add + EPS_T replace (re-click same paused time → still 1 row) · drag a point (t fixed, x/y change) · click point = seek; click other object's point = switch active + seek · right-click = delete · visibility eye zeroes that object's painted pixels · Space/←/→ keys (arrow step = 1/30 s) · export writes 3 files (`_points.json`, `_points.csv`, `_boxes.csv`) into `_OUTPUT/` and triggers 3 downloads · `?video=bad.mp4` shows the stage-hint error · viewport resize keeps table coords identical and canvas backing store == rect×DPR.
Box objects: drag draws a keyframe (a frame that already has one → new object) · corner/edge drag resizes, interior drag moves (marks ✎) · Undo/Redo buttons (drag = 1 entry) · dashed interpolated box between keyframes · right-click inside the box deletes it (manual/SAM box modes) · SAM points: left = +, right = −, right-click a marker removes it · SAM controls disabled when models are missing.
Viewing mode: point objects show only the crosshair (alpha 255), box objects only their rendered fill (canvas alpha ≈ 64 = 25%) — no dots, splines or outlines; canvas clicks do nothing; box toolbar hidden, undo/redo disabled; a stale render is hidden until Render is pressed again.

## Gotchas
- `favicon.ico` 404s in console — pre-existing noise, filter it when collecting console errors (by `msg.location().url`; the text has no URL).
- The first `HEAD /api/sam/embed` for a new frame is a 404 by design (not cached yet) and also shows as a console error.
- Test exports land in `_OUTPUT/` on the host — delete them after verifying.
