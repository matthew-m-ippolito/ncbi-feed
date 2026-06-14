#!/usr/bin/env python3
"""NCBI Feed pipeline orchestrator.

Modes:
  (default)    daily: pull articles added in the last `daily_reldate_days`
  --backfill   pull the whole backlog (config mindate .. today)
  --days N     pull the last N days
  --limit N    cap the number of NEW articles processed (for testing)
  --count-only just report how many match / are new, then exit
  --no-deploy  build data files locally but don't git push

Flow: esearch -> dedup vs existing -> esummary + efetch (abstracts)
      -> plain-language headlines (claude CLI) -> write articles.json/abstracts.json
      -> update state -> (optional) git commit & push to GitHub Pages.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import pubmed
import headlines
import store


def log(*a):
    print(*a, flush=True)


def headlines_cfg(cfg):
    h = dict(cfg["headlines"])
    h["projects"] = []  # auto-tagging disabled; projects are assigned manually in the app
    return h


def load_config():
    with open(os.path.join(ROOT, "config.json")) as f:
        return json.load(f)


def load_secrets():
    path = os.environ.get("NCBI_FEED_SECRETS",
                          os.path.expanduser("~/.config/ncbi-feed/secrets.env"))
    sec = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    sec[k.strip()] = v.strip()
    except Exception:
        pass
    return sec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--days", type=int)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--count-only", action="store_true")
    ap.add_argument("--regen-headlines", action="store_true",
                    help="rewrite headlines for all existing articles (no PubMed refetch)")
    ap.add_argument("--no-deploy", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    p = cfg["paths"]
    art_path = os.path.join(ROOT, p["articles"])
    abs_path = os.path.join(ROOT, p["abstracts"])
    state_path = os.path.join(ROOT, p["state"])

    if args.regen_headlines:
        regen_headlines(cfg, art_path, abs_path)
        if not args.no_deploy:
            deploy(cfg)
        return

    e = cfg["eutils"]
    pm = pubmed.PubMed(e.get("tool", "ncbi-feed"), e.get("email", ""), e.get("api_key", ""))
    query = cfg["query"]

    kw = {}
    if args.days:
        kw["reldate"] = args.days
    elif args.backfill:
        kw["mindate"] = cfg["mindate"]
        kw["maxdate"] = date.today().strftime("%Y/%m/%d")
    else:
        kw["reldate"] = cfg.get("daily_reldate_days", 3)

    log("esearch:", query, kw)
    ids, total = pm.esearch(query, **kw)
    log("  PubMed matches: %d (fetched %d ids)" % (total, len(ids)))

    existing = store.load_articles(art_path)
    new_ids = [i for i in ids if i not in existing]
    log("  already have: %d | new: %d" % (len(ids) - len(new_ids), len(new_ids)))

    if args.count_only:
        log("count-only; exiting.")
        return

    if args.limit:
        new_ids = new_ids[:args.limit]
        log("  limited to %d new (testing)" % len(new_ids))

    if not new_ids:
        log("nothing new; no write.")
        return

    log("esummary for %d ..." % len(new_ids))
    meta = pm.esummary(new_ids)
    usable = [pid for pid in new_ids if meta.get(pid, {}).get("title")]
    skipped = len(new_ids) - len(usable)
    if skipped:
        log("  skipped %d ids with no summary/title" % skipped)

    log("efetch abstracts ...")
    abmap = pm.efetch_abstracts(usable)
    log("  abstracts found: %d/%d" % (len(abmap), len(usable)))

    items = [{"id": pid, "title": meta[pid]["title"], "abstract": abmap.get(pid, "")}
             for pid in usable]
    hmap = headlines.generate(items, headlines_cfg(cfg), log=log)

    today = date.today().isoformat()
    for pid in usable:
        m = meta[pid]
        hd = hmap.get(pid) or {}
        existing[pid] = {
            "id": pid, "pmid": pid,
            "headline": hd.get("headline") or headlines.clean_title(m["title"]),
            "details": hd.get("details", ""),
            "title_original": m["title"],
            "authors": m.get("authors", ""),
            "journal": m.get("journal", ""),
            "date": m.get("date") or today,
            "date_added": today,
            "source": cfg["feed_name"],
            "url": m.get("url") or ("https://pubmed.ncbi.nlm.nih.gov/%s/" % pid),
            "has_abstract": pid in abmap,
            "has_details": bool(hd.get("details")),
            "projects": hd.get("projects", []),
        }

    abstracts_store = store.load_abstracts(abs_path)
    abstracts_store.update(abmap)

    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = store.save_articles(art_path, existing, gen, cap=cfg.get("feed_cap", 0))
    store.save_abstracts(abs_path, abstracts_store)
    log("wrote %d articles, %d abstracts" % (n, len(abstracts_store)))

    stt = store.load_state(state_path)
    stt["last_run"] = gen
    stt["processed_ids"] = list(existing.keys())
    store.save_state(state_path, stt)

    if not args.no_deploy:
        deploy(cfg)


def regen_headlines(cfg, art_path, abs_path):
    """Rewrite every existing article's headline from stored title + abstract."""
    existing = store.load_articles(art_path)
    abmap = store.load_abstracts(abs_path)
    headlines.clear_cache()  # force regeneration with the current prompt
    items = [{"id": pid, "title": a.get("title_original", ""), "abstract": abmap.get(pid, "")}
             for pid, a in existing.items()]
    log("regenerating %d headlines ..." % len(items))
    hmap = headlines.generate(items, headlines_cfg(cfg), log=log)
    changed = 0
    for pid, a in existing.items():
        hd = hmap.get(pid)
        if hd and hd.get("headline"):
            a["headline"] = hd["headline"]
            a["details"] = hd.get("details", "")
            a["has_details"] = bool(hd.get("details"))
            a["projects"] = hd.get("projects", [])
            a.pop("notable", None)
            a.pop("notable_reason", None)
            changed += 1
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = store.save_articles(art_path, existing, gen, cap=cfg.get("feed_cap", 0))
    log("rewrote %d/%d headlines; wrote %d articles" % (changed, len(items), n))


def deploy(cfg):
    sec = load_secrets()
    url = sec.get("GIT_REMOTE_URL")
    if not url:
        log("no GIT_REMOTE_URL in secrets; data written locally, skipping push.")
        return

    def git(*a):
        return subprocess.run(["git", "-C", ROOT] + list(a), capture_output=True, text=True)

    git("add", cfg["paths"]["docs"])
    if not git("status", "--porcelain").stdout.strip():
        log("no changes to push.")
        return
    msg = "Update feed " + datetime.now().strftime("%Y-%m-%d %H:%M")
    git("-c", "user.name=ncbi-feed bot", "-c", "user.email=ncbi-feed@local",
        "commit", "-m", msg)
    pr = subprocess.run(["git", "-C", ROOT, "push", url, "main"],
                        capture_output=True, text=True)
    log("push:", "ok" if pr.returncode == 0 else ("FAILED: " + pr.stderr[:300]))


if __name__ == "__main__":
    main()
