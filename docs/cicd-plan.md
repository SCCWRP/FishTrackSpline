# CI/CD plan: GitHub Actions → internal server

Status: **proposed** (2026-09-25). **Blocked on the ai.sccwrp.org platform** (Django auth + nginx gateway +
CloudFront via CloudFormation), which is being built in the `ArtificialIntelligenceHub` repo (plan: `ArtificialIntelligenceHub/docs/platform-plan.md`). How FishTrackSpline fits in: `docs/hub-integration-plan.md`.
This file covers only FishTrackSpline's own side.

## Constraints

- Repo `SCCWRP/FishTrackSpline` is **private**.
- The server is **internal / VPN-only**, so GitHub-hosted runners cannot SSH in.
- The server runs Linux (Ubuntu/Debian) with Docker + compose. `https://ai.sccwrp.org` is served by
  CloudFront (TLS) → an nginx gateway on the server.
- FishTrackSpline is **not public-facing**. It runs as an internal microservice behind that gateway,
  which checks every request with the Django app (`auth_request`). Django owns users and roles.
- Deploy on **every merge to `main`**, using a Docker image published to **GHCR**.

## Approach

Because GitHub can't reach the server, the server reaches GitHub instead: install a
**self-hosted GitHub Actions runner** on the server. It opens outbound HTTPS to
GitHub only, so nothing new has to be opened inbound and no SSH key has to be stored in
GitHub. The deploy job runs on that runner and calls `docker compose` on the server directly.

```
PR / push ──► [GitHub-hosted] test  (pytest + node --test)
merge main ─► [GitHub-hosted] test ─► build + push ghcr.io/sccwrp/fishtrackspline:{sha,main}
                                          └─► [self-hosted, on server] deploy: pull + up -d + health check
```

Building on GitHub-hosted runners keeps the build load off the server. The server only pulls
the finished image.

## Work items

### 1. Production image and compose (repo)

The current `Dockerfile`/`docker-compose.yml` are dev-oriented: uvicorn `--reload`, and the
source is bind-mounted over the image.

- `Dockerfile`: drop `--reload` from `CMD`. Optionally add `--proxy-headers --forwarded-allow-ips=*`
  for the reverse proxy.
- Keep `docker-compose.yml` for local dev. Move the dev-only source bind mounts and `--reload`
  into `docker-compose.override.yml`, which compose loads automatically on local runs.
- Add `deploy/docker-compose.prod.yml`:
  - `image: ghcr.io/sccwrp/fishtrackspline:${TAG:-main}` (no `build:`)
  - `restart: unless-stopped`
  - **no published port**: join a shared Docker network (e.g. `external: true` network `apps`)
    that the Django stack also joins, so Django reaches it at `http://fishtrackspline:8000`.
    If Django isn't containerized, bind to `127.0.0.1:8000` instead.
  - data volumes under a server data root, e.g. `/srv/fishtrackspline/{_OUTPUT,_UPLOADS,_CACHE,_MODELS}`
  - `healthcheck` against a new `GET /api/health` endpoint (added to `server.py`)
- Add `.dockerignore` (`_*`, `.venv`, `tests`, `.git`, `docs`).

### 2. CI workflow: `.github/workflows/ci.yml`

On `pull_request` and `push` to `main`, runner `ubuntu-latest`:
- `astral-sh/setup-uv` → `uv sync --frozen` → `uv run pytest`
- `actions/setup-node` → `node --test tests/js/`
- `concurrency` cancels superseded PR runs.

Make the `test` check **required** on `main` (branch protection), so a red test blocks the merge and therefore the deploy.

### 3. Build and deploy workflow: `.github/workflows/deploy.yml`

On `push` to `main` (and `workflow_dispatch` for manual redeploys and rollbacks with a `tag` input):

- **test**: reuses the same steps as CI (`workflow_call` from `ci.yml`).
- **build** (`ubuntu-latest`, `needs: test`, `permissions: packages: write`):
  `docker/login-action` to GHCR using `GITHUB_TOKEN`, `docker/build-push-action` with GHA
  layer cache, tags `sha-<short>` and `main`.
- **deploy** (`runs-on: [self-hosted, fishtrackspline]`, `needs: build`,
  `environment: production`, `concurrency: deploy-production`, no cancel-in-progress):
  1. `docker login ghcr.io` using `GITHUB_TOKEN` (`packages: read`)
  2. `TAG=sha-<short> docker compose -f /srv/fishtrackspline/docker-compose.prod.yml pull`
  3. `... up -d --wait` (waits on the healthcheck)
  4. write the deployed tag to `/srv/fishtrackspline/.deployed` (used for rollbacks)
  5. `docker image prune -f`

**Rollback:** run the workflow manually with `tag=sha-<previous>`. It uses the same deploy job and skips the build.

The `production` environment can optionally require a reviewer's approval, as a manual gate before each deploy.

### 4. One-time server setup (manual, documented in `deploy/README.md`)

1. Create a `deploy` user in the `docker` group and `/srv/fishtrackspline/` with the data dirs.
   Copy existing `_OUTPUT`/`_UPLOADS` over if you're migrating.
2. Fetch the models once: `uv run scripts/fetch_models.py /srv/fishtrackspline/_MODELS`
   (or copy them from `_COMMON`). The models stay out of the image.
3. Install the self-hosted runner as the `deploy` user (repo → Settings → Actions → Runners → New),
   with the label `fishtrackspline`, as a systemd service (`./svc.sh install deploy`).
4. Copy `deploy/docker-compose.prod.yml` to `/srv/fishtrackspline/`. Alternatively, the deploy
   job can copy it from the checkout on every run, which keeps it versioned. I recommend that.
5. Create the shared Docker network once (`docker network create apps`). There's **no public
   proxy route of its own**: browser traffic reaches it only through the gateway. See
   "Integration with Django" below.

## Security notes

- A self-hosted runner executes workflow code from the repo. It's acceptable here because the
  repo is private, and only the `deploy` job targets it, only on `main`. Keep fork PR workflows
  disabled.
- The `deploy` user only needs Docker access. The runner is effectively root-equivalent through
  Docker, so don't reuse that host user for anything else.
- FishTrackSpline has **no auth of its own**. It trusts the gateway, so it must be reachable
  only on the internal Docker network: never publish its port.
- The gateway must **overwrite** any client-sent `X-User`/`X-User-Roles` headers, so a browser
  can't pose as another user.

## Integration with the platform

How FishTrackSpline fits the Hub (the contract it must meet, roles and what to check before implementing) is
in **`docs/hub-integration-plan.md`**. The platform itself (gateway, Django auth, CloudFront, CloudFormation,
cutover) is in `ArtificialIntelligenceHub/docs/platform-plan.md`, which is the source of truth. PR A below
includes the app-side changes.

## Open questions

- Whether to require an approval (`production` environment reviewers) before each deploy.
- Whether to migrate existing `_OUTPUT` data to the server or start fresh.
- Staging: add a `staging` compose project on the same box later if needed.

## Rollout order

0. `ArtificialIntelligenceHub` repo (`docs/platform-plan.md`): Django + gateway on `:8090`, `infra/edge.yml`, cutover.
1. PR A: prod Dockerfile/compose split, relative URLs, `X-User` → `saved_by`, `/api/me` + role-aware UI, `/api/health`, `.dockerignore`, `ci.yml`.
2. Server setup (§4). Verify with a manual `docker compose pull/up` of an image built by PR A.
3. PR B: `deploy.yml`. Merge it and watch the first automatic deploy. Test a rollback via `workflow_dispatch`.
