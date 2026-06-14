# Malaria Feed — your NCBI backlog as a phone app

A plain-language, scrollable headline feed built from your **"Daily Malaria Updates"**
PubMed search (`malaria[ti] OR plasmodium[ti]`). It pulls articles straight from
NCBI's free E-utilities API (no Gmail needed), rewrites each technical title into a
short plain-English headline with the local `claude` CLI, and publishes a small static
web app you add to your iPhone home screen.

- **Triage surface:** scroll headlines, tap to read on PubMed, peek at the abstract,
  ⭐ star papers to read in full later. **All / Unread / Starred** views; the Unread
  count is your backlog burning down.
- **Stays current:** a daily job pulls new malaria/plasmodium papers and republishes.

Everything lives in this folder (`_ncbi-feed-app/`). Your research archive is untouched.

---

## How it works

```
pipeline/run.py
  esearch  → which PubMed IDs match your query (date-windowed)
  esummary → title, authors, journal, date, DOI
  efetch   → abstract
  headlines→ plain-English headline via `claude -p` (cached per PMID)
  → writes docs/articles.json + docs/abstracts.json
  → git push → GitHub Pages → your phone
```

- `config.json` — your query, feed name, backlog start date (`mindate`), settings.
- `docs/` — the web app (served by GitHub Pages from `main` / `/docs`).
- `pipeline/` — the Python pipeline (uses only `requests` + `lxml`, already installed).
- `state.json`, `logs/`, secrets — local only, never committed.

---

## One-time setup (≈ 10 minutes)

### 1. Headlines — already done
Headlines use your existing **Claude Code login** via the `claude` CLI. No API key.

### 2. GitHub (free hosting)
1. Sign in / create a free account at <https://github.com>.
2. Create a new **public** repository named **`ncbi-feed`** (no README, empty).
3. Create a **fine-grained personal access token**:
   <https://github.com/settings/tokens?type=beta> → *Generate new token*
   - **Repository access:** Only select repositories → `ncbi-feed`
   - **Permissions:** Repository permissions → **Contents: Read and write**
   - Generate, then **copy the token** (starts with `github_pat_…`).
4. Turn on Pages: repo → **Settings → Pages → Build and deployment →
   Source: Deploy from a branch → Branch: `main` / folder: `/docs` → Save.**

Your app will live at: `https://<your-username>.github.io/ncbi-feed/`

### 3. Secrets file (kept outside the repo)
```bash
mkdir -p ~/.config/ncbi-feed && chmod 700 ~/.config/ncbi-feed
cat > ~/.config/ncbi-feed/secrets.env <<'EOF'
GIT_REMOTE_URL=https://<USERNAME>:<TOKEN>@github.com/<USERNAME>/ncbi-feed.git
GITHUB_PAGES_URL=https://<USERNAME>.github.io/ncbi-feed/
EOF
chmod 600 ~/.config/ncbi-feed/secrets.env
```
The token lives ONLY in this chmod-600 file — never inside the repo.

### 4. First publish
```bash
cd "_ncbi-feed-app"
git add -A
git -c user.name="ncbi-feed bot" -c user.email="ncbi-feed@local" commit -m "Initial: app + backlog"
git push "$(grep GIT_REMOTE_URL ~/.config/ncbi-feed/secrets.env | cut -d= -f2-)" main
```
Wait ~1 minute, then open the Pages URL on your iPhone.

### 5. Add to Home Screen (iPhone, Safari)
Open the Pages URL → **Share** → **Add to Home Screen**. Launch it from the icon —
it runs full-screen like a native app, and works offline after the first load.

---

## Running the pipeline

```bash
cd "_ncbi-feed-app"
python3 pipeline/run.py --backfill     # whole backlog (mindate → today)
python3 pipeline/run.py                # daily: just the last few days
python3 pipeline/run.py --count-only --backfill   # how many match, no work
python3 pipeline/run.py --days 30      # last 30 days
python3 pipeline/run.py --no-deploy    # build locally, don't push
```
Headlines are cached in `pipeline/.cache/headlines.json`, so re-runs only rewrite
genuinely new articles.

## Daily automation (macOS launchd)
See `launchd/` and step 8 below — a LaunchAgent runs `run.py` once a day, wrapped in
`caffeinate`, logging to `logs/`. If the Mac was asleep, it catches up on next wake.

## Preview locally (optional)
```bash
python3 -m http.server 8765 --directory docs   # then open http://localhost:8765
```

## Changing your search / adding more
Edit `config.json`:
- `query` — the PubMed query (Title field tags `[ti]`, `AND`/`OR`, etc.).
- `mindate` — how far back the backlog goes (`YYYY/MM/DD`).
- To add another saved search later, we extend the pipeline to loop over multiple
  `{name, query}` entries; each becomes its own topic chip in the app.

## Troubleshooting
- **Feed didn't update:** check `logs/` and `cat state.json`. Re-run `run.py` manually.
- **Push rejected:** token expired or wrong scope — regenerate (step 2.3) and update
  `secrets.env`.
- **App shows old version after a code change:** bump `VERSION` in
  `docs/service-worker.js` so phones fetch the new files.
- **Nothing on the phone:** confirm Pages is enabled (`main`/`docs`) and the URL matches
  your username/repo.
