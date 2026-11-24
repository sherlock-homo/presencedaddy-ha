"""Normalize one floor of Apple RoomPlan geometry without retaining its scan data."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from typing import Any

SCHEMA = "presenceDaddy.roomplan.v1"
KINDS = frozenset(("wall", "door", "opening", "window", "object", "seating", "entry", "ignore", "area"))
MAX_SENSOR_PLACEMENTS = 32
_MAX_COORDINATE = 1_000_000
_MAX_ROOMS = 32
_MAX_FEATURES_PER_ROOM = 64
_MAX_FEATURES = 256
_MAX_VERTICES = 128
_MAX_BYTES = 256 * 1024
_MAX_WALL_GAP_MM = 350
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_SURFACES = (("walls", "wall", "Wall"), ("doors", "door", "Door"),
             ("openings", "opening", "Opening"), ("windows", "window", "Window"))
_ROOM_NAMES = {
    "livingRoom": "Living room", "bedroom": "Bedroom", "bathroom": "Bathroom",
    "kitchen": "Kitchen", "diningRoom": "Dining room",
}
_OBJECT_NAMES = {"chair": "Chair", "sofa": "Sofa", "bed": "Bed", "table": "Table"}


class RoomPlanError(ValueError):
    """A capture cannot be used as a floor plan."""


def normalize_roomplan(payload: Any) -> dict[str, Any]:
    """Return only canonical, bounded top-down geometry from a capture."""
    if not isinstance(payload, dict):
        raise RoomPlanError("Select a RoomPlan JSON object.")
    placements = []
    if "schema" in payload:
        if payload["schema"] != SCHEMA:
            raise RoomPlanError("This RoomPlan format version is unsupported.")
        rooms = _checked_rooms(payload.get("rooms"))
        placements = _checked_placements(payload.get("placements", []))
    else:
        raw_rooms = payload.get("rooms") if "rooms" in payload else [payload]
        if not isinstance(raw_rooms, list) or not 1 <= len(raw_rooms) <= _MAX_ROOMS:
            raise RoomPlanError("A capture must contain 1 to 32 rooms.")
        if any(not isinstance(room, dict) for room in raw_rooms):
            raise RoomPlanError("The Apple RoomPlan file contains an invalid room.")
        stories = {_story(room) for room in raw_rooms}
        stories.discard(None)
        if len(stories) > 1:
            raise RoomPlanError("Export a separate RoomPlan capture for each floor.")
        rooms = _checked_rooms(
            [_native_room(room, index + 1) for index, room in enumerate(raw_rooms)]
        )
    result = {"schema": SCHEMA, "rooms": rooms}
    if placements:
        result["placements"] = placements
    if len(json.dumps(result, ensure_ascii=True, separators=(",", ":"))) > _MAX_BYTES:
        raise RoomPlanError("The normalized capture exceeds 256 KiB. Split it by room.")
    return result


def valid_placement_entry_id(value: Any) -> bool:
    """Check that a placement references one bounded Home Assistant entry ID."""
    return isinstance(value, str) and _ID_PATTERN.fullmatch(value) is not None


def validate_placement_pose(value: Any) -> dict[str, Any]:
    """Check a signed millimeter origin and counterclockwise heading from +Y."""
    if not isinstance(value, dict) or value.keys() != {"origin", "heading_mdeg"}:
        raise RoomPlanError("A sensor placement needs an origin and heading.")
    origin, heading = value["origin"], value["heading_mdeg"]
    if not _valid_point(origin):
        raise RoomPlanError("Sensor origins must be signed integer millimeters.")
    if type(heading) is not int or not -180_000 <= heading < 180_000:
        raise RoomPlanError("A sensor heading must be in [-180000, 179999] millidegrees.")
    return {"origin": origin.copy(), "heading_mdeg": heading}


def _checked_placements(placements: Any) -> list[dict[str, Any]]:
    if not isinstance(placements, list) or len(placements) > MAX_SENSOR_PLACEMENTS:
        raise RoomPlanError("A capture may contain up to 32 sensor placements.")
    checked = []
    seen = set()
    for placement in placements:
        if not isinstance(placement, dict) or placement.keys() != {
            "entry_id",
            "origin",
            "heading_mdeg",
        }:
            raise RoomPlanError("A sensor placement needs an entry ID, origin and heading.")
        entry_id = placement["entry_id"]
        if not valid_placement_entry_id(entry_id) or entry_id in seen:
            raise RoomPlanError("Sensor placements need distinct, valid entry IDs.")
        seen.add(entry_id)
        pose = validate_placement_pose(
            {"origin": placement["origin"], "heading_mdeg": placement["heading_mdeg"]}
        )
        checked.append({"entry_id": entry_id, **pose})
    return checked


def _story(room: dict[str, Any]) -> int | None:
    story = room.get("story")
    if story is not None and type(story) is not int:
        raise RoomPlanError("Apple RoomPlan contains an invalid floor number.")
    return story


def _checked_rooms(rooms: Any) -> list[dict[str, Any]]:
    if not isinstance(rooms, list) or not 1 <= len(rooms) <= _MAX_ROOMS:
        raise RoomPlanError("A capture must contain 1 to 32 rooms.")
    checked = []
    room_ids: set[str] = set()
    total_features = 0
    for room in rooms:
        if not isinstance(room, dict):
            raise RoomPlanError("A room must be a JSON object.")
        room_id, name = _identity(room)
        _remember_id(room_ids, room_id)
        features = room.get("features")
        if not isinstance(features, list) or len(features) > _MAX_FEATURES_PER_ROOM:
            raise RoomPlanError("A captured room may contain up to 64 features.")
        total_features += len(features)
        if total_features > _MAX_FEATURES:
            raise RoomPlanError("A captured floor may contain up to 256 features.")
        feature_ids: set[str] = set()
        checked_features = []
        for feature in features:
            if not isinstance(feature, dict):
                raise RoomPlanError("A room feature must be a JSON object.")
            feature_id, feature_name = _identity(feature)
            _remember_id(feature_ids, feature_id)
            kind = feature.get("kind")
            if not isinstance(kind, str) or kind not in KINDS:
                raise RoomPlanError("A room feature has an unsupported category.")
            checked_features.append(
                {"id": feature_id, "name": feature_name, "kind": kind,
                 "outline": _checked_outline(feature.get("outline"))}
            )
        checked.append(
            {"id": room_id, "name": name, "outline": _checked_outline(room.get("outline")),
             "features": checked_features}
        )
    return checked


def _identity(item: dict[str, Any]) -> tuple[str, str]:
    identifier = item.get("id")
    name = item.get("name")
    if not isinstance(identifier, str) or not _ID_PATTERN.fullmatch(identifier):
        raise RoomPlanError("Every room and feature needs a valid ID.")
    if not isinstance(name, str) or not (0 < len(name.strip()) <= 80) or not name.strip().isprintable():
        raise RoomPlanError("Room and feature names must contain 1 to 80 printable characters.")
    return identifier, name.strip()


def _remember_id(known: set[str], value: str) -> None:
    if value in known:
        raise RoomPlanError("The capture contains duplicate room or feature IDs.")
    known.add(value)


def _twice_area(points: Sequence[Sequence[int]]) -> int:
    return sum(
        point[0] * points[(index + 1) % len(points)][1]
        - point[1] * points[(index + 1) % len(points)][0]
        for index, point in enumerate(points)
    )


def _segments_intersect(a: list[int], b: list[int], c: list[int], d: list[int]) -> bool:
    if any(max(a[i], b[i]) < min(c[i], d[i]) or max(c[i], d[i]) < min(a[i], b[i])
           for i in (0, 1)):
        return False

    def turn(start: list[int], end: list[int], point: list[int]) -> int:
        return ((end[0] - start[0]) * (point[1] - start[1])
                - (end[1] - start[1]) * (point[0] - start[0]))

    return turn(a, b, c) * turn(a, b, d) <= 0 and turn(c, d, a) * turn(c, d, b) <= 0


def _self_intersects(points: list[list[int]]) -> bool:
    count = len(points)
    edges = list(zip(points, points[1:] + points[:1], strict=True))
    for index, (a, b) in enumerate(edges):
        # Consecutive edges share a vertex by construction.
        end = count - 1 if index == 0 else count
        if any(_segments_intersect(a, b, *edges[other]) for other in range(index + 2, end)):
            return True
    return False


def _checked_outline(points: Any) -> list[list[int]]:
    if not isinstance(points, list) or not 3 <= len(points) <= _MAX_VERTICES:
        raise RoomPlanError("An outline must have 3 to 128 vertices.")
    if not all(_valid_point(point) for point in points):
        raise RoomPlanError("Outline coordinates must be signed integer millimeters.")
    if len(set(map(tuple, points))) != len(points) or _twice_area(points) == 0:
        raise RoomPlanError("An outline needs distinct vertices and a measurable area.")
    if _self_intersects(points):
        raise RoomPlanError("An outline cannot cross or touch itself.")
    return [point.copy() for point in points]


def _valid_point(point: Any) -> bool:
    return (
        isinstance(point, list)
        and len(point) == 2
        and all(type(value) is int and abs(value) <= _MAX_COORDINATE for value in point)
    )


def _native_items(room: dict[str, Any], key: str) -> list[dict[str, Any]]:
    items = room.get(key, [])
    if (
        not isinstance(items, list)
        or len(items) > _MAX_FEATURES_PER_ROOM
        or any(not isinstance(item, dict) for item in items)
    ):
        raise RoomPlanError(f"Apple RoomPlan contains invalid {key}.")
    return items


def _vector(raw: Any, count: int) -> list[float]:
    if not isinstance(raw, list) or len(raw) != count:
        raise RoomPlanError("Apple RoomPlan contains an invalid geometry vector.")
    if any(type(value) not in (int, float) or not (-1e6 <= value <= 1e6) for value in raw):
        raise RoomPlanError("Apple RoomPlan contains non-finite or out-of-range geometry.")
    return raw


def _transform(item: dict[str, Any]) -> list[float]:
    value = item.get("transform")
    if isinstance(value, list) and len(value) == 4 and all(isinstance(column, list) for column in value):
        value = [item for column in value for item in _vector(column, 4)]
    return _vector(value, 16)


def _project(matrix: list[float], x: float, y: float, z: float) -> list[int]:
    world_x = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    world_z = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    return [round(1000 * world_x), round(-1000 * world_z)]


def _polygon(points: list[list[int]]) -> list[list[int]]:
    cleaned: list[list[int]] = []
    for point in points:
        if not cleaned or point != cleaned[-1]:
            cleaned.append(point)
    if len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
        cleaned.pop()
    return _checked_outline(cleaned)


def _box(item: dict[str, Any], *, floor: bool = False, depth_minimum: float = 0) -> list[list[int]]:
    width, height, depth = _vector(item.get("dimensions"), 3)
    matrix = _transform(item)
    if width <= 0 or min(height, depth) < 0:
        raise RoomPlanError("Apple RoomPlan contains invalid dimensions.")
    half_x = width / 2
    half_other = (height if floor else max(depth, depth_minimum)) / 2
    return _polygon(
        [_project(matrix, x, other if floor else 0, 0 if floor else other)
         for x, other in ((-half_x, -half_other), (half_x, -half_other),
                          (half_x, half_other), (-half_x, half_other))]
    )


def _boundary_from_walls(walls: list[dict[str, Any]]) -> list[list[int]]:
    if len(walls) < 3:
        raise RoomPlanError("Scan the floor and all the room walls before exporting.")
    segments = []
    for wall in walls:
        if wall.get("curve"):
            raise RoomPlanError("A room with curved walls needs a captured floor outline.")
        width = _vector(wall.get("dimensions"), 3)[0]
        matrix = _transform(wall)
        segments.append((_project(matrix, -width / 2, 0, 0), _project(matrix, width / 2, 0, 0)))
    first, end = segments.pop(0)
    corners = []
    while segments:
        gap, index, side = min(
            (math.dist(end, point), index, side)
            for index, pair in enumerate(segments)
            for side, point in enumerate(pair)
        )
        if gap > _MAX_WALL_GAP_MM:
            raise RoomPlanError("The wall scan has a gap. Import a scan with a captured floor outline.")
        pair = segments.pop(index)
        corners.append([round((a + b) / 2) for a, b in zip(end, pair[side], strict=True)])
        end = pair[1 - side]
    if math.dist(end, first) > _MAX_WALL_GAP_MM:
        raise RoomPlanError("The wall scan does not enclose the room.")
    corners.append([round((a + b) / 2) for a, b in zip(end, first, strict=True)])
    return _polygon(corners)


def _native_outline(floors: list[dict[str, Any]], walls: list[dict[str, Any]]) -> list[list[int]]:
    outlines = []
    for floor in floors:
        corners = floor.get("polygonCorners", [])
        if not isinstance(corners, list) or len(corners) > _MAX_VERTICES + 1:
            raise RoomPlanError("Apple RoomPlan contains an invalid floor outline.")
        if not corners:
            continue
        matrix = _transform(floor)
        outlines.append(_polygon([_project(matrix, *_vector(corner, 3)) for corner in corners]))
    if outlines:
        return max(outlines, key=lambda points: abs(_twice_area(points)))
    if walls:
        try:
            return _boundary_from_walls(walls)
        except RoomPlanError:
            if not floors:
                raise
    if floors:
        return _box(floors[0], floor=True)
    raise RoomPlanError("This Apple RoomPlan scan has no floor or closed wall outline.")


def _native_id(item: dict[str, Any], fallback: str) -> str:
    field = item.get("identifier")
    return field.lower() if isinstance(field, str) and _ID_PATTERN.fullmatch(field) else fallback


def _native_room(room: dict[str, Any], number: int) -> dict[str, Any]:
    floors = _native_items(room, "floors")
    parts = [(kind, label, _native_items(room, field)) for field, kind, label in _SURFACES]
    parts.append(("object", "Object", _native_items(room, "objects")))
    if sum(len(items) for _, _, items in parts) > _MAX_FEATURES_PER_ROOM:
        raise RoomPlanError("A captured room may contain up to 64 features.")
    features = []
    for kind, label, features_of_kind in parts:
        for index, item in enumerate(features_of_kind, 1):
            category = item.get("category")
            category = next(iter(category), None) if isinstance(category, dict) else category
            seating = kind == "object" and category in ("chair", "sofa")
            name = _OBJECT_NAMES.get(category, label) if kind == "object" and isinstance(category, str) else label
            feature = {
                "id": _native_id(item, f"{kind}-{index}"),
                "name": name,
                "kind": "seating" if seating else kind,
                "outline": _box(item, depth_minimum=0.05 if kind != "object" else 0.02),
            }
            features.append(feature)
    sections = _native_items(room, "sections")
    room_label = sections[0].get("label") if sections else None
    default_name = f"Room {number}"
    if isinstance(room_label, str):
        default_name = _ROOM_NAMES.get(room_label, default_name)
    fallback_id = _native_id(floors[0], f"room-{number}") if floors else f"room-{number}"
    return {
        "id": _native_id(room, fallback_id),
        "name": default_name,
        "outline": _native_outline(floors, parts[0][2]),
        "features": features,
    }
