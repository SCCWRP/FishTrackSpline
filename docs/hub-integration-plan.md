# FishTrackSpline on the ArtificialIntelligenceHub

Status: **proposed** (2026-09-25). This plan **assumes the ArtificialIntelligenceHub is implemented** as
planned in `ArtificialIntelligenceHub/docs/platform-plan.md`. That repo is the source of truth for
the platform. The names, ports, headers and paths below reflect that plan as of this date.
**The Hub may change while it is being built. Before implementing anything here, check the Hub's
current docs and code, adapt these details to match, and update this file.**

## What the Hub provides

- `https://ai.sccwrp.org` via CloudFront (TLS) → an nginx **gateway** on the server → a Django app.
- **Django owns all auth:** users, login, and per-service roles as Django Groups. The gateway checks
  every request with Django (`auth_request`) before forwarding it to a microservice.
- FishTrackSpline is served under **`/fishtrack/`**, with the prefix stripped before the request reaches the app.
- Each allowed request carries trusted headers set by the gateway (client-sent values are overwritten):
  - `X-User`: the username
  - `X-User-Roles`: comma-separated effective roles
- Roles form a ladder, and each includes the ones below:
  **viewer < downloader < annotator < uploader**.

  | Role | Unlocks in FishTrackSpline |
  |---|---|
  | viewer | the player, video streaming, listing and loading annotation sets (read-only) |
  | downloader | + the set zip download |
  | annotator | + editing, MobileSAM, Save to _OUTPUT |
  | uploader | + video upload |

  The Hub enforces this per method and path (the rule table lives in the Hub's Django). The
  downloader level exists to limit egress from bulk downloads, not for secrecy.

## What FishTrackSpline must do (the contract)

1. **Run as an internal container:** on the Hub's Docker network (`apps`) as `fishtrackspline:8000`, with
   **no published ports**. Only the gateway can reach it.
2. **Work under a path prefix:** every frontend URL relative (`api/…`, `uploads/…`, `models/…`, and the
   `<script>`/`<link>` tags), so the same build works at `/` locally and at `/fishtrack/` on the Hub.
3. **Trust the gateway's headers, with dev defaults:** no `X-User` → `local` user with all roles, so local
   Docker runs keep working without the Hub.
4. **`GET /api/me`** → `{user, roles}`. The UI hides or disables Download (below downloader), editing, SAM
   and Save (below annotator), and Upload (below uploader). This only avoids buttons that would 403:
   the Hub is the enforcer.
5. **Record authorship:** `saved_by` (from `X-User`) in `meta.json` and the annotation-set index.
6. **`GET /api/health`** for Docker healthchecks.
7. **Be deployable:** a production image and compose file, deployed by GitHub Actions. See `docs/cicd-plan.md`.

This supersedes `docs/auth-plan.md` (JWT/RBAC inside this app, branch `auth-jwt-rbac`).

## Check against the Hub before implementing

- Network name, the service name the gateway expects, and the path prefix.
- Header names and the role names and order (`fishtrack-viewer` … `fishtrack-uploader` groups → role strings).
- Which FishTrackSpline paths map to which role, especially `GET /api/sam/status` (planned as viewer,
  because the UI calls it on load for every user) and the zip download (downloader).
- How unauthenticated API calls fail (planned: 401 for `fetch()`, redirect to login for page loads),
  so the frontend can show a "session expired" message instead of breaking.
- Upload size limits and timeouts at CloudFront and the gateway, against real video sizes.
