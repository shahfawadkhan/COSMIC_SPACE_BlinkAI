"""Verified SPHEREx facts, shown next to AI answers so users can check them.

The SPHEREx AI service answers from its own document index; when that index has no matching
passage it falls back to the model's memory, which can be outdated (e.g. "scheduled to launch").
These short, sourced facts are matched to the question by keywords (no model involved) and
displayed under the answer, with a warning when the answer contradicts one of them.
Keep every entry checkable: one fact, one public source.
"""
from __future__ import annotations

import re

NASA = "https://science.nasa.gov/mission/spherex/"
IRSA = "https://irsa.ipac.caltech.edu/Missions/spherex.html"

FACTS: list[dict] = [
    {"id": "launch", "keys": {"launch", "launched", "launches", "when", "date", "rocket", "falcon", "start", "status"},
     "text": "SPHEREx launched on 11 March 2025 (US Pacific time) on a SpaceX Falcon 9 from Vandenberg Space Force Base, together with NASA's PUNCH mission. It is operating now, not \"scheduled\".",
     "source": "NASA SPHEREx mission page", "url": NASA,
     "contradicts": r"\b(will|is scheduled to|scheduled to|slated (?:for|to)|expected to|planned to|set to)\s+launch|\bupcoming launch|\bnot (?:yet )?launched|\bmid-2020s\b"},
    {"id": "survey", "keys": {"survey", "sky", "all-sky", "map", "maps", "months", "cadence", "how", "often", "data", "may", "2025", "observing"},
     "text": "SPHEREx maps the whole sky about every six months; science observations started in May 2025. The two-year prime mission makes four all-sky maps.",
     "source": "NASA SPHEREx mission page", "url": NASA},
    {"id": "bands", "keys": {"bands", "band", "channels", "channel", "colors", "colours", "wavelength", "wavelengths", "spectral", "102", "infrared", "micron", "microns", "spectrum"},
     "text": "It observes 0.75–5.0 µm (near-infrared) in 102 spectral channels, using linear variable filters: the wavelength changes across each detector.",
     "source": "IRSA SPHEREx documentation", "url": IRSA},
    {"id": "detectors", "keys": {"detector", "detectors", "arrays", "array", "focal", "plane", "six", "6"},
     "text": "Six detector arrays: D1 0.75–1.09, D2 1.10–1.62, D3 1.63–2.41, D4 2.42–3.82, D5 3.83–4.41, D6 4.42–5.00 µm.",
     "source": "IRSA SPHEREx documentation", "url": IRSA},
    {"id": "pixels", "keys": {"pixel", "pixels", "resolution", "arcsec", "sharp", "angular"},
     "text": "Pixels are 6.2 arcseconds on the sky; the spectral resolution is low (R ≈ 35–130).",
     "source": "IRSA SPHEREx documentation", "url": IRSA},
    {"id": "class", "keys": {"midex", "smex", "explorer", "class", "medium", "small", "type", "kind", "mission", "what", "is"},
     "text": "SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer) is a NASA Medium-class Explorer (MIDEX) mission, managed by JPL with science led by Caltech.",
     "source": "NASA SPHEREx mission page", "url": NASA,
     "contradicts": r"\bsmall explorer\b|\bSMEX\b"},
    {"id": "goals", "keys": {"goal", "goals", "science", "why", "purpose", "inflation", "galaxies", "ices", "water", "reionization", "study"},
     "text": "Its three science themes: the physics of cosmic inflation (galaxy clustering), the history of galaxy light, and water and other ices in the Milky Way.",
     "source": "NASA SPHEREx mission page", "url": NASA},
    {"id": "archive", "keys": {"archive", "irsa", "download", "access", "release", "dr1", "data", "where", "get", "fits"},
     "text": "SPHEREx data are public at the NASA/IPAC Infrared Science Archive (IRSA). COSMIC uses the spherex_dr1 collection (Level-2 images).",
     "source": "IRSA SPHEREx page", "url": IRSA},
    {"id": "planetx", "keys": {"planet", "x", "nine", "9", "planetx", "ninth", "hidden"},
     "text": "There is no Planet X (Planet Nine) in any NASA archive: it is a hypothesis (Batygin & Brown 2016, AJ 151, 22). COSMIC only tests whether one could be detected, with clearly labelled SIMULATED objects.",
     "source": "Batygin & Brown 2016", "url": "https://doi.org/10.3847/0004-6256/151/2/22"},
]

STOP = {"the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "about", "tell", "me", "please", "does", "do", "it", "its", "sphere", "spherex", "?"}


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9\-]+", text.lower()) if t not in STOP}


def match(question: str, answer: str | None = None, limit: int = 2) -> list[dict]:
    """Facts relevant to the question (score = shared keywords). If an answer is given, any fact it
    contradicts is always included and flagged."""
    q = _tokens(question)
    scored = []
    for f in FACTS:
        score = len(q & f["keys"])
        contradicted = bool(answer and f.get("contradicts") and re.search(f["contradicts"], answer, re.I))
        if contradicted or score >= 2 or (f["id"] in ("launch", "planetx") and score >= 1 and f["keys"] & q - {"what", "is", "when", "how", "x"}):
            scored.append((contradicted, score, f))
    scored.sort(key=lambda s: (not s[0], -s[1]))
    out = []
    for contradicted, _, f in scored[:limit]:
        out.append({"id": f["id"], "text": f["text"], "source": f["source"], "url": f["url"], "contradicted": contradicted})
    return out
