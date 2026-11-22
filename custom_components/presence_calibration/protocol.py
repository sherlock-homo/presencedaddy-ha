"""Validate the calibration messages that cross the Home Assistant boundary."""

from __future__ import annotations

import re
from typing import Any

from .device import CalibrationError

_RECT_MAX_COORDINATE = 1_000_000
_TOKEN = re.compile(r"[A-Za-z0-9._~-]{1,128}")
_UINT32_MAX = 2**32 - 1


def _coordinate(value: Any) -> bool:
    return (
        type(value) in {int, float}
        and -_RECT_MAX_COORDINATE <= value <= _RECT_MAX_COORDINATE
    )


def _rectangle(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 4 and all(map(_coordinate, value))


def _optional_rectangles(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 3
        and all(item is None or _rectangle(item) for item in value)
    )


def _profile(value: Any, error: str) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or value.keys() != {"room", "zones", "exclusions"}
        or not _rectangle(value["room"])
        or not _optional_rectangles(value["zones"])
        or not _optional_rectangles(value["exclusions"])
    ):
        raise CalibrationError(error)
    return value


def _uint32(value: Any) -> bool:
    return type(value) is int and 0 <= value <= _UINT32_MAX


def validate_payload(action: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Accept only the fields for this fixed operation."""
    if action in {"open", "profile", "close"}:
        if payload:
            raise CalibrationError("invalid_request")
        return None
    expected_keys = {
        "draft": {"profile"},
        "save": {"expected_revision", "profile"},
        "undo": {"expected_revision"},
    }[action]
    if payload.keys() != expected_keys:
        raise CalibrationError("invalid_request")
    if "expected_revision" in payload and not _uint32(payload["expected_revision"]):
        raise CalibrationError("invalid_request")
    if "profile" in payload:
        _profile(payload["profile"], "invalid_profile")
    return payload


def profile_envelope(value: dict[str, Any]) -> dict[str, Any]:
    """Read the public profile envelope without carrying through other fields."""
    revision = value.get("revision")
    can_undo = value.get("can_undo")
    if not _uint32(revision) or type(can_undo) is not bool:
        raise CalibrationError("invalid_response")
    return {
        "revision": revision,
        "profile": _profile(value.get("profile"), "invalid_response"),
        "can_undo": can_undo,
    }


def session_token(value: dict[str, Any]) -> str:
    """Validate a private opaque token before using it in an HTTP header."""
    token = value.get("session")
    if not isinstance(token, str) or _TOKEN.fullmatch(token) is None:
        raise CalibrationError("invalid_response")
    return token


def preview_report(value: dict[str, Any]) -> dict[str, Any]:
    """Project a bounded preview onto its public response shape."""
    sequence = value.get("sequence")
    age = value.get("age_ms")
    points = value.get("points")
    zones = value.get("zones")
    flags = ("healthy", "occupied", "motion")
    if (
        not _uint32(sequence)
        or "age_ms" not in value
        or (age is not None and not _uint32(age))
        or not isinstance(points, list)
        or len(points) > 16
        or any(
            not isinstance(point, list)
            or len(point) != 2
            or not all(map(_coordinate, point))
            for point in points
        )
        or not isinstance(zones, list)
        or len(zones) != 3
        or any(type(state) is not bool for state in zones)
        or any(type(value.get(flag)) is not bool for flag in flags)
    ):
        raise CalibrationError("invalid_response")
    return {
        "sequence": sequence,
        "age_ms": age,
        "points": points,
        "zones": zones,
        **{flag: value[flag] for flag in flags},
    }
