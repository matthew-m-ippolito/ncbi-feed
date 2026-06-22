"""Reduce a verbose PubMed affiliation to just "Institution, Country".

Pure substring selection — it only ever emits text that appears in the source affiliation
(plus a source-derived country), so it can never fabricate an institution. Heuristic:
split on commas; find the country (rightmost part that is/ends-with a known country); pick the
institution = the rightmost non-department part carrying a strong institution keyword (university,
institute, hospital, college, ministry, foundation, company suffix...), else a weak one
(school, centre, laboratory, agency, CDC/WHO...), else the first non-department part.
"""
import re

_COUNTRIES = set()
for _tok in (
    "usa|united states|united states of america|us|america|uk|united kingdom|england|scotland|"
    "wales|northern ireland|great britain|britain|ethiopia|kenya|tanzania|united republic of tanzania|"
    "uganda|nigeria|ghana|senegal|mali|burkina faso|cameroon|gabon|zambia|malawi|mozambique|"
    "south africa|sudan|south sudan|democratic republic of the congo|dr congo|drc|congo|"
    "republic of the congo|rwanda|burundi|benin|togo|ivory coast|cote d'ivoire|côte d'ivoire|gambia|"
    "guinea|guinea-bissau|equatorial guinea|sierra leone|liberia|angola|namibia|botswana|lesotho|"
    "eswatini|swaziland|zimbabwe|madagascar|mauritius|comoros|seychelles|somalia|chad|niger|"
    "central african republic|eritrea|djibouti|mauritania|cape verde|cabo verde|india|china|"
    "p.r. china|pr china|people's republic of china|prc|japan|south korea|korea|republic of korea|"
    "north korea|thailand|vietnam|viet nam|cambodia|laos|lao pdr|myanmar|burma|bangladesh|pakistan|"
    "sri lanka|nepal|bhutan|maldives|indonesia|malaysia|brunei|philippines|singapore|taiwan|"
    "hong kong|macau|mongolia|timor-leste|papua new guinea|fiji|solomon islands|vanuatu|samoa|"
    "kazakhstan|uzbekistan|turkmenistan|tajikistan|kyrgyzstan|france|germany|spain|italy|netherlands|"
    "belgium|switzerland|sweden|norway|denmark|finland|iceland|portugal|austria|ireland|greece|"
    "poland|czech republic|czechia|slovakia|slovenia|croatia|serbia|bosnia and herzegovina|"
    "montenegro|north macedonia|macedonia|albania|hungary|romania|bulgaria|moldova|lithuania|latvia|"
    "estonia|belarus|russia|russian federation|ukraine|turkey|turkiye|türkiye|cyprus|malta|"
    "luxembourg|liechtenstein|monaco|israel|palestine|brazil|argentina|colombia|peru|venezuela|"
    "ecuador|bolivia|paraguay|uruguay|chile|guyana|suriname|french guiana|mexico|méxico|panama|"
    "guatemala|honduras|el salvador|nicaragua|costa rica|belize|cuba|jamaica|haiti|"
    "dominican republic|trinidad and tobago|barbados|bahamas|canada|australia|new zealand|"
    "saudi arabia|iran|iraq|egypt|morocco|tunisia|algeria|libya|yemen|jordan|lebanon|syria|oman|"
    "qatar|united arab emirates|uae|kuwait|bahrain|afghanistan|georgia|armenia|azerbaijan"
).split("|"):
    _COUNTRIES.add(_tok.strip())
# common native-language country spellings seen in PubMed affiliations
_COUNTRIES.update({
    "brasil", "españa", "espana", "deutschland", "italia", "suisse", "schweiz", "svizzera",
    "österreich", "osterreich", "belgique", "belgië", "belgie", "nederland", "danmark", "sverige",
    "norge", "suomi", "polska", "méxico", "perú", "panamá", "república dominicana", "magyarország",
})

_US = {"usa", "u.s.a.", "u.s.a", "united states", "united states of america", "us", "u.s.", "america"}
_UK = {"uk", "u.k.", "u.k", "united kingdom", "england", "scotland", "wales",
       "northern ireland", "great britain", "britain"}

