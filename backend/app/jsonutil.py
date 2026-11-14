"""JSON helpers: never emit NaN/Infinity, and understand numpy types."""
from __future__ import annotations

import datetime as _dt
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from fastapi.responses import JSONResponse


def to_jsonable(value: Any) -> Any:
    """Recursively convert to plain JSON types; non-finite floats become None."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        f = float(value)
        return f if math.isfinite(f) else None
    if isinstance(value, np.ndarray):
        return to_jsonable(value.tolist())
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if hasattr(value, "item"):  # numpy scalar-like / masked constant
        try:
            return to_jsonable(value.item())
        except Exception:  # noqa: BLE001
            return None
    return str(value)


def dumps(value: Any) -> str:
    return json.dumps(to_jsonable(value), allow_nan=False, separators=(",", ":"))


class SafeJSONResponse(JSONResponse):
    """JSONResponse that converts NaN/Infinity (python or numpy) to null."""

    def render(self, content: Any) -> bytes:
        return dumps(content).encode("utf-8")
