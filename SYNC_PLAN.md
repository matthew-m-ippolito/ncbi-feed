# Robust triage backup/sync via GitHub — plan

## Problem
Triage state (archive / important+stars / project tags) lives only in the browser's
`localStorage` — vulnerable to iOS's 7-day storage eviction and to clearing site data.
Hours of triage could vanish. Want a durable, eviction-proof backup.

## Approach: back up to the existing GitHub repo (single user, single iPhone)
No new service. The app reads/writes one file in the `ncbi-feed` repo via the GitHub
REST Contents API. localStorage stays the fast local cache; **GitHub is the durable
source of truth**. If localStorage is ever wiped, the app re-pulls from GitHub on load.

- **Where:** branch **`triage-state`**, file **`triage.json`** — a dedicated branch so it
  NEVER touches `main`/Pages (no rebuilds) and never races the daily pipeline (which only
  touches `main`).
- **Auth:** a fine-grained PAT (repo `ncbi-feed`, Contents: read/write) the user pastes into
  the app once. Stored ONLY in the iPhone's localStorage — never in the public code/repo.
  (GitHub's API is CORS-enabled for browser use; auth'd limit 5,000 req/hr — far beyond need.)

## Data model + merge
Each triage entry gets `t` (last-modified ms). Remote `triage.json`:
`{ "v":1, "updatedAt":<ms>, "items": { "<pmid>": {archived?,important?,stars?,projects?, "t":<ms>} } }`
- Merge = per-PMID last-writer-wins by `t` (cheap insurance; also recovers cleanly after
  eviction — empty local adopts remote). Never wholesale-clobber.
- Un-archive / un-tag = keep the key with cleared flags + new `t` (soft tombstone), so undos
  propagate. `prefs`/`meta` stay device-local (not synced).

## Sync timing (best-effort; app fully works if offline or token unset)
- On load (after ingest): pull→merge→render.
- After each mutation: debounced push (~2.5s).
- On tab refocus + every ~60s while visible: pull→merge.
- No token / offline / API error → stay on localStorage silently; sync when it returns.

## Components
1. **`docs/app.js`** — add `t` to mutations; GitHub sync module: `ghGet()` (GET contents,
   handle 404), `ghPut(json, sha)` (base64 PUT with branch+sha, retry once on 409),
   `ensureBranch()` (create `triage-state` from main HEAD on first use), `pullMerge()`,
   `pushDebounced()`, `syncNow()`; wire to load/visibility/interval.
2. **Settings sheet (⚙ in header)** — paste token; Save / Test / Disconnect; live status
   (Synced ✓ / Syncing… / Offline / Not set up). Plus Export / Import JSON (manual backup +
   first-device seed). Owner/repo/branch shown read-only (we already know them).
3. **`SYNC_SETUP.md`** — make a fine-grained PAT (repo ncbi-feed, Contents RW), paste into app.

## One-time user setup (~3 min, no new service)
1. Create a fine-grained PAT: repo `ncbi-feed`, Contents → Read and write.
2. App → ⚙ → paste token → Save. Done. (Repeat the paste on any other device.)

## Risks / mitigations
- **Token in browser localStorage:** scoped to one repo of public paper titles; on the user's
  own device; never in published code. Low blast radius (not broader than the pipeline token).
- **Pipeline race:** avoided entirely — separate branch the pipeline never touches.
- **Backend down / token unset:** degrades to localStorage; zero breakage.
- **Eviction recovery:** deterministic path (`triage.json@triage-state`) → re-enter token,
  app pulls it back. Export/Import JSON as extra belt-and-suspenders.