_STRONG = re.compile(
    r"(universit|universidad|université|universität|università|universidade|institut|instituto|"
    r"hospital|hôpital|college|polytechnic|hochschule|academ|minist|foundation|fondation|fundac|"
    r"fundaç|council|pasteur|wellcome|max planck|clinic|klinik|kemri|icddr|noguchi|escuela|escola|"
    r"\binc\b|\bltd\b|\bllc\b|gmbh|\bab\b|corporation|\bpty\b|pharmaceutic|therapeutic|biotech|venture)", re.I)
_WEAK = re.compile(
    r"(school|centre|center|centro|zentrum|facult|laborator|laboratoire|program|initiative|network|"
    r"consortium|agency|agence|\bcdc\b|\bwho\b|usaid|inserm|cnrs|\bird\b|trust|hopital)", re.I)
# anchored to the START: only drop a part that LEADS with a sub-unit word (academic "Department of
# X", "Faculty of Y"). A trailing such word (e.g. "Sabah State Health Department", "Juntendo
# University Faculty of Medicine") is kept — it's usually the institution itself, not a sub-unit.
_DEPT = re.compile(
    r"^\s*(depart[ae]?ments?|dept|division|divisione|faculty|facult[eé]|service|servicio|servei|"
    r"section|secção|branch|chair|discipline|research group|laboratory|laboratoire|laboratório|"
    r"départ|unit|unité|unidad|unidade)\b", re.I)


def _canon_country(c):
    s = c.strip().rstrip(".").strip()
    k = re.sub(r"^the ", "", s.lower()).strip()
    if k in _US:
        return "USA"
    if k in _UK:
        return "UK"
    return s


def _country_of(part):
    p = part.strip().rstrip(".").strip()
    low = re.sub(r"^the ", "", p.lower()).strip()
    if low in _COUNTRIES:
        return _canon_country(p)
    lw, ow = low.split(), p.split()
    for n in (4, 3, 2, 1):
        if len(lw) >= n and " ".join(lw[-n:]).strip(".") in _COUNTRIES:
            return _canon_country(" ".join(ow[-n:]))
    return None


def _clean_inst(s):
    # NB: deliberately do NOT strip a trailing country token — for many institutions the country is
    # part of the proper name ("University of Ghana", "Universiti Kebangsaan Malaysia"); cutting it
    # would mangle the name. A little redundancy ("University of Ghana, Ghana") is the safer choice.
    s = re.sub(r"^the ", "", s, flags=re.I).strip()
    s = re.sub(r"\s+\d[\w\s/-]*$", "", s).strip()   # trailing postal-ish tail
    return s.strip(" .,;")


def simplify_one(sub):
    """One affiliation string -> 'Institution, Country' (or just 'Institution'), or None."""
    sub = sub.strip().rstrip(".").strip()
    if not sub or not re.search(r"[A-Za-z]", sub):
        return None
    parts = [p.strip() for p in sub.split(",") if p.strip()]
    if not parts:
        return None
    country, ci = None, len(parts)
    for i in range(len(parts) - 1, -1, -1):
        c = _country_of(parts[i])
        if c:
            country, ci = c, i
            break
    cand = parts[:ci] or parts[:]
    # drop a part only if it LEADS with a sub-unit word AND has no institution keyword of its own
    nondept = [p for p in cand if _STRONG.search(p) or not _DEPT.search(p)] or cand
    inst = None
    for p in nondept:
        if _STRONG.search(p):
            inst = p          # rightmost strong-keyword part
    if not inst:
        for p in nondept:
            if _WEAK.search(p):
                inst = p      # else rightmost weak-keyword part
    if not inst:
        inst = nondept[0]     # else first non-department part
    inst = _clean_inst(inst)
    if not inst or not re.search(r"[A-Za-z]{2}", inst):
        return None
    return inst + (", " + country if country else "")


def simplify_list(raw_affils):
    """Raw affiliation strings -> deduped list of 'Institution, Country'. Splits ';'-joined entries."""
    out, seen = [], set()
    for entry in raw_affils or []:
        for sub in str(entry).split(";"):
            s = simplify_one(sub)
            if s and s not in seen:
                seen.add(s)
                out.append(s)
    return out
