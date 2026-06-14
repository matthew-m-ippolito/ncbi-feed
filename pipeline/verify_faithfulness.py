"""Audit detailed summaries for faithfulness to their abstracts.

(1) Numeric audit: flag summaries with a decimal/large number not literally in the abstract.
(2) LLM verify the flagged candidates AND a random sample, to find real hallucinations and
    estimate the base error rate. Writes unfaithful PMIDs to .cache/unfaithful.json.
"""
import json
import os
import re
import random
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import headlines

arts = json.load(open(os.path.join(ROOT, "docs/articles.json")))["articles"]
ab = json.load(open(os.path.join(ROOT, "docs/abstracts.json")))["abstracts"]
model = json.load(open(os.path.join(ROOT, "config.json")))["headlines"]["model"]
byid = {a["id"]: a for a in arts}


def norm(s):
    return s.replace("·", ".").replace("−", "-").replace("–", "-").replace(",", "").lower()


claim_re = re.compile(r'\d+\.\d+|\d{3,}')
flagged = []
for a in arts:
    abst = ab.get(a["id"])
    if not abst or not a.get("details"):
        continue
    A = norm(abst)
    if any(n not in A for n in set(claim_re.findall(norm(a["details"])))):
        flagged.append(a["id"])

random.seed(7)
pool = [a["id"] for a in arts if a.get("details") and a["id"] in ab and a["id"] not in set(flagged)]
sample = random.sample(pool, min(50, len(pool)))

PROMPT = (
    "For each item you get an article ABSTRACT and a one-paragraph SUMMARY. Check whether EVERY "
    "specific number, drug, location, parasite species, and finding stated in the SUMMARY is "
    "directly supported by the ABSTRACT. Correct rounding and values clearly derivable from the "
    "abstract are acceptable. Flag only invented, wrong, or contradicted numbers/claims. "
    'Output ONLY a JSON array: [{"id":"..","faithful":true,"issues":""}] '
    "(issues = short description of any unsupported items, else empty).\n\n"
)


def verify_batch(ids):
    p = PROMPT
    for i in ids:
        p += "id=%s\nSUMMARY: %s\nABSTRACT: %s\n\n" % (i, byid[i]["details"], ab[i][:6000])
    out = headlines._call_claude(p, model, 240)
    arr = headlines._extract_json(out) or []
    return {str(o["id"]): o for o in arr if isinstance(o, dict) and o.get("id")}


def run(ids, bs=6):
    batches = [ids[i:i + bs] for i in range(0, len(ids), bs)]
    res = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(verify_batch, b) for b in batches]
        for f in as_completed(futs):
            try:
                res.update(f.result())
            except Exception:
                pass
    return res


print("flagged (numeric audit):", len(flagged), "| random sample:", len(sample), flush=True)
fr = run(flagged)
sr = run(sample)


def unfaithful(res, ids):
    return [(i, res[i].get("issues", "")) for i in ids
            if i in res and res[i].get("faithful") is False]


fu = unfaithful(fr, flagged)
su = unfaithful(sr, sample)
print("\nFLAGGED: %d checked, %d verified, %d UNFAITHFUL" % (len(flagged), len(fr), len(fu)))
print("RANDOM:  %d checked, %d verified, %d unfaithful (base rate ~%.1f%%)"
      % (len(sample), len(sr), len(su), 100 * len(su) / max(1, len(sr))))
print("\n--- real issues among flagged ---")
for i, iss in fu[:25]:
    print("PMID %s: %s" % (i, iss[:150]))
    print("   →", byid[i]["details"][:150])

bad = [i for i, _ in fu] + [i for i, _ in su]
json.dump(bad, open(os.path.join(HERE, ".cache", "unfaithful.json"), "w"))
print("\nsaved %d unfaithful PMIDs to pipeline/.cache/unfaithful.json" % len(bad))
