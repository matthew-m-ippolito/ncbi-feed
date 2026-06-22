"""One-time: fetch author affiliations from PubMed for every existing article -> affiliations.json.

efetch returns 200 records/request, so this is fast. Checkpoints after each batch (so partial
progress survives an interruption). Does NOT deploy — the caller commits docs/affiliations.json
together with the frontend that displays it.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import pubmed          # noqa: E402
import store           # noqa: E402
import affil_simplify  # noqa: E402


def log(*a):
    print(*a, flush=True)


cfg = json.load(open(os.path.join(ROOT, "config.json")))
p = cfg["paths"]
art_path = os.path.join(ROOT, p["articles"])
aff_path = os.path.join(ROOT, p["affiliations"])
e = cfg["eutils"]
pm = pubmed.PubMed(e.get("tool", "ncbi-feed"), e.get("email", ""), e.get("api_key", ""))

existing = store.load_articles(art_path)
pmids = list(existing.keys())
log("fetching affiliations for %d articles ..." % len(pmids))

store_aff = store.load_affiliations(aff_path)
CH = 200
done = 0
for i in range(0, len(pmids), CH):
    chunk = pmids[i:i + CH]
    try:
        full = pm.efetch_full(chunk)
    except Exception as ex:
        log("  batch %d failed (%s); continuing" % (i // CH, ex))
        continue
    for pid, d in full.items():
        s = affil_simplify.simplify_list(d.get("affiliations") or [])   # verbose -> "Institution, Country"
        if s:
            store_aff[pid] = s
    done += len(chunk)
    store.save_affiliations(aff_path, store_aff)   # checkpoint
    log("  %d/%d processed | %d with affiliations" % (done, len(pmids), len(store_aff)))

log("DONE: %d/%d articles have affiliations -> %s" % (len(store_aff), len(pmids), p["affiliations"]))
