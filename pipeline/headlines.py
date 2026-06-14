"""Plain-language headline + detailed-summary generation via the local `claude` CLI.

For each article, one model call produces BOTH:
  - headline: short, scannable, <= headline_words words
  - details : a 2-4 sentence summary carrying the study's specifics and main results
Results are cached by PMID (so each paper is processed once); a model error falls
back to a cleaned title. Batches run concurrently.
"""
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
CACHE_FILE = os.path.join(CACHE_DIR, "headlines.json")

PROMPT_HEAD = (
    "You summarize biomedical articles for a malaria researcher's feed. For EACH article, "
    "using its TITLE and ABSTRACT, produce: "
    '(1) "headline": a short, plain-English headline of at most %d words capturing the topic '
    "at a glance (scannable); "
    '(2) "details": a detailed plain-English summary of 2-4 sentences (up to about %d words) '
    "giving the study design and population/sample size, the exact intervention, exposure, or "
    "question (specific drugs and doses, parasite species such as P. falciparum or P. vivax, "
    "and precise clinical entities such as cerebral malaria vs severe malarial anemia, or "
    "artemisinin partial resistance with Kelch13 mutations), and MOST IMPORTANTLY the main "
    "quantitative results (cure rates, prevalence %%, odds/hazard ratios, effect sizes, "
    "p-values) and the authors' conclusion; "
    '(3) "notable": a boolean -- true ONLY if this is a likely paradigm-shifting, '
    "practice-changing, or landmark advance (e.g. first demonstration of a major effect, a "
    "novel mechanism or drug target with broad implications, a large definitive or phase-3 "
    "trial likely to change guidelines, a major drug-resistance or transmission breakthrough, "
    "a new vaccine efficacy result). Be CONSERVATIVE: the large majority of papers are "
    "routine, incremental, descriptive, single-site, or review/protocol papers and must be "
    'false; and (4) "notable_reason": if notable is true, at most 10 words on why; else "". '
    "For headline and details: include ONLY facts and numbers stated in the abstract; NEVER "
    "invent or estimate numbers, drugs, locations, or findings; if a detail is not in the "
    "abstract, omit it. Prefer exact entities over vague words. No hype, no clickbait. If no "
    "abstract is provided, base headline/details on the title, set notable false, and do not "
    "fabricate results. Output ONLY a JSON array, no prose and no code fence: "
    '[{"id":"<id>","headline":"<short>","details":"<detailed>","notable":false,"notable_reason":""}]'
    "\n\nArticles:\n"
)


def clean_title(t):
    return re.sub(r"\s+", " ", t or "").strip().rstrip(".")


def _trim(h):
    h = re.sub(r"\s+", " ", str(h or "")).strip()
    return h.strip('"').strip("'").strip()


def clear_cache():
    try:
        os.remove(CACHE_FILE)
    except OSError:
        pass


def _load_cache():
    try:
        with open(CACHE_FILE) as f:
            c = json.load(f)
        return c if isinstance(c, dict) else {}
    except Exception:
        return {}


def _save_cache(c):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f)
    os.replace(tmp, CACHE_FILE)


def _build_prompt(batch, cfg):
    lines = [PROMPT_HEAD % (cfg.get("headline_words", 12), cfg.get("max_words", 90))]
    ac = cfg.get("abstract_chars", 3500)
    for it in batch:
        line = "id=%s | title=%s" % (it["id"], it["title"])
        ab = (it.get("abstract") or "").strip()
        if ab:
            line += " | abstract=" + ab[:ac].replace("\n", " ")
        lines.append(line)
    return "\n".join(lines)


def _extract_json(out):
    if not out:
        return None
    i, j = out.find("["), out.rfind("]")
    if i == -1 or j == -1 or j < i:
        return None
    try:
        return json.loads(out[i:j + 1])
    except Exception:
        return None


def _call_claude(prompt, model, timeout):
    p = subprocess.run(
        ["claude", "-p", prompt, "--model", model],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
    )
    return p.stdout


def _process_batch(batch, cfg):
    prompt = _build_prompt(batch, cfg)
    res = {}
    for _ in range(2):  # one retry if incomplete/malformed
        try:
            out = _call_claude(prompt, cfg["model"], cfg.get("timeout", 240))
        except Exception:
            out = ""
        arr = _extract_json(out)
        if arr:
            for o in arr:
                if isinstance(o, dict) and o.get("id") and o.get("headline"):
                    res[str(o["id"])] = {
                        "headline": _trim(o["headline"]).rstrip("."),
                        "details": _trim(o.get("details", "")),
                        "notable": bool(o.get("notable")),
                        "notable_reason": _trim(o.get("notable_reason", "")),
                    }
            if all(it["id"] in res for it in batch):
                break
    return res


def generate(items, cfg, log=print):
    """items: [{id, title, abstract}] -> {id: {headline, details}}. Caches results."""
    cache = _load_cache()
    out = {}
    todo = []
    for it in items:
        c = cache.get(it["id"])
        if isinstance(c, dict) and c.get("headline"):
            out[it["id"]] = c
        else:
            todo.append(it)
    if not todo:
        return out

    bs = max(1, int(cfg.get("batch_size", 12)))
    batches = [todo[i:i + bs] for i in range(0, len(todo), bs)]
    workers = max(1, int(cfg.get("workers", 8)))
    log("  headlines: %d cached, %d new in %d batches (x%d workers)"
        % (len(out), len(todo), len(batches), workers))

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_process_batch, b, cfg): b for b in batches}
        for fut in as_completed(futs):
            b = futs[fut]
            try:
                res = fut.result() or {}
            except Exception:
                res = {}
            for it in b:
                if it["id"] in res and res[it["id"]].get("headline"):
                    out[it["id"]] = res[it["id"]]
                    cache[it["id"]] = res[it["id"]]
                else:
                    out[it["id"]] = {"headline": clean_title(it["title"]),
                                     "details": clean_title(it["title"]),
                                     "notable": False, "notable_reason": ""}
            done += 1
            if done % 5 == 0 or done == len(batches):
                log("    %d/%d batches" % (done, len(batches)))
                _save_cache(cache)
    _save_cache(cache)
    return out
