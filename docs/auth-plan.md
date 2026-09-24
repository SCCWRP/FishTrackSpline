# Plan: auth for FishTrackSpline as a private microservice behind the Django main server

## Context
The user wants some form of auth. They're fine without Django: this service will run as a
private microservice that only their main Django web server (which has RBAC) talks to. It is
never exposed to the web. Decisions made with the user:
- **Keep FastAPI.** No Django rewrite.
- **Identity is a signed JWT per request.** The Django server authenticates the user, then
  reverse-proxies the browser's requests to this service under a path prefix (e.g.
  `/fishtrack/`), adding a short-lived HS256 JWT. This service verifies it.
- **Three roles:**
  - **viewer:** view videos, load saved sets, viewing mode, render, download.
  - **annotator:** adds editing, SAM, saving sets, uploading videos.
  - **admin:** adds deleting annotation sets and videos (new).

Work happens on the branch `auth-jwt-rbac`, created from `uploads-only-video-source`, to become
the next PR in the stack. `pyjwt` has already been added with `uv add` (pyproject.toml and
uv.lock are modified; nothing else yet).

## Design

### 1. Server auth: a pure ASGI middleware (new `auth.py`, wired in `server.py`)
- **Why a middleware.** `app.mount()` sub-apps (`/`, `/js/*`, `/uploads/*` videos) skip FastAPI
  dependencies. So a pure ASGI middleware authenticates **every** request: GET, HEAD, POST and
  DELETE, static files included. It doesn't use `BaseHTTPMiddleware`, which has problems with
  streamed Range responses and upload bodies.
- **What it does.** It stores `scope["state"]["user"] = Identity(sub, name, role)` and returns a
  401 JSON response on failure. `/api/health` is exempt, for the proxy's health checks.
- **Token checks.** `Authorization: Bearer <jwt>` is verified with
  `jwt.decode(..., algorithms=["HS256"], audience=AUTH_JWT_AUDIENCE (default "fishtrackspline"),
  issuer=AUTH_JWT_ISSUER if set, options={"require": ["exp", "aud", "sub"]}, leeway=10)`.
  Claims are `sub`, `name` and `roles` (a list). The highest known role wins; a token with no
  known role gets 403.
- **Fail closed.**
  - With no `AUTH_JWT_SECRET` (or one shorter than 32 bytes) and no dev setting, every request
    gets 503 "auth not configured".
  - `AUTH_DEV_ROLE=viewer|annotator|admin` is the local-dev bypass: a fixed identity
    `dev (auth disabled)` with that role, plus a loud startup warning.
- **Role gating.** A `require(role)` dependency gates routes; it's a 403 if the user's level is
  too low.
  - **annotator:** `POST /api/videos/upload`, `POST /api/annotation-sets`, and all SAM routes
    except status (HEAD/POST `embed`, `embedding`, `decode`, `/models/decoder.onnx`).
  - **admin:** the new deletes.
  - **viewer:** everything else.
- **New endpoints:**
  - `GET /api/me` → `{sub, name, role}`.
  - `DELETE /api/annotation-sets/{uuid}` (admin): under the store lock, remove the index entry
    and the `_OUTPUT/<uuid>/` folder.
  - `DELETE /api/videos?video=uploads/…` (admin): delete the file via `resolve_video`; saved
    sets are kept.
  - `AnnotationStore.delete()` goes in `library.py`.
- **`saved_by: {sub, name}`** is added to each index entry and `meta.json` by
  `AnnotationStore.save()`. `sam_status.decoderUrl` becomes relative (`models/decoder.onnx`).

### 2. Docker / local dev
- `docker-compose.yml` reads `AUTH_JWT_SECRET`, `AUTH_JWT_AUDIENCE`, `AUTH_JWT_ISSUER` and
  `AUTH_DEV_ROLE` from a gitignored `.env`. Commit `.env.example`, and add `.env` to
  `.gitignore`.
- The port mapping becomes `127.0.0.1:8000:8000`, so it isn't reachable from other machines.
- Without `.env`, `localhost:8000` returns 503 (fail closed). For local use, the user puts
  `AUTH_DEV_ROLE=admin` in `.env`.

### 3. Frontend
- **Relative URLs everywhere,** so the app works under `/fishtrack/`:
  - every `fetch`/XHR in `main.js`, `library.js`, `export.js`, `sam/client.js` and
    `sam/decoders.js` (`'/api/…'` → `'api/…'`);
  - the `models/decoder.onnx` path, video `src` and `state.video.url` (`` `/${id}` `` → `id`).
