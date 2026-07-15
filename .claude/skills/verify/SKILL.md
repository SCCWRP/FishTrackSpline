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
Server code and `static/` are bind-mounted with `--reload`, so frontend/backend edits apply without rebuilding; rebuild only when deps change.

## Smoke checks (curl)
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/                  # 200
curl -sI -H "Range: bytes=0-99" \
  http://localhost:8000/videos/720p/GOPR7611_trim_720_16s.mp4 | head -1          # 206 (mp4 seeking)
curl -s -X POST http://localhost:8000/api/export -H 'Content-Type: application/json' \
  -d '{"filename":"t.csv","content":"x"}'                                        # writes _OUTPUT/t.csv on host
```

## Drive the UI (Playwright, system Chrome)
No repo-local Playwright; install in a scratch dir: `npm i playwright` then
`chromium.launch({ channel: 'chrome', headless: true })` (uses installed Google Chrome, no browser download).

Key selectors: `#video #overlay #stage #pointsBody #pointsCaption #objectList #addObjectBtn #playBtn #scrubber #saveOutputBtn #downloadBtn #exportStatus #stageHint`.

Recipe that works:
- Wait for load: `page.waitForFunction(() => document.getElementById('video')?.videoWidth > 0)`.
- Seek deterministically via `video.currentTime = t` in `page.evaluate`, then waitForFunction on it (don't rely on playback timing).
- Click the overlay at fractional coords of `#overlay`'s boundingBox; the app stores normalized 0-1 coords, so a click at fraction (0.3, 0.4) must produce a table row `x=0.300 y=0.400` exactly.
- Assert canvas actually painted via `getImageData` alpha counts (or count pixels near an object's palette color, e.g. `#F28E2B` for fish 2, ±25 tolerance).
- `confirm()` dialogs (object delete): `page.on('dialog', d => d.accept())`.
- Points table rows read as `"2.000.3000.400⌖✕"` (concatenated tds).

## Worth re-driving after changes
Click-to-add + EPS_T replace (re-click same paused time → still 1 row) · drag a point (t fixed, x/y change) · click point = seek; click other object's point = switch active + seek · right-click = delete · visibility eye zeroes that object's painted pixels · Space/←/→ keys (arrow step = 1/30 s) · export writes both files into `_OUTPUT/` and triggers 2 downloads · `?video=bad.mp4` shows the stage-hint error · viewport resize keeps table coords identical and canvas backing store == rect×DPR.

## Gotchas
- `favicon.ico` 404s in console — pre-existing noise, filter it when collecting console errors.
- Test exports land in `_OUTPUT/` on the host — delete them after verifying.
