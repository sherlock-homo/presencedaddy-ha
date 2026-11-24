"""Validate and persist the calibration panel's floor plans."""

from __future__ import annotations

import asyncio
import json
import re
from copy import deepcopy
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN
from .roomplan import MAX_SENSOR_PLACEMENTS, RoomPlanError, validate_placement_pose

DATA_FLOORPLANS: HassKey[FloorplanStore] = HassKey(f"{DOMAIN}.floorplans")
_STORAGE_VERSION = 1
_MAX_PLANS = 12
_MAX_PLAN_BYTES = 256 * 1024
_MAX_REVISION = 2**31 - 1
_FEATURE_KINDS = {
    "wall",
    "door",
    "opening",
    "window",
    "object",
    "seating",
    "entry",
    "ignore",
    "area",
}
_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")
_AP_ALIAS = re.compile(r"ap-[0-9a-f]{24}")


class FloorplanError(ValueError):
    """A floor-plan error suitable for returning to a WebSocket caller."""

    def __init__(self, code: str = "invalid_floorplan") -> None:
        super().__init__(code)
        self.code = code


def _record(value: Any, required: set[str], optional: set[str] | None = None) -> dict:
    if (
        not isinstance(value, dict)
        or not required <= value.keys()
        or not value.keys() <= required.union(optional or ())
    ):
        raise FloorplanError
    return value


def _items(value: Any, maximum: int, *, minimum: int = 0) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise FloorplanError
    return value


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise FloorplanError
    return value


def _id(value: Any) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise FloorplanError
    return value