- **New `static/js/api.js`:** `apiFetch(path, opts)` adds `X-CSRFToken` from the `csrftoken`
  cookie on unsafe methods (Django's CSRF middleware protects the proxy view). The XHR upload
  sets the same header. The browser never sees the JWT.
- **Startup (`main.js`):** a top-level `await apiFetch('api/me')` sets
  `state.user = {sub, name, role}` and `state.readOnly = role === 'viewer'`. On 401/503 the stage
  shows a lasting notice ("Open this app through the main site"), using `state.video.notice`.
- **A `readOnly` flag for viewers,** checked where `viewMode` already is:
  - canvas input (`overlay.js`), the Delete key, and undo/redo (disabled);
  - the Add object menu, rename, and the object and keyframe ✕ buttons (hidden);
  - the box toolbar (hidden), Save to _OUTPUT, Upload and → Box (disabled);
  - SAM prefetch is skipped (it would 403).
  - Render, Download, viewing mode, and loading and switching videos and sets stay available.
- **Admin:** "Delete" buttons next to the video dropdown (current video) and the Annotations
  dropdown (selected set), each with `confirm()`. After deleting, the lists refresh; deleting
  the current video goes to the first remaining one.
- **User badge** in the top bar: `name · role`.

### 4. Django integration doc: `docs/django-integration.md`
- Settings: a shared secret that is never committed and ≥ 32 bytes, the audience, the upstream
  URL.
- A proxy view:
  - `login_required`;
  - map the user's Django groups/permissions → `roles`;
  - mint a JWT with PyJWT: `exp` = now + 60 s, plus `aud`, `sub`, `name`, `roles`;
  - **overwrite** the `Authorization` header on the upstream request.
- **Streaming,** with `httpx` (the doc lists it as the one extra dependency on the Django
  side):
  - never touch `request.body` (Django's `DATA_UPLOAD_MAX_MEMORY_SIZE` of 2.5 MB would break
    video uploads and 1080p frame PNGs);
  - stream `request` → upstream and upstream → `StreamingHttpResponse`;
  - forward `Range`, `Content-Range`, `Content-Length`, `Accept-Ranges`, `Content-Type` and the
    status (206).
- URL config: `/fishtrack` → redirect to `/fishtrack/` (relative URLs need the trailing
  slash); `/fishtrack/<path>` → the proxy.
- Notes: keep CSRF on (the frontend sends `X-CSRFToken`); `CSRF_COOKIE_HTTPONLY` must stay
  False; the service stays on a private network or loopback.

## Critical files
- New: `auth.py`, `static/js/api.js`, `docs/django-integration.md`, `.env.example`.
- Modified: `server.py` (middleware, role deps, `/api/me`, deletes, health, `saved_by`),
  `library.py` (`delete`, `saved_by`), `docker-compose.yml`, `.gitignore`.
- Modified frontend: `static/js/{main,library,export,ui,overlay,state}.js`,
  `static/js/sam/{client,decoders,convert}.js`, `static/index.html`, `static/style.css`.
- Tests: `tests/conftest.py` (token minting helper; default fixture mints an annotator/admin
  token), a new `tests/test_auth.py`, and updated `tests/test_server.py`.
- `.claude/skills/verify/SKILL.md`: smoke tests need a token or `AUTH_DEV_ROLE`.
- Reuse: `resolve_video` and `AnnotationStore` (`library.py`), and the `state.video.notice`
  pattern in `ui.js`.

## Verification
- **`uv run pytest`:**
  - 401 without a token on `/`, `/js/main.js`, `/uploads/<file>`, `/api/videos` and HEAD
    `/api/sam/embed` (the mounts are the critical cases);
  - forged signature, expired, wrong `aud`, `alg: none` and a missing `exp` are all rejected;
  - the fail-closed defaults (no secret, short secret → 503) and the dev role;
  - the full role matrix (viewer/annotator/admin → 200/403 per route);
  - `saved_by` recorded; admin deletes; Range still returns 206 through the middleware; a
    streamed upload still works.
- **`node --test tests/js/`:** unchanged, plus the `api.js` CSRF header helper.
- **Playwright** against Docker with `AUTH_JWT_SECRET` set, injecting a real JWT per role via
  `extraHTTPHeaders` (simulating the proxy):
  - the viewer sees read-only UI and gets no 403s in the console;
  - the annotator can edit, use SAM and save (the set records `saved_by`);
  - the admin sees and uses the Delete buttons;
  - with no token, the page shows the notice.
- **The real gate: a throwaway Django project in the scratchpad** (its own uv project, not a
  repo dependency) running the doc's proxy view at `/fishtrack/`, with a logged-in user in the
  annotator group. Through the proxy, the browser must:
  - load the app;
  - upload the 3.7 MB clip (catches the body-size bug);
  - seek the video (Range/206);
  - run SAM encode and decode (large POST bodies, CSRF);
  - save a set (CSRF) and load it back.
- Commit on `auth-jwt-rbac`, and offer to push it as the next stacked PR (base
  `uploads-only-video-source`).
