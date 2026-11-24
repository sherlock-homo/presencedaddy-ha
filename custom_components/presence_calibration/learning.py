"""Learn local motion patterns from low-resolution radar centroids."""

from __future__ import annotations

import math
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from itertools import pairwise
from statistics import mean, median, pstdev
from typing import Any

from .device import CalibrationError

SAMPLE_KINDS = frozenset({"enroll", "resident", "guest", "ambiguous"})
_FEATURE_FLOORS = (0.18, 0.13, 0.13, 0.20)
_WINDOW_SECONDS = 2.5
_MAX_FRAME_GAP = 0.9
_MAX_AGE_MS = 1000


@dataclass(frozen=True, slots=True)
class Track:
    """One device's local track, in millimeters and millimeters per second."""

    id: int
    x: int
    y: int
    vx: int
    vy: int
    coasting: bool
    ambiguous: bool


@dataclass(frozen=True, slots=True)
class LiveFrame:
    boot_id: int
    sequence: int
    uptime_ms: int
    fresh: bool
    entry: bool
    tracks: tuple[Track, ...]


@dataclass(frozen=True, slots=True)
class Observation:
    features: tuple[float, ...] | None = None
    ambiguous: bool = False


def _integer(value: Any, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise CalibrationError("invalid_response")
    return value


def _boolean(value: Any) -> bool:
    if type(value) is not bool:
        raise CalibrationError("invalid_response")
    return value


def live_frame(value: dict[str, Any]) -> LiveFrame:
    """Validate the sessionless radar feed without retaining extra fields."""
    points = value.get("tracks")
    zones = value.get("zones")
    age = value.get("age_ms")
    if (
        not isinstance(points, list)
        or len(points) > 3
        or not isinstance(zones, list)
        or len(zones) != 3
    ):
        raise CalibrationError("invalid_response")
    tracks = []
    entry = False
    for row in points:
        if not isinstance(row, dict):
            raise CalibrationError("invalid_response")
        entry = _boolean(row.get("in_entry", False))
        tracks.append(
            Track(
                _integer(row.get("id"), 0, 0xFFFFFFFF),
                _integer(row.get("x_mm"), -32768, 32767),
                _integer(row.get("y_mm"), -32768, 32767),
                _integer(row.get("vx_mm_s"), -32768, 32767),
                _integer(row.get("vy_mm_s"), -32768, 32767),
                _boolean(row.get("coasting")),
                _boolean(row.get("association_ambiguous")),
            )
        )
    if len({track.id for track in tracks}) != len(tracks):
        raise CalibrationError("invalid_response")
    healthy = _boolean(value.get("healthy"))
    age = _integer(age, 0, 0xFFFFFFFF) if age is not None else None
    return LiveFrame(
        _integer(value.get("boot_id"), 0, 0xFFFFFFFF),
        _integer(value.get("sequence"), 0, 0xFFFFFFFF),
        _integer(value.get("uptime_ms"), 0, 0xFFFFFFFFFFFFFFFF),
        healthy and age is not None and age <= _MAX_AGE_MS,
        len(tracks) == 1 and entry,
        tuple(tracks),
    )


class TrackWindow:
    """Discard ambiguous or lost tracks and measure only sustained movement."""

    def __init__(self) -> None:
        self.points: deque[tuple[float, Track]] = deque(maxlen=50)
        self.last_frame: LiveFrame | None = None

    def clear(self) -> None:
        self.points.clear()

    def add(self, frame: LiveFrame, time: float) -> Observation | None:
        """Observe a new radar frame. A duplicate produces no observation."""
        previous = self.last_frame
        if previous and frame.boot_id == previous.boot_id:
            delta = (frame.sequence - previous.sequence) & 0xFFFFFFFF
            if delta == 0 or delta >= 0x80000000:
                if not frame.fresh:
                    self.clear()
                    return Observation()
                return None
        else:
            self.clear()
        self.last_frame = frame
        if not frame.fresh:
            self.clear()
            return Observation()
        ambiguous = len(frame.tracks) > 1 or any(
            track.ambiguous for track in frame.tracks
        )
        if ambiguous or not frame.tracks or frame.tracks[0].coasting:
            self.clear()
            return Observation(ambiguous=ambiguous)
        track = frame.tracks[0]
        if self.points:
            old_time, old = self.points[-1]
            gap = time - old_time
            if (
                not 0 < gap <= _MAX_FRAME_GAP
                or old.id != track.id
                or math.hypot(track.x - old.x, track.y - old.y) > 350 + 3000 * gap
            ):
                self.clear()
        self.points.append((time, track))
        while (
            self.points and time - self.points[0][0] > _WINDOW_SECONDS + _MAX_FRAME_GAP
        ):
            self.points.popleft()
        if len(self.points) < 7 or time - self.points[0][0] < _WINDOW_SECONDS:
            return Observation()
        return Observation(_features(tuple(track for _, track in self.points)))


def _features(tracks: tuple[Track, ...]) -> tuple[float, ...] | None:
    speeds = [math.hypot(track.vx, track.vy) / 1000 for track in tracks]
    speed = median(speeds)
    start, finish = tracks[0], tracks[-1]
    displacement = math.hypot(finish.x - start.x, finish.y - start.y)
    if (
        not 0.25 <= speed <= 3.0
        or speeds[-1] < 0.25
        or max(speeds) > 4.5
        or displacement < 400
    ):
        return None
    steps = [
        (after.x - before.x, after.y - before.y) for before, after in pairwise(tracks)
    ]
    path = sum(math.hypot(dx, dy) for dx, dy in steps)
    mean_heading = math.atan2(finish.y - start.y, finish.x - start.x)
    variation = mean(
        abs(math.sin(math.atan2(dy, dx) - mean_heading)) for dx, dy in steps if dx or dy
    )
    return tuple(
        round(value, 4)
        for value in (speed, pstdev(speeds), displacement / path, variation)
    )


class MotionModel:
    """Interpretable per-sensor class medians with distance and margin rejection."""

    def __init__(self, samples: list[dict[str, Any]]) -> None:
        grouped: dict[str, list[tuple[float, ...]]] = defaultdict(list)
        for sample in samples:
            if sample["kind"] == "enroll" and sample["features"]:
                grouped[sample["person"]].extend(sample["features"])
        self._centers = {
            person: tuple(map(median, zip(*items))) for person, items in grouped.items()
        }
        self._scales = _FEATURE_FLOORS

    @property
    def labels(self) -> frozenset[str]:
        return frozenset(self._centers)

    def predict(self, features: tuple[float, ...] | None) -> str | None:
        if features is None or not self._centers:
            return None
        ranked = sorted(
            (
                math.sqrt(
                    mean(
                        ((a - b) / scale) ** 2
                        for a, b, scale in zip(features, center, self._scales)
                    )
                ),
                person,
            )
            for person, center in self._centers.items()
        )
        distance, person = ranked[0]
        margin = ranked[1][0] - distance if len(ranked) > 1 else math.inf
        return person if distance <= 0.85 and margin >= 0.25 else None


def assess(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Score held-out days per device. Enrollment never uses validation data."""
    model = MotionModel(samples)
    enrolled: dict[str, set[str]] = defaultdict(set)
    checked: dict[str, set[str]] = defaultdict(set)
    resident_sessions: Counter[str] = Counter()
    resident_windows: Counter[str] = Counter()
    resident_named: Counter[str] = Counter()
    resident_correct: Counter[str] = Counter()
    predicted_named: Counter[str] = Counter()
    for sample in samples:
        if sample["kind"] == "enroll":
            enrolled[sample["person"]].add(sample["day"])
    training_days = set().union(*enrolled.values())
    counts: Counter[str] = Counter()
    for sample in samples:
        kind = sample["kind"]
        if kind == "enroll" or sample["day"] in training_days:
            continue
        label = sample["person"]
        results = [model.predict(row) for row in sample["features"]]
        if kind == "resident" and label in enrolled:
            counts["resident"] += len(results)
            checked[label].add(sample["day"])
            resident_sessions[label] += 1
            resident_windows[label] += len(results)
            resident_named[label] += sum(result is not None for result in results)
            resident_correct[label] += results.count(label)
            predicted_named.update(result for result in results if result is not None)
            counts["named"] += sum(result is not None for result in results)
            counts["correct"] += results.count(label)
        if kind in {"guest", "ambiguous"}:
            counts[kind] += 1
            counts["challenge_false"] += any(result is not None for result in results)
            counts["challenge_names"] += sum(result is not None for result in results)
    emitted = counts["named"] + counts["challenge_names"]
    precision = counts["correct"] / emitted if emitted else None
    coverage = counts["named"] / counts["resident"] if counts["resident"] else None
    ready = bool(enrolled) and all(
        len(days) >= 2
        and len(checked[person]) >= 2
        and resident_sessions[person] >= 3
        and resident_windows[person] >= 10
        and resident_named[person] / resident_windows[person] >= 0.70
        and predicted_named[person] > 0
        and resident_correct[person] / predicted_named[person] >= 0.95
        for person, days in enrolled.items()
    )
    passed = (
        ready
        and precision is not None
        and precision >= 0.95
        and coverage is not None
        and coverage >= 0.70
        and counts["guest"] >= 50
        and counts["ambiguous"] >= 50
        and counts["challenge_false"] == 0
    )
    return {
        "passed": passed,
        "precision": precision,
        "coverage": coverage,
        "enrolled": sorted(enrolled),
        "residents": counts["resident"],
        "guest": counts["guest"],
        "ambiguous": counts["ambiguous"],
        "false_names": counts["challenge_false"],
    }
