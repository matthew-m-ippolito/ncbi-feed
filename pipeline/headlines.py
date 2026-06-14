"""Plain-language headline generation via the local `claude` CLI (no API key).

Batches titles (+ abstract context) to `claude -p`, parses a JSON array back,
caches successful headlines by PMID so each paper is rewritten only once, and
falls back to a cleaned title if the model errors. Batches run concurrently.
"""
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
CACHE_FILE = os.path.join(CACHE_DIR, "headlines.json")

PROMPT_HEAD = (
    "You rewrite technical biomedical article titles into plain-English news headlines "
    "for a malaria researcher's feed. Rules: each headline <= %d words; accurate to the "
    "title/abstract; no hype, no clickbait, no invented findings; plain vocabulary a "
    "non-specialist understands; do not add facts not present. Output ONLY a JSON array, "
    'no prose and no code fence: [{"id":"<id>","headline":"<headline>"}]\n\nArticles:\n'
)


def clean_title(t):
    return re.sub(r"\s+", " ", t or "").strip().rstrip(".")


def _trim(h):
    h = re.sub(r"\s+", " ", str(h or "")).strip()
    return h.strip('"').strip("'").rstrip(".").strip()


def _load_cache():
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(c):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f)
    os.replace(tmp, CACHE_FILE)


def _build_prompt(batch, max_words, abs_chars):
    lines = [PROMPT_HEAD % max_words]
    for it in batch:
        line = "id=%s | title=%s" % (it["id"], it["title"])
        ab = (it.get("abstract") or "").strip()
        if ab:
            line += " | abstract=" + ab[:abs_chars].replace("\n", " ")
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
    prompt = _build_prompt(batch, cfg["max_words"], cfg["abstract_chars"])
    res = {}
    for _ in range(2):  # one retry if incomplete/malformed
        try:
            out = _call_claude(prompt, cfg["model"], cfg.get("timeout", 180))
        except Exception:
            out = ""
        arr = _extract_json(out)
        if arr:
            for o in arr:
                if isinstance(o, dict) and o.get("id") and o.get("headline"):
                    res[str(o["id"])] = _trim(o["headline"])
            if all(it["id"] in res for it in batch):
                break
    return res


def generate(items, cfg, log=print):
    """items: [{id, title, abstract}] -> {id: headline}. Caches LLM headlines."""
    cache = _load_cache()
    out = {}
    todo = []
    for it in items:
        if it["id"] in cache:
            out[it["id"]] = cache[it["id"]]
        else:
            todo.append(it)
    if not todo:
        return out

    bs = max(1, int(cfg.get("batch_size", 30)))
    batches = [todo[i:i + bs] for i in range(0, len(todo), bs)]
    workers = max(1, int(cfg.get("workers", 6)))
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
                if it["id"] in res:
                    out[it["id"]] = res[it["id"]]
                    cache[it["id"]] = res[it["id"]]       # cache real headlines only
                else:
                    out[it["id"]] = clean_title(it["title"])  # fallback; retried next run
            done += 1
            if done % 5 == 0 or done == len(batches):
                log("    %d/%d batches" % (done, len(batches)))
                _save_cache(cache)
    _save_cache(cache)
    return out
