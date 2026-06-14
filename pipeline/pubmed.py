"""Minimal NCBI E-utilities client: esearch + esummary + efetch (abstracts).

Reads PubMed directly so the pipeline never needs Gmail. Polite by default
(rate-limited, tool/email tagged, retries with backoff).
"""
import time
import warnings
warnings.filterwarnings("ignore")  # silence urllib3 version warning (before requests import)
import requests
from lxml import etree

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
ESUMMARY_CHUNK = 200
EFETCH_CHUNK = 200


class PubMed:
    def __init__(self, tool="ncbi-feed", email="", api_key=""):
        self.tool = tool
        self.email = email
        self.api_key = api_key
        self.delay = 0.11 if api_key else 0.35  # ~9/s with key, ~3/s without
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "ncbi-feed/1.0 (%s)" % (email or "anon")})

    def _params(self, extra):
        p = {"tool": self.tool, "email": self.email}
        if self.api_key:
            p["api_key"] = self.api_key
        p.update(extra)
        return p

    def _get(self, endpoint, params):
        url = BASE + endpoint
        last = None
        for attempt in range(5):
            try:
                r = self.s.get(url, params=self._params(params), timeout=60)
                if r.status_code == 200:
                    time.sleep(self.delay)
                    return r
                last = "HTTP %d" % r.status_code
                if r.status_code not in (429, 500, 502, 503, 504):
                    r.raise_for_status()
            except requests.RequestException as e:
                last = str(e)
            time.sleep(min(2 ** attempt, 8) + 0.3)
        raise RuntimeError("E-utilities request failed (%s): %s" % (endpoint, last))

    # ---- esearch ----
    def esearch(self, query, mindate=None, maxdate=None, reldate=None,
                datetype="edat", retmax=10000):
        """Return (pmids, total_count). PMIDs are strings, newest first."""
        params = {"db": "pubmed", "term": query, "retmode": "json",
                  "datetype": datetype, "retmax": retmax, "sort": "date"}
        if reldate is not None:
            params["reldate"] = reldate
        if mindate:
            params["mindate"] = mindate
        if maxdate:
            params["maxdate"] = maxdate
        ids, total, start = [], None, 0
        while True:
            params["retstart"] = start
            res = self._get("esearch.fcgi", params).json()["esearchresult"]
            total = int(res.get("count", "0"))
            batch = res.get("idlist", [])
            ids.extend(batch)
            start += len(batch)
            if not batch or start >= total or start >= retmax:
                break
        return ids, total

    def count(self, query, **kw):
        kw["retmax"] = 0
        _, total = self.esearch(query, **kw)
        return total

    # ---- esummary ----
    def esummary(self, pmids):
        """pmid -> {title, journal, authors, date, doi, url}"""
        out = {}
        for i in range(0, len(pmids), ESUMMARY_CHUNK):
            chunk = pmids[i:i + ESUMMARY_CHUNK]
            res = self._get("esummary.fcgi", {
                "db": "pubmed", "retmode": "json", "id": ",".join(chunk)
            }).json().get("result", {})
            for pid in res.get("uids", []):
                d = res.get(pid, {})
                out[pid] = {
                    "title": _clean(d.get("title", "")),
                    "journal": d.get("source", "") or d.get("fulljournalname", ""),
                    "authors": _authors(d.get("authors", [])),
                    "date": _date(d.get("sortpubdate") or d.get("epubdate") or d.get("pubdate", "")),
                    "doi": _doi(d),
                    "url": "https://pubmed.ncbi.nlm.nih.gov/%s/" % pid,
                }
        return out

    # ---- efetch (abstracts) ----
    def efetch_abstracts(self, pmids):
        """pmid -> abstract text (only for articles that have one)."""
        out = {}
        for i in range(0, len(pmids), EFETCH_CHUNK):
            chunk = pmids[i:i + EFETCH_CHUNK]
            r = self._get("efetch.fcgi", {
                "db": "pubmed", "rettype": "abstract", "retmode": "xml",
                "id": ",".join(chunk)
            })
            try:
                root = etree.fromstring(r.content)
            except etree.XMLSyntaxError:
                continue
            for art in root.iter("PubmedArticle"):
                pid = art.findtext(".//MedlineCitation/PMID")
                if not pid:
                    continue
                parts = []
                for node in art.findall(".//Abstract/AbstractText"):
                    txt = "".join(node.itertext()).strip()
                    if not txt:
                        continue
                    label = node.get("Label")
                    parts.append((label.upper() + ": " + txt) if label else txt)
                if parts:
                    out[pid] = "\n\n".join(parts)
        return out


def _clean(s):
    if not s:
        return ""
    import re
    s = re.sub(r"<[^>]+>", "", s)          # strip light markup esummary may carry
    return re.sub(r"\s+", " ", s).strip()


def _authors(authors):
    names = [a.get("name", "") for a in authors if a.get("authtype", "Author") == "Author" and a.get("name")]
    if not names:
        names = [a.get("name", "") for a in authors if a.get("name")]
    return ", ".join(names)  # full list; the app shows it in an Authors peek


def _date(s):
    if not s:
        return ""
    s = s.split(" ")[0].replace("/", "-")
    bits = s.split("-")
    if len(bits) == 1:
        return bits[0] + "-01-01"
    if len(bits) == 2:
        return bits[0] + "-" + bits[1].zfill(2) + "-01"
    return "%s-%s-%s" % (bits[0], bits[1].zfill(2), bits[2].zfill(2))


def _doi(d):
    for a in d.get("articleids", []):
        if a.get("idtype") == "doi":
            return a.get("value", "")
    return ""
