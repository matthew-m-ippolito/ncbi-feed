"""Adversarial faithfulness check + correction for article summaries.

Used to vet NEW imports in the daily pipeline (and as a post-sweep QA pass): a strict
fact-checker flags any claim/number/year/location in a summary not supported by the
abstract; flagged summaries are rewritten and (optionally) re-checked.
"""
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import headlines  # reuse _call_claude, _extract_json, _trim

CHECK_PROMPT = (
    "You are a STRICT adversarial fact-checker. For each item you get an article ABSTRACT and a "
    "SUMMARY written about it. Flag EVERY claim, number, statistic, year/date, study period, "
    "country/region/city/location, drug, sample size, or finding in the SUMMARY that is NOT "
    "explicitly stated in (or directly arithmetic from) the ABSTRACT. Be skeptical: anything "
    "inferred, guessed, generalized from outside knowledge, or added is a problem. "
    'Output ONLY a JSON array: [{"id":"..","ok":true,"problems":[]}] '
    "— set ok=false and list the problems if ANY unsupported item exists.\n\n"
)

CORRECT_PROMPT = (
    "Rewrite each article SUMMARY so that EVERY number, year, date, location, drug, sample size, "
    "and finding is explicitly supported by the ABSTRACT. Remove or omit anything not in the "
    "abstract — especially the items listed in PROBLEMS. Never add facts not in the abstract. "
    "Keep it 2-4 sentences, accurate, plain English, leading with the main result. "
    'Output ONLY a JSON array: [{"id":"..","details":".."}]\n\n'
)


def _run(batches, fn, workers):
    out = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(fn, b) for b in batches]
        for f in as_completed(futs):
            try:
                out.update(f.result() or {})
            except Exception:
                pass
    return out


def check(pairs, cfg, log=print):
    """pairs: [{id, summary, abstract}] -> {id: {ok, problems}}"""
    bs, workers = 5, cfg.get("workers", 6)
    batches = [pairs[i:i + bs] for i in range(0, len(pairs), bs)]

    def do(batch):
        ids = [it["id"] for it in batch]
        p = CHECK_PROMPT
        for it in batch:
            p += "id=%s\nSUMMARY: %s\nABSTRACT: %s\n\n" % (
                it["id"], it["summary"], (it.get("abstract") or "")[:5000])
        got = {}
        for _ in range(3):  # retry until every id in the batch comes back
            arr = headlines._extract_json(headlines._call_claude(p, cfg["model"], cfg.get("timeout", 300))) or []
            for x in arr:
                if isinstance(x, dict) and x.get("id"):
                    got[str(x["id"])] = x
            if all(i in got for i in ids):
                break
            time.sleep(2)
        return got

    return _run(batches, do, workers)


def correct(items, cfg, log=print):
    """items: [{id, summary, abstract, problems}] -> {id: new_details}"""
    bs, workers = 4, cfg.get("workers", 6)
    batches = [items[i:i + bs] for i in range(0, len(items), bs)]

    def do(batch):
        ids = [it["id"] for it in batch]
        p = CORRECT_PROMPT
        for it in batch:
            p += "id=%s\nPROBLEMS: %s\nCURRENT SUMMARY: %s\nABSTRACT: %s\n\n" % (
                it["id"], "; ".join(it.get("problems") or []), it["summary"],
                (it.get("abstract") or "")[:5000])
        got = {}
        for _ in range(3):
            arr = headlines._extract_json(headlines._call_claude(p, cfg["model"], cfg.get("timeout", 300))) or []
            for x in arr:
                if isinstance(x, dict) and x.get("id") and x.get("details"):
                    got[str(x["id"])] = headlines._trim(x["details"])
            if all(i in got for i in ids):
                break
            time.sleep(2)
        return got

    return _run(batches, do, workers)


def verify_and_correct(full_items, gen, cfg, log=print, rounds=2):
    """full_items: [{id, title, abstract}]; gen: {id: {headline, details, ...}}.
    Adversarially checks each summary, rewrites failures in place. Returns (gen, stats)."""
    byid = {it["id"]: it for it in full_items}
    total_flagged = total_fixed = 0
    for r in range(rounds):
        pairs = [{"id": i, "summary": gen[i]["details"], "abstract": byid[i].get("abstract", "")}
                 for i in gen if i in byid and gen[i].get("details") and byid[i].get("abstract")]
        if not pairs:
            break
        res = check(pairs, cfg, log)
        failed = [i for i in res if res[i].get("ok") is False]
        log("  adversarial check (round %d): %d checked, %d flagged" % (r + 1, len(res), len(failed)))
        if not failed:
            break
        total_flagged = max(total_flagged, len(failed))
        fixes = correct([{"id": i, "abstract": byid[i].get("abstract", ""),
                          "summary": gen[i]["details"], "problems": res[i].get("problems") or []}
                         for i in failed], cfg, log)
        for i, det in fixes.items():
            if det:
                gen[i]["details"] = det
                total_fixed += 1
        log("  rewrote %d flagged summaries" % len(fixes))
    return gen, {"flagged": total_flagged, "fixed": total_fixed}
