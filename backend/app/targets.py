"""The five challenge test objects, with proper motion carried to today.

Proper motions are pmra* = pmra·cos(dec) and pmdec, in mas/yr (catalogue values
from the project brief). Moving targets are shifted linearly from their
catalogue epoch to the requested date and the centre is rounded to 0.001 deg
so cache keys stay stable from day to day.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import asdict, dataclass

from astropy.time import Time

from .coords import coord_info

ROUND_DEG = 3  # 0.001 deg = 3.6"


@dataclass(frozen=True)
class Target:
    id: str
    name: str
    simbad_name: str
    kind: str                 # "moving" or "variable"
    ra: float                 # catalogue position, deg (ICRS)
    dec: float
    epoch: float              # Julian year of the catalogue position
    pmra: float = 0.0         # pmra* = pmra·cos(dec), mas/yr
    pmdec: float = 0.0        # mas/yr
    fov_arcmin: float = 4.0
    note: str = ""


TARGETS: list[Target] = [
    Target("wise0855", "WISE 0855−0714", "WISE J085510.83-071442.5", "moving",
           133.795129, -7.245147, 2010.5, -8150.0, 670.0, 4.0,
           "Coldest known brown dwarf (~250 K). Moves ~8.2″/yr."),
    Target("barnard", "Barnard's Star", "Barnard's Star", "moving",
           269.4521, 4.69336, 2000.0, -798.58, 10328.12, 4.0,
           "Fastest-moving star in the sky: ~10.4″/yr to the north."),
    Target("epsindib", "Epsilon Indi B", "eps Ind B", "moving",
           331.04371, -56.782722, 2000.0, 3981.977, -2466.832, 5.0,
           "A pair of brown dwarfs orbiting the star Epsilon Indi. ~4.7″/yr."),
    Target("rwaur", "RW Aurigae", "RW Aur", "variable",
           76.95654, 30.40144, 2000.0, 0.0, 0.0, 3.0,
           "Young variable star: look for brightness changes, not motion."),
    Target("rdra", "R Draconis", "R Dra", "variable",
           248.16792, 66.755, 2000.0, 0.0, 0.0, 3.0,
           "Mira variable: brightness changes over ~8 months."),
]
_BY_ID = {t.id: t for t in TARGETS}


def get_target(target_id: str) -> Target | None:
    return _BY_ID.get(target_id.lower())


def julian_year(when: dt.datetime | dt.date | None = None) -> float:
    if when is None:
        return float(Time.now().jyear)
    if isinstance(when, dt.date) and not isinstance(when, dt.datetime):
        when = dt.datetime(when.year, when.month, when.day, tzinfo=dt.timezone.utc)
    return float(Time(when).jyear)


def propagate(ra: float, dec: float, pmra: float, pmdec: float,
              from_epoch: float, to_epoch: float) -> tuple[float, float]:
    """Linear proper-motion shift. pmra is pmra* (already × cos dec), mas/yr."""
    dt_yr = to_epoch - from_epoch
    cosd = math.cos(math.radians(dec))
    d_dec = pmdec * dt_yr / 3.6e6
    d_ra = (pmra * dt_yr / 3.6e6) / cosd if cosd > 1e-9 else 0.0
    new_dec = max(-90.0, min(90.0, dec + d_dec))
    return (ra + d_ra) % 360.0, new_dec


def position_at(target: Target, when: dt.datetime | dt.date | None = None,
                *, rounded: bool = True) -> tuple[float, float]:
    ra, dec = propagate(target.ra, target.dec, target.pmra, target.pmdec,
                        target.epoch, julian_year(when))
    if rounded:
        ra, dec = round(ra, ROUND_DEG) % 360.0, round(dec, ROUND_DEG)
    return ra, dec


def target_info(target: Target, when: dt.datetime | dt.date | None = None) -> dict:
    year = julian_year(when)
    ra_now, dec_now = position_at(target, when)
    total_pm = math.hypot(target.pmra, target.pmdec) / 1000.0  # arcsec/yr
    out = asdict(target)
    out.update({
        "catalog": coord_info(target.ra, target.dec),
        "today": coord_info(ra_now, dec_now),
        "today_epoch": round(year, 3),
        "pm_total_arcsec_yr": round(total_pm, 3),
        "shift_since_epoch_arcsec": round(total_pm * (year - target.epoch), 1),
    })
    return out


def all_targets(when: dt.datetime | dt.date | None = None) -> list[dict]:
    return [target_info(t, when) for t in TARGETS]
