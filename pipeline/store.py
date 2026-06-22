"""Read/write the data files (compact JSON), dedup by PMID, track run state."""
import json
import os


def _read(path, fb):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return fb


def _write(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def load_articles(path):
    d = _read(path, {})
    arts = d.get("articles", []) if isinstance(d, dict) else []
    return {a["id"]: a for a in arts if a.get("id")}


def save_articles(path, by_id, generated_at, cap=0):
    arts = list(by_id.values())
    arts.sort(key=lambda a: (a.get("date") or a.get("date_added") or ""), reverse=True)
    if cap and len(arts) > cap:
        arts = arts[:cap]
    _write(path, {"schema": 1, "generated_at": generated_at, "articles": arts})
    return len(arts)


def load_abstracts(path):
    d = _read(path, {})
    return d.get("abstracts", {}) if isinstance(d, dict) else {}


def save_abstracts(path, mp):
    _write(path, {"schema": 1, "abstracts": mp})


def load_affiliations(path):
    d = _read(path, {})
    return d.get("affiliations", {}) if isinstance(d, dict) else {}


def save_affiliations(path, mp):
    _write(path, {"schema": 1, "affiliations": mp})


def load_state(path):
    return _read(path, {"processed_ids": [], "last_run": None})


def save_state(path, state):
    _write(path, state)
