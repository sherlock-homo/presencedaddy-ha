"""Import a labeled, single-boot excerpt from a presenceDaddy microSD capture."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, tzinfo

from .device import CalibrationError
from .learning import SAMPLE_KINDS, TrackWindow, live_frame

_MAX_BYTES = 96 * 1024
_MAX_SPAN_MS = 45_000
_ROW_KEYS = ("id", "x_mm", "y_mm", "vx_mm_s", "vy_mm_s", "radial_speed_cm_s",
             "resolution_mm", "coasting", "association_ambiguous")


def _record(line: str):
    if len(line) > 1024:
        raise CalibrationError("invalid_sd_clip")
    try:
        obj = json.loads(line)
    except (ValueError, RecursionError):
        raise CalibrationError("invalid_sd_clip") from None
    if (not isinstance(obj, dict) or type(obj.get("v")) is not int or obj["v"] != 1
            or type(obj.get("occupied")) is not bool or type(obj.get("motion")) is not bool
            or not isinstance(obj.get("tracks"), list) or len(obj["tracks"]) > 3
            or "unix_ms" not in obj):
        raise CalibrationError("invalid_sd_clip")
    tracks = []
    for row in obj["tracks"]:
        if (not isinstance(row, list) or len(row) != len(_ROW_KEYS)
                or type(row[5]) is not int or not -32768 <= row[5] <= 32767
                or type(row[6]) is not int or not 0 <= row[6] <= 65535):
            raise CalibrationError("invalid_sd_clip")
        tracks.append(dict(zip(_ROW_KEYS, row, strict=True)))
    epoch = obj["unix_ms"]
    if epoch is not None and (type(epoch) is not int or not 1704067200000 <= epoch < 4102444800000):
        raise CalibrationError("invalid_sd_clip")
    frame = live_frame({**obj, "age_ms": 0, "tracks": tracks})
    if not frame.boot_id:
        raise CalibrationError("invalid_sd_clip")
    return frame, epoch


def sd_sample(clip: str, *, entry_id: str, kind: str, person: str | None,
              local_tz: tzinfo, day: str | None = None) -> dict:
    """Derive the same non-overlapping example cadence as a live training capture."""
    if (not isinstance(clip, str) or not clip.isascii() or not 0 < len(clip) <= _MAX_BYTES
            or not isinstance(kind, str) or kind not in SAMPLE_KINDS):
        raise CalibrationError("invalid_sd_clip")
    lines = clip.splitlines()
    if not 2 <= len(lines) <= 250:
        raise CalibrationError("invalid_sd_clip")
    window = TrackWindow()
    features = []
    last_window = -1500
    first = previous = anchor = None
    ambiguous = False
    single_track = None
    for line in lines:
        frame, epoch = _record(line)
        if first is None:
            first = frame
        if previous is not None:
            if (frame.boot_id != first.boot_id or frame.uptime_ms <= previous.uptime_ms
                    or frame.uptime_ms - first.uptime_ms > _MAX_SPAN_MS):
                raise CalibrationError("invalid_sd_clip")
            delta = (frame.sequence - previous.sequence) & 0xFFFFFFFF
            if delta >= 0x80000000 or (delta == 0 and frame.fresh):
                raise CalibrationError("invalid_sd_clip")
        previous = frame
        if epoch is not None:
            offset = epoch - frame.uptime_ms
            if anchor is not None and abs(offset - anchor) > 2000:
                raise CalibrationError("invalid_sd_clip")
            anchor = offset
        observation = window.add(frame, frame.uptime_ms / 1000)
        if observation is None:
            continue
        if observation.ambiguous:
            ambiguous = True
            if kind != "ambiguous":
                raise CalibrationError("ambiguous_sd_clip")
        if frame.fresh and len(frame.tracks) == 1 and not frame.tracks[0].coasting:
            track_id = frame.tracks[0].id
            if kind != "ambiguous" and single_track is not None and single_track != track_id:
                raise CalibrationError("ambiguous_sd_clip")
            single_track = track_id
        if observation.features and frame.uptime_ms - last_window >= 1500 and len(features) < 22:
            features.append(list(observation.features))
            last_window = frame.uptime_ms

    if not first or not previous or previous.uptime_ms - first.uptime_ms < 2500:
        raise CalibrationError("insufficient_movement")
    if (kind == "ambiguous" and not ambiguous) or (kind != "ambiguous" and not features):
        raise CalibrationError("insufficient_movement")
    if anchor is not None:
        first_day = datetime.fromtimestamp((anchor + first.uptime_ms) / 1000, local_tz).date().isoformat()
        last_day = datetime.fromtimestamp((anchor + previous.uptime_ms) / 1000, local_tz).date().isoformat()
        if first_day != last_day or (day and day != first_day):
            raise CalibrationError("sd_clip_date")
        day = first_day
    else:
        try:
            if kind != "enroll" or not day or date.fromisoformat(day).isoformat() != day:
                raise ValueError
        except (TypeError, ValueError):
            raise CalibrationError("sd_clip_date") from None
    capture = [first.boot_id, first.uptime_ms, previous.uptime_ms]
    sample_id = hashlib.sha256(f"{entry_id}/{capture}".encode()).hexdigest()[:32]
    return {"id": sample_id, "entry_id": entry_id, "kind": kind, "person": person,
            "day": day, "features": features, "capture": capture}
