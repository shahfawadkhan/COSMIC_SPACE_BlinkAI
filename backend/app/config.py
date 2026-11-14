"""Settings for COSMIC Space Blink AI.

Every value can be overridden with an environment variable of the same name.
List values are comma-separated. Defaults follow docs/SPEC.md.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Bump whenever processing changes in a way that invalidates cached sets/renders.
CODE_VERSION = "1"

APP_NAME = "COSMIC Space Blink AI"
APP_SUBTITLE = "SPHEREx motion & change finder"

# ---- SPHEREx instrument facts -------------------------------------------------
PIXEL_SCALE_ARCSEC = 6.2
N_CHANNELS = 102

# Detector number -> (min, max) wavelength in micrometres.
DETECTOR_RANGES_UM: dict[int, tuple[float, float]] = {
    1: (0.75, 1.09),
    2: (1.10, 1.62),
    3: (1.63, 2.41),
    4: (2.42, 3.82),
    5: (3.83, 4.41),
    6: (4.42, 5.00),
}

# FLAGS extension bit numbers (uint bit mask).
FLAG_BITS: dict[str, int] = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "PHANTOM": 4,
    "REFERENCE": 5,
    "NONFUNC": 6,
    "DICHROIC": 7,
    "MISSING_DATA": 9,
    "HOT": 10,
    "COLD": 11,
    "NONLINEAR": 15,
    "OUTLIER": 19,
    "SOURCE": 21,  # informational only: "a source is here". Never masked.
}
MASKED_FLAGS: tuple[str, ...] = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "PHANTOM", "REFERENCE", "NONFUNC",
    "DICHROIC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR", "OUTLIER",
)
BAD_FLAG_MASK: int = sum(1 << FLAG_BITS[name] for name in MASKED_FLAGS)

# Cache lifetimes in seconds (None = forever).
TTL_IRSA_SEARCH = 30 * 60
TTL_CATALOG = 30 * 24 * 3600     # SIMBAD / Gaia cones, name lookups
TTL_RENDER = 24 * 3600           # rendered PNGs
TTL_JOB = 24 * 3600              # job status/progress
TTL_MANIFEST = 7 * 24 * 3600     # set manifests


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value.strip() == "" else value.strip()


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


@dataclass
class Settings:
    irsa_sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    spherex_collections: list[str] = field(default_factory=lambda: ["spherex_dr1"])
    simbad_tap_urls: list[str] = field(default_factory=lambda: [
        "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
        "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync",
    ])
    gaia_tap_urls: list[str] = field(default_factory=lambda: [
        "https://gea.esac.esa.int/tap-server/tap/sync",
    ])
    vizier_tap_urls: list[str] = field(default_factory=lambda: [
        "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync",
    ])
    irsa_tap_urls: list[str] = field(default_factory=lambda: [
        "https://irsa.ipac.caltech.edu/TAP/sync",
    ])
    redis_url: str = "redis://localhost:6379/0"
    cache_dir: Path = Path("./cache")
    http_timeout_s: float = 60.0
    http_workers: int = 16
    cpu_workers: int = max(1, (os.cpu_count() or 2) - 1)
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    breaker_cooldown_s: float = 120.0
    # SPHEREx AI chatbot service (key stays on the server; never sent to the browser)
    ai_url: str = "https://spherex-chatbot.onrender.com"
    ai_key: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        d = cls()
        return cls(
            irsa_sia_url=_env_str("IRSA_SIA_URL", d.irsa_sia_url),
            spherex_collections=_env_list("SPHEREX_COLLECTIONS", d.spherex_collections),
            simbad_tap_urls=_env_list("SIMBAD_TAP_URLS", d.simbad_tap_urls),
            gaia_tap_urls=_env_list("GAIA_TAP_URLS", d.gaia_tap_urls),
            vizier_tap_urls=_env_list("VIZIER_TAP_URLS", d.vizier_tap_urls),
            irsa_tap_urls=_env_list("IRSA_TAP_URLS", d.irsa_tap_urls),
            # REDIS_URL="" or "none" disables Redis completely.
            redis_url=os.environ.get("REDIS_URL", d.redis_url).strip(),
            cache_dir=Path(_env_str("CACHE_DIR", str(d.cache_dir))),
            http_timeout_s=_env_float("HTTP_TIMEOUT_S", d.http_timeout_s),
            http_workers=_env_int("HTTP_WORKERS", d.http_workers),
            cpu_workers=max(0, _env_int("CPU_WORKERS", d.cpu_workers)),  # 0 = inline
            cors_origins=_env_list("CORS_ORIGINS", d.cors_origins),
            breaker_cooldown_s=_env_float("BREAKER_COOLDOWN_S", d.breaker_cooldown_s),
            ai_url=_env_str("SPHEREX_AI_URL", d.ai_url).rstrip("/"),
            ai_key=os.environ.get("SPHEREX_AI_KEY", "").strip(),
        )

    @property
    def redis_enabled(self) -> bool:
        return self.redis_url.lower() not in ("", "none", "off", "disabled")


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader (KEY=VALUE lines). Real environment variables win."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


_load_dotenv(Path(__file__).resolve().parent.parent / ".env")
settings = Settings.from_env()


def public_config() -> dict:
    """Config safe to expose over the API (no credentials)."""
    return {
        "app_name": APP_NAME,
        "subtitle": APP_SUBTITLE,
        "code_version": CODE_VERSION,
        "spherex_collections": settings.spherex_collections,
        "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
        "n_channels": N_CHANNELS,
        "detectors": [
            {"detector": det, "wavelength_min_um": lo, "wavelength_max_um": hi}
            for det, (lo, hi) in DETECTOR_RANGES_UM.items()
        ],
        "flag_bits": FLAG_BITS,
        "masked_flags": list(MASKED_FLAGS),
        "bad_flag_mask": BAD_FLAG_MASK,
        "redis_enabled": settings.redis_enabled,
        "sources": {
            "irsa_sia": settings.irsa_sia_url,
            "simbad_tap": settings.simbad_tap_urls,
            "gaia_tap": settings.gaia_tap_urls,
            "vizier_tap": settings.vizier_tap_urls,
            "irsa_tap": settings.irsa_tap_urls,
        },
    }