def _name(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 80:
        raise FloorplanError
    name = value.strip()
    if not name.isprintable():
        raise FloorplanError
    return name


def _point(value: Any) -> list[int]:
    return [_integer(i, -1_000_000, 1_000_000) for i in _items(value, 2, minimum=2)]


def _outline(value: Any) -> list[list[int]]:
    points = [_point(point) for point in _items(value, 128, minimum=3)]
    if len({tuple(point) for point in points}) != len(points):
        raise FloorplanError
    area = sum(
        x * other_y - y * other_x
        for (x, y), (other_x, other_y) in zip(
            points, points[1:] + points[:1], strict=True
        )
    )
    if area == 0:
        raise FloorplanError
    return points


def _unique(items: list[dict], key: str) -> list[dict]:
    if len({item[key] for item in items}) != len(items):
        raise FloorplanError
    return items


def _feature(value: Any) -> dict:
    data = _record(value, {"id", "name", "kind", "outline"})
    kind = data["kind"]
    if not isinstance(kind, str) or kind not in _FEATURE_KINDS:
        raise FloorplanError
    return {
        "id": _id(data["id"]),
        "name": _name(data["name"]),
        "kind": kind,
        "outline": _outline(data["outline"]),
    }


def _room(value: Any) -> dict:
    data = _record(value, {"id", "name", "outline", "features"})
    return {
        "id": _id(data["id"]),
        "name": _name(data["name"]),
        "outline": _outline(data["outline"]),
        "features": _unique(
            [_feature(feature) for feature in _items(data["features"], 64)], "id"
        ),
    }


def _sensor(value: Any) -> dict:
    data = _record(value, {"entry_id", "anchors", "mirrored"}, {"placement"})
    if type(data["mirrored"]) is not bool:
        raise FloorplanError
    has_placement = "placement" in data
    anchors = []
    for item in _items(data["anchors"], 8, minimum=0 if has_placement else 2):
        anchor = _record(item, {"radar", "plan"})
        anchors.append(
            {"radar": _point(anchor["radar"]), "plan": _point(anchor["plan"])}
        )
    if anchors and any(
        len({tuple(anchor[field]) for anchor in anchors}) < 2
        for field in ("radar", "plan")
    ):
        raise FloorplanError
    sensor = {
        "entry_id": _id(data["entry_id"]),
        "anchors": anchors,
        "mirrored": data["mirrored"],
    }
    if has_placement:
        try:
            sensor["placement"] = validate_placement_pose(data["placement"])
        except RoomPlanError as error:
            raise FloorplanError from error
    return sensor


def _wifi_signal(value: Any) -> dict:
    data = _record(value, {"ap", "rssi"})
    alias = data["ap"]
    if not isinstance(alias, str) or _AP_ALIAS.fullmatch(alias) is None:
        raise FloorplanError
    return {"ap": alias, "rssi": _integer(data["rssi"], -127, -1)}


def _wifi_sample(value: Any) -> dict:
    data = _record(value, {"id", "position", "signals"})
    return {
        "id": _id(data["id"]),
        "position": _point(data["position"]),
        "signals": _unique(
            [_wifi_signal(signal) for signal in _items(data["signals"], 32, minimum=1)],
            "ap",
        ),
    }


def validate_floorplan(value: Any) -> dict:
    """Return a canonical, detached plan with bounded geometry and labels."""
    data = _record(value, {"id", "name", "rooms", "sensors", "wifi"}, {"revision"})
    rooms = _unique([_room(room) for room in _items(data["rooms"], 32)], "id")
    if sum(len(room["features"]) for room in rooms) > 256:
        raise FloorplanError("floorplan_limit")
    plan = {
        "id": _id(data["id"]),
        "name": _name(data["name"]),
        "rooms": rooms,
        "sensors": _unique(
            [_sensor(sensor) for sensor in _items(data["sensors"], MAX_SENSOR_PLACEMENTS)],
            "entry_id",
        ),
        "wifi": _unique(
            [_wifi_sample(wifi) for wifi in _items(data["wifi"], 256)], "id"
        ),
    }
    if "revision" in data:
        plan["revision"] = _integer(data["revision"], 0, _MAX_REVISION)
    largest_revision = {**plan, "revision": _MAX_REVISION}
    if len(json.dumps(largest_revision, ensure_ascii=False).encode()) > _MAX_PLAN_BYTES:
        raise FloorplanError("floorplan_limit")
    return plan


class FloorplanStore:
    """Commit revision-checked edits to Home Assistant's private storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store[dict[str, Any]](
            hass,
            _STORAGE_VERSION,
            DATA_FLOORPLANS,
            private=True,
            atomic_writes=True,
            serialize_in_event_loop=False,
        )
        self._plans: dict[str, dict] | None = None
        self._lock = asyncio.Lock()

    async def async_list(self) -> list[dict]:
        """List the last persisted snapshots."""
        async with self._lock:
            return deepcopy(list((await self._async_get_plans()).values()))

    async def async_save(self, value: Any, expected_revision: int) -> dict:
        """Create from revision zero, or replace exactly the requested revision."""
        expected = _integer(expected_revision, 0, _MAX_REVISION)
        plan = validate_floorplan(value)
        if plan.get("revision", expected) != expected:
            raise FloorplanError("floorplan_conflict")
        if expected == _MAX_REVISION:
            raise FloorplanError("floorplan_limit")
        # A canceled response must not leave a started atomic write ahead of live state.
        task = self._hass.async_create_task(
            self._async_save(plan, expected), "save_floorplan"
        )
        return await asyncio.shield(task)

    async def _async_save(self, plan: dict, expected: int) -> dict:
        async with self._lock:
            plans = await self._async_get_plans()
            plan_id = plan["id"]
            current = plans.get(plan_id)
            if current is None and expected != 0:
                raise FloorplanError("floorplan_not_found")
            if current is not None and current["revision"] != expected:
                raise FloorplanError("floorplan_conflict")
            if current is None and len(plans) >= _MAX_PLANS:
                raise FloorplanError("floorplan_limit")
            saved = {**plan, "revision": expected + 1}
            await self._async_persist({**plans, plan_id: saved})
            return deepcopy(saved)

    async def async_delete(self, plan_id: Any, expected_revision: int) -> None:
        """Delete exactly the requested revision."""
        plan_id = _id(plan_id)
        expected = _integer(expected_revision, 1, _MAX_REVISION)
        task = self._hass.async_create_task(
            self._async_delete(plan_id, expected), "delete_floorplan"
        )
        await asyncio.shield(task)

    async def _async_delete(self, plan_id: str, expected: int) -> None:
        async with self._lock:
            plans = await self._async_get_plans()
            current = plans.get(plan_id)
            if current is None:
                raise FloorplanError("floorplan_not_found")
            if current["revision"] != expected:
                raise FloorplanError("floorplan_conflict")
            remaining = plans.copy()
            del remaining[plan_id]
            await self._async_persist(remaining)

    async def _async_get_plans(self) -> dict[str, dict]:
        if self._plans is None:
            try:
                stored = await self._store.async_load()
                loaded = []
                if stored is not None:
                    data = _record(stored, {"plans"})
                    for item in _items(data["plans"], _MAX_PLANS):
                        plan = validate_floorplan(item)
                        _integer(plan.get("revision"), 1, _MAX_REVISION)
                        loaded.append(plan)
                self._plans = {plan["id"]: plan for plan in _unique(loaded, "id")}
            except (HomeAssistantError, OSError, FloorplanError):
                raise FloorplanError("floorplan_storage_failed") from None
        return self._plans

    async def _async_persist(self, plans: dict[str, dict]) -> None:
        if self._hass.is_stopping:
            raise FloorplanError("floorplan_storage_failed")
        data = {"plans": list(plans.values())}
        try:
            await self._store.async_save(data)
        except (HomeAssistantError, OSError):
            raise FloorplanError("floorplan_storage_failed") from None
        # Store can log a write error without raising it. Verify what is on disk.
        try:
            stored = await self._store.async_load()
        except (HomeAssistantError, OSError):
            # If the write committed, reload its revision before accepting another edit.
            self._plans = None
            raise FloorplanError("floorplan_storage_failed") from None
        if stored != data:
            raise FloorplanError("floorplan_storage_failed")
        self._plans = plans
