"""Coordinate formatting: always RA and Dec, sexagesimal and degrees.

"RA 08h 55m 10.83s (133.79513°)  Dec −07° 14′ 42.5″ (−7.24515°)"
"""
from __future__ import annotations

import math

MINUS = "−"  # typographic minus


def format_ra(ra_deg: float, decimals: int = 2) -> str:
    total = (ra_deg % 360.0) / 15.0 * 3600.0          # seconds of time
    total = round(total, decimals)
    if total >= 86400.0:
        total -= 86400.0
    h = int(total // 3600)
    m = int((total - h * 3600) // 60)
    s = total - h * 3600 - m * 60
    width = 3 + decimals if decimals else 2
    return f"{h:02d}h {m:02d}m {s:0{width}.{decimals}f}s"


def format_dec(dec_deg: float, decimals: int = 1) -> str:
    sign = MINUS if dec_deg < 0 else "+"
    total = round(abs(dec_deg) * 3600.0, decimals)     # arcseconds
    d = int(total // 3600)
    m = int((total - d * 3600) // 60)
    s = total - d * 3600 - m * 60
    width = 3 + decimals if decimals else 2
    return f"{sign}{d:02d}° {m:02d}′ {s:0{width}.{decimals}f}″"


def format_deg(value: float, decimals: int = 5) -> str:
    text = f"{abs(value):.{decimals}f}°"
    return (MINUS + text) if value < 0 else text


def coord_label(ra_deg: float, dec_deg: float) -> str:
    return (f"RA {format_ra(ra_deg)} ({format_deg(ra_deg % 360.0)})  "
            f"Dec {format_dec(dec_deg)} ({format_deg(dec_deg)})")


def coord_info(ra_deg: float, dec_deg: float) -> dict:
    """Everything the UI needs to show a position."""
    return {
        "ra": ra_deg % 360.0,
        "dec": dec_deg,
        "ra_hms": format_ra(ra_deg),
        "dec_dms": format_dec(dec_deg),
        "label": coord_label(ra_deg, dec_deg),
    }


def angular_sep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation (haversine), degrees."""
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    a = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(a))))
