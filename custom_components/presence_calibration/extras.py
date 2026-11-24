"""Manage optional LCD feeds and private, opt-in household track learning."""

from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import date
from functools import partial
from itertools import pairwise
from typing import Any
from uuid import uuid4

from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback, valid_entity_id
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN
from .device import CalibrationClient, CalibrationError
from .learning import (
    SAMPLE_KINDS,
    LiveFrame,
    MotionModel,
    Observation,
    TrackWindow,
    assess,
    live_frame,
)
from .residents import ResidentRooms
from .roomplan import valid_placement_entry_id
from .sd_sessions import sd_sample

DATA_EXTRAS: HassKey[PresenceExtras] = HassKey(f"{DOMAIN}.extras")
DISPLAY_FIELDS = ("show_occupancy", "show_clock", "show_sensor", "log_enabled")
DISPLAY_PREFERENCES = {
    "orientation": ("horizontal", "vertical"),
    "mode": ("eyes", "dashboard"),
}
TRACK_EVENT = "presence_daddy_track"
HANDOFF_EVENT = "presence_daddy_handoff"
_TRAIN_SECONDS = 45.0
_POLL_SECONDS = 0.3
_MAX_SAMPLES = 1600
_MAX_WINDOWS = 22
_MAX_LINKS = 24
_MAX_FEEDS = 32
_TRAIN_KEY = (DOMAIN, "training")


def _empty_state() -> dict[str, Any]:
    return {"feeds": {}, "samples": [], "enabled": [], "links": []}


def _entities(value: Any) -> list[str]:
    if (
        not isinstance(value, list)
        or len(value) > 4
        or any(
            not isinstance(item, str) or len(item) > 128 or not valid_entity_id(item)
            for item in value
        )
        or len(set(value)) != len(value)
    ):
        raise CalibrationError("invalid_entities")
    return value.copy()


def _person(value: Any) -> str:
    if not isinstance(value, str):
        raise CalibrationError("invalid_person")
    name = value.strip()
    if len(name) > 32 or not name.isprintable() or name.casefold() == "unknown":
        raise CalibrationError("invalid_person")
    return name


def _sample(value: Any) -> dict[str, Any]:
    required = {"id", "entry_id", "kind", "person", "day", "features"}
    if not isinstance(value, dict) or not required <= value.keys() <= required | {
        "capture"
    }:
        raise CalibrationError("invalid_training")
    if not valid_placement_entry_id(value["id"]) or not valid_placement_entry_id(
        value["entry_id"]
    ):
        raise CalibrationError("invalid_training")
    kind, features = value["kind"], value["features"]
    if (
        not isinstance(kind, str)
        or kind not in SAMPLE_KINDS
        or not isinstance(features, list)
    ):
        raise CalibrationError("invalid_training")
    if len(features) > _MAX_WINDOWS or (not features and kind != "ambiguous"):
        raise CalibrationError("insufficient_movement")
    for row in features:
        if not isinstance(row, (list, tuple)) or len(row) != 4:
            raise CalibrationError("invalid_training")
        if any(
            type(number) not in (int, float) or not 0 <= number <= maximum
            for number, maximum in zip(row, (3, 8, 1, 1), strict=True)
        ):
            raise CalibrationError("invalid_training")
    try:
        day = date.fromisoformat(value["day"]).isoformat()
    except (ValueError, TypeError):
        raise CalibrationError("invalid_training") from None
    if day != value["day"]:
        raise CalibrationError("invalid_training")
    person = value["person"]
    if kind in {"enroll", "resident"}:
        person = _person(person)
    elif person is not None:
        raise CalibrationError("invalid_training")
    if "capture" in value:
        clip = value["capture"]
        if (
            not isinstance(clip, list)
            or len(clip) != 3
            or any(type(number) is not int for number in clip)
            or not 0 <= clip[0] <= 0xFFFFFFFF
            or not 0 <= clip[1] <= clip[2] <= 0xFFFFFFFFFFFFFFFF
        ):
            raise CalibrationError("invalid_training")
    return {**value, "person": person, "features": [list(row) for row in features]}


def _pair(value: Any) -> tuple[str, str]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or any(not valid_placement_entry_id(item) for item in value)
        or value[0] == value[1]
    ):
        raise CalibrationError("invalid_link")
    first, second = sorted(value)
    return first, second


def _checked_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.keys() != _empty_state().keys():
        raise CalibrationError("feature_storage_failed")
    feeds, samples, enabled, links = (
        value[key] for key in ("feeds", "samples", "enabled", "links")
    )
    if (
        not isinstance(feeds, dict)
        or len(feeds) > _MAX_FEEDS
        or not all(valid_placement_entry_id(key) for key in feeds)
        or not isinstance(samples, list)
        or len(samples) > _MAX_SAMPLES
        or not isinstance(enabled, list)
        or len(enabled) > _MAX_FEEDS
        or not all(valid_placement_entry_id(key) for key in enabled)
        or not isinstance(links, list)
        or len(links) > _MAX_LINKS
    ):
        raise CalibrationError("feature_storage_failed")
    checked = {
        "feeds": {key: _entities(entities) for key, entities in feeds.items()},
        "samples": [_sample(sample) for sample in samples],
        "enabled": list(dict.fromkeys(enabled)),
        "links": [list(pair) for pair in sorted({_pair(link) for link in links})],
    }
    if len({sample["id"] for sample in checked["samples"]}) != len(checked["samples"]):
        raise CalibrationError("training_duplicate")
    clips = sorted(
        (sample["entry_id"], *sample["capture"])
        for sample in checked["samples"]
        if "capture" in sample
    )
    for previous, current in pairwise(clips):
        if previous[:2] == current[:2] and current[2] <= previous[3]:
            raise CalibrationError("training_duplicate")
    return checked


def _text(value: str) -> str:
    printable = "".join(
        character for character in value if character.isprintable()
    ).strip()
    return printable.encode("utf-8")[:24].decode("utf-8", errors="ignore")


def display_feed(hass: HomeAssistant, entity_id: str | None) -> dict[str, Any]:
    """Send actual configured local time and only the selected entity's value."""
    now = dt_util.now()
    offset = now.utcoffset()
    label = value = ""
    if entity_id:
        state = hass.states.get(entity_id)
        label = _text(state.name if state else entity_id)
        if state is None or state.state in {"unknown", "unavailable"}:
            value = "Unavailable"
        else:
            unit = state.attributes.get("unit_of_measurement")
            value = _text(
                f"{state.state} {unit}"
                if isinstance(unit, str) and unit
                else state.state
            )
    return {
        "unix_seconds": int(now.timestamp()),
        "utc_offset_minutes": int(offset.total_seconds() / 60) if offset else 0,
        "sensor_label": label,
        "sensor_value": value,
    }


class _FeatureStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = Store(
            hass,
            1,
            DATA_EXTRAS,
            private=True,
            atomic_writes=True,
            serialize_in_event_loop=False,
        )
        self._lock = asyncio.Lock()
        self.state: dict[str, Any] | None = None

    async def _load(self) -> dict[str, Any]:
        if self.state is None:
            try:
                value = await self._store.async_load()
                self.state = _empty_state() if value is None else _checked_state(value)
            except (CalibrationError, HomeAssistantError, OSError):
                raise CalibrationError("feature_storage_failed") from None
        return self.state

    async def read(self) -> dict[str, Any]:
        async with self._lock:
            return await self._load()

    async def change(self, edit: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        task = self._hass.async_create_task(self._change(edit), "presence-extras-save")
        return await asyncio.shield(task)

    async def _change(self, edit: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        async with self._lock:
            if self._hass.is_stopping:
                raise CalibrationError("feature_storage_failed")
            data = deepcopy(await self._load())
            edit(data)
            data = _checked_state(data)
            try:
                await self._store.async_save(data)
                if await self._store.async_load() != data:
                    raise CalibrationError("feature_storage_failed")
            except (CalibrationError, HomeAssistantError, OSError):
                self.state = None
                raise CalibrationError("feature_storage_failed") from None
            self.state = data
            return data


@dataclass(slots=True)
class _Training:
    owner: ActiveConnection
    entry_id: str
    kind: str
    person: str | None
    day: str
    deadline: float
    features: list[tuple[float, ...]] = field(default_factory=list)
    ambiguous: bool = False
    last_window: float = -math.inf
    capture: list[int] | None = None
    error: str | None = None
    track_id: int | None = None


@dataclass(slots=True)
class _Node:
    entry: ConfigEntry
    client: CalibrationClient
    feed_task: asyncio.Task | None = None
    track_task: asyncio.Task | None = None
    setup_task: asyncio.Task | None = None
    setup_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    setup_confirmed: bool = False
    feed_error: str | None = None
    track_error: str | None = None
    model: MotionModel | None = None
    identified: str | None = None
    candidate: str | None = None
    candidate_since: float = 0.0
    last: LiveFrame | None = None
    last_at: float = 0.0
    leaving: _Departure | None = None


@dataclass(frozen=True, slots=True)
class _Departure:
    entry_id: str
    time: float
    person: str | None


@dataclass(frozen=True, slots=True)
class _Handoff:
    source: _Departure
    target_boot: int
    target_track: int
    deadline: float


class PresenceExtras:
    """Operate sessionless feeds and keep enrollment under local admin control."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._store = _FeatureStore(hass)
        self.residents = ResidentRooms(hass)
        self._nodes: dict[str, _Node] = {}
        self._training: _Training | None = None
        self._controls = asyncio.Lock()
        self._departures: dict[str, _Departure] = {}
        self._arrivals: dict[str, _Handoff] = {}
        self._assessment_data: dict | None = None
        self._assessed: dict[str, dict] = {}

    async def _assess(self, entry_id: str, data: dict, samples: list[dict]) -> dict:
        if self._assessment_data is not data:
            self._assessment_data = data
            self._assessed.clear()
        if entry_id in self._assessed:
            return self._assessed[entry_id]
        report = await self._hass.async_add_executor_job(assess, samples)
        if self._assessment_data is data:
            self._assessed[entry_id] = report
        return report

    async def add(self, entry: ConfigEntry, client: CalibrationClient) -> None:
        node = self._nodes[entry.entry_id] = _Node(entry, client)
        try:
            await self._reconcile(await self._store.read())
        except CalibrationError as error:
            node.track_error = node.feed_error = error.code

    async def remove(self, entry_id: str, *, delete: bool = False) -> None:
        node = self._nodes.pop(entry_id, None)
        self._assessed.pop(entry_id, None)
        if self._training and self._training.entry_id == entry_id:
            self._detach_training()
        if node:
            tasks = [
                task
                for task in (node.track_task, node.feed_task, node.setup_task)
                if task is not None
            ]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._clear_track(node)
        await self.residents.remove_platform(entry_id)
        if delete:

            def edit(data: dict) -> None:
                data["feeds"].pop(entry_id, None)
                data["samples"] = [
                    sample
                    for sample in data["samples"]
                    if sample["entry_id"] != entry_id
                ]
                data["links"] = [link for link in data["links"] if entry_id not in link]
                data["enabled"] = [key for key in data["enabled"] if key != entry_id]

            await self._reconcile(await self._store.change(edit))

    def _node(self, entry_id: str) -> _Node:
        if entry_id not in self._nodes:
            raise CalibrationError("entry_unavailable")
        return self._nodes[entry_id]

    async def _request(self, node: _Node, method: str, path: str, **kwargs) -> dict:
        try:
            return await node.client.request(method, path, **kwargs)
        except CalibrationError as error:
            if error.status in {404, 405, 501}:
                raise CalibrationError("unsupported_feature", error.status) from None
            raise

    @callback
    def schedule_setup_check(self, entry_id: str) -> None:
        """Check an installed entry without waiting for optional LCD networking."""
        node = self._nodes.get(entry_id)
        if (
            node is None
            or node.setup_confirmed
            or (node.setup_task is not None and not node.setup_task.done())
        ):
            return
        node.setup_task = node.entry.async_create_background_task(
            self._hass,
            self._complete_setup_if_needed(node),
            "presence-daddy-setup",
            eager_start=False,
        )

    async def _complete_setup_if_needed(
        self, node: _Node, observed: dict | None = None
    ) -> dict | None:
        """Complete setup through the pinned client only when the device offers it."""
        async with node.setup_lock:
            if observed is None and node.setup_confirmed:
                return None
            try:
                status = observed
                if status is None:
                    status = await self._request(node, "GET", "/v1/display")
                complete = status.get("setup_complete")
                if complete is False:
                    node.setup_confirmed = False
                    await self._request(node, "POST", "/v1/display/complete-setup")
                    node.setup_confirmed = True
                    return {**status, "setup_complete": True}
                if complete is True:
                    node.setup_confirmed = True
                return status
            except CalibrationError:
                # Completion is optional. A later read or manual action can retry.
                return observed

    async def display(self, entry_id: str, action: str, payload: dict) -> dict:
        node = self._node(entry_id)
        if action == "set":
            if (
                not set(DISPLAY_FIELDS) <= payload.keys()
                or not payload.keys() <= {*DISPLAY_FIELDS, *DISPLAY_PREFERENCES}
                or any(type(payload[key]) is not bool for key in DISPLAY_FIELDS)
                or any(
                    key in payload and payload[key] not in options
                    for key, options in DISPLAY_PREFERENCES.items()
                )
            ):
                raise CalibrationError("invalid_display")
            await self._request(node, "PUT", "/v1/display", body=payload)
        elif action == "feed":
            if (
                payload.keys() != {"enabled", "entities"}
                or type(payload["enabled"]) is not bool
            ):
                raise CalibrationError("invalid_entities")
            entities = _entities(payload["entities"])
            if payload["enabled"]:
                await self._request(node, "GET", "/v1/display")

            def edit(data: dict) -> None:
                if payload["enabled"]:
                    data["feeds"][entry_id] = entities
                else:
                    data["feeds"].pop(entry_id, None)

            data = await self._store.change(edit)
            if node.feed_task:
                node.feed_task.cancel()
                node.feed_task = None
            node.feed_error = None
            await self._reconcile(data)
        elif action in {"close_eyes", "complete_setup"}:
            if payload:
                raise CalibrationError("invalid_display")
            routes = {"close_eyes": "close-eyes", "complete_setup": "complete-setup"}
            await self._request(node, "POST", f"/v1/display/{routes[action]}")
            if action == "complete_setup":
                node.setup_confirmed = True
        response = await self._request(node, "GET", "/v1/display")
        if "setup_complete" in response:
            response = await self._complete_setup_if_needed(node, response) or response
        data = await self._store.read()
        return {
            "display": {
                key: response.get(key)
                for key in (
                    *DISPLAY_FIELDS,
                    "lcd_ready",
                    "sd_ready",
                    "logging",
                    "eyes_active",
                    "eyes_seconds_remaining",
                    "dropped_log_samples",
                    *DISPLAY_PREFERENCES,
                    "setup_complete",
                )
            },
            "feed_enabled": entry_id in data["feeds"],
            "entities": data["feeds"].get(entry_id, []),
            "feed_error": node.feed_error,
        }

    async def train(
        self, owner: ActiveConnection, entry_id: str, action: str, payload: dict
    ) -> dict:
        node = self._node(entry_id)
        async with self._controls:
            if action == "start":
                if self._training is not None:
                    raise CalibrationError("training_busy")
                kind = payload.get("kind")
                if (
                    payload.get("consent") is not True
                    or not isinstance(kind, str)
                    or kind not in SAMPLE_KINDS
                ):
                    raise CalibrationError("invalid_training")
                person = (
                    _person(payload.get("person"))
                    if kind in {"enroll", "resident"}
                    else None
                )
                data = await self._store.read()
                samples = [
                    row for row in data["samples"] if row["entry_id"] == entry_id
                ]
                matching = {
                    row["person"].casefold(): row["person"]
                    for row in data["samples"]
                    if row["person"]
                }
                if person is not None:
                    person = matching.get(person.casefold(), person)
                day = dt_util.now().date().isoformat()
                if kind == "resident" and not any(
                    row["kind"] == "enroll" and row["person"] == person
                    for row in samples
                ):
                    raise CalibrationError("person_not_enrolled")
                if any(
                    row["day"] == day
                    and (row["kind"] == "enroll") != (kind == "enroll")
                    for row in samples
                ):
                    raise CalibrationError("separate_validation_day")
                # Check endpoint capability and watch for an owner who closes during TLS setup.
                pending = object()
                disconnected = False

                def owner_closed() -> None:
                    nonlocal disconnected
                    disconnected = True

                owner.subscriptions[pending] = owner_closed
                try:
                    live_frame(await self._request(node, "GET", "/v1/live"))
                finally:
                    owner.subscriptions.pop(pending, None)
                if disconnected or entry_id not in self._nodes:
                    raise CalibrationError("training_not_owned")
                self._training = _Training(
                    owner,
                    entry_id,
                    kind,
                    person,
                    day,
                    asyncio.get_running_loop().time() + _TRAIN_SECONDS,
                )
                owner.subscriptions[_TRAIN_KEY] = self._detach_training
                for tracked in self._nodes.values():
                    self._clear_track(tracked)
                await self._reconcile(data)
            elif action in {"end", "cancel"}:
                current = self._training
                if (
                    current is None
                    or current.owner is not owner
                    or current.entry_id != entry_id
                ):
                    raise CalibrationError("training_not_owned")
                self._detach_training()
                if action == "end":
                    if current.error is not None:
                        raise CalibrationError(current.error)
                    if current.capture is None:
                        raise CalibrationError("insufficient_movement")
                    if dt_util.now().date().isoformat() != current.day:
                        raise CalibrationError("separate_validation_day")
                    if current.kind == "ambiguous" and not current.ambiguous:
                        raise CalibrationError("no_ambiguous_track")
                    if current.kind != "ambiguous" and current.ambiguous:
                        raise CalibrationError("training_overlap")
                    await self.import_samples(
                        [
                            {
                                "id": uuid4().hex,
                                "entry_id": entry_id,
                                "kind": current.kind,
                                "person": current.person,
                                "day": current.day,
                                "features": current.features,
                                "capture": current.capture,
                            }
                        ]
                    )
                else:
                    await self._reconcile(await self._store.read())
            elif action == "sd_import":
                await self._import_sd(entry_id, payload)
            elif action == "enable":
                enabled = payload.get("enabled")
                if type(enabled) is not bool:
                    raise CalibrationError("invalid_training")

                def edit(data: dict) -> None:
                    samples = [
                        row for row in data["samples"] if row["entry_id"] == entry_id
                    ]
                    if enabled and not assess(samples)["passed"]:
                        raise CalibrationError("validation_required")
                    data["enabled"] = [
                        key for key in data["enabled"] if key != entry_id
                    ]
                    if enabled:
                        data["enabled"].append(entry_id)

                await self._reconcile(await self._store.change(edit))
            elif action == "forget":
                person = payload.get("person")
                if person is not None:
                    person = _person(person)
                if self._training and self._training.entry_id == entry_id:
                    raise CalibrationError("training_busy")

                def edit(data: dict) -> None:
                    data["samples"] = [
                        row
                        for row in data["samples"]
                        if row["entry_id"] != entry_id
                        or (person is not None and row["person"] != person)
                    ]
                    data["enabled"] = [
                        key for key in data["enabled"] if key != entry_id
                    ]

                await self._reconcile(await self._store.change(edit))
            elif action in {"link", "unlink"}:
                pair = _pair([entry_id, payload.get("other_entry_id")])
                if action == "link":
                    other = self._node(payload["other_entry_id"])
                    for link_node in (node, other):
                        live_frame(await self._request(link_node, "GET", "/v1/live"))

                def edit(data: dict) -> None:
                    data["links"] = [
                        link for link in data["links"] if tuple(link) != pair
                    ]
                    if action == "link":
                        data["links"].append(list(pair))

                await self._reconcile(await self._store.change(edit))
            return await self.training_status(owner, entry_id)

    async def _import_sd(self, entry_id: str, payload: dict) -> None:
        if self._training is not None:
            raise CalibrationError("training_busy")
        clip, kind, day = (payload.get(key) for key in ("clip", "kind", "day"))
        if (
            not isinstance(clip, str)
            or not 1 <= len(clip) <= 96 * 1024
            or len(clip.encode("utf-8", errors="replace")) > 96 * 1024
            or not isinstance(kind, str)
            or kind not in SAMPLE_KINDS
            or payload.get("consent") is not True
            or (day is not None and (not isinstance(day, str) or len(day) != 10))
        ):
            raise CalibrationError("invalid_training")
        person = (
            _person(payload.get("person")) if kind in {"enroll", "resident"} else None
        )
        data = await self._store.read()
        if kind == "resident" and not any(
            sample["entry_id"] == entry_id
            and sample["kind"] == "enroll"
            and sample["person"] == person
            for sample in data["samples"]
        ):
            raise CalibrationError("person_not_enrolled")
        sample = await self._hass.async_add_executor_job(
            partial(
                sd_sample,
                clip,
                entry_id=entry_id,
                kind=kind,
                person=person,
                local_tz=dt_util.now().tzinfo,
                day=day,
            )
        )
        await self.import_samples([sample])

    async def import_samples(self, rows: list[dict]) -> None:
        """Commit bounded local derived features from one or more authorized sessions."""
        samples = [_sample(row) for row in rows]

        def edit(data: dict) -> None:
            if len(data["samples"]) + len(samples) > _MAX_SAMPLES:
                raise CalibrationError("training_limit")
            modes = {
                (row["entry_id"], row["day"]): row["kind"] == "enroll"
                for row in data["samples"]
            }
            for row in samples:
                key = row["entry_id"], row["day"]
                enrollment = row["kind"] == "enroll"
                if modes.setdefault(key, enrollment) != enrollment:
                    raise CalibrationError("separate_validation_day")
            data["samples"].extend(samples)
            changed = {sample["entry_id"] for sample in samples}
            data["enabled"] = [key for key in data["enabled"] if key not in changed]

        await self._reconcile(await self._store.change(edit))

    async def training_status(self, owner: ActiveConnection, entry_id: str) -> dict:
        node = self._node(entry_id)
        data = await self._store.read()
        samples = [row for row in data["samples"] if row["entry_id"] == entry_id]
        current = self._training
        capture = None
        if current and current.owner is owner and current.entry_id == entry_id:
            capture = {
                "kind": current.kind,
                "person": current.person,
                "windows": len(current.features),
                "ambiguous": current.ambiguous,
                "error": current.error,
                "seconds_remaining": max(
                    0, math.ceil(current.deadline - asyncio.get_running_loop().time())
                ),
            }
        return {
            "assessment": await self._assess(entry_id, data, samples),
            "samples": len(samples),
            "capture": capture,
            "busy": current is not None,
            "enabled": node.model is not None,
            "error": node.track_error,
            "links": [
                next(key for key in link if key != entry_id)
                for link in data["links"]
                if entry_id in link
            ],
        }

    def _detach_training(self) -> None:
        current, self._training = self._training, None
        if current:
            current.owner.subscriptions.pop(_TRAIN_KEY, None)
            node = self._nodes.get(current.entry_id)
            if node:
                self._clear_track(node)

    async def _reconcile(self, data: dict) -> None:
        by_entry: dict[str, list[dict]] = defaultdict(list)
        for sample in data["samples"]:
            by_entry[sample["entry_id"]].append(sample)
        linked = {key for link in data["links"] for key in link}
        for key, node in list(self._nodes.items()):
            samples = by_entry[key]
            enabled = (
                key in data["enabled"]
                and (await self._assess(key, data, samples))["passed"]
            )
            if self._nodes.get(key) is not node or self._store.state is not data:
                continue
            if not enabled and node.model is not None:
                self._clear_track(node)
                self.residents.invalidate(key)
            node.model = MotionModel(samples) if enabled else None
            should_track = (
                enabled
                or key in linked
                or (self._training and self._training.entry_id == key)
            )
            if should_track and (node.track_task is None or node.track_task.done()):
                node.track_task = node.entry.async_create_background_task(
                    self._hass,
                    self._poll_tracks(key, node),
                    "presence-daddy-tracks",
                    eager_start=False,
                )
            if key in data["feeds"] and (
                node.feed_task is None or node.feed_task.done()
            ):
                node.feed_task = node.entry.async_create_background_task(
                    self._hass,
                    self._push_feed(key, node),
                    "presence-daddy-display",
                    eager_start=False,
                )
        if self._store.state is data:
            await self.residents.reconcile(
                data["samples"],
                {
                    key: node.model.labels
                    for key, node in self._nodes.items()
                    if node.model is not None
                },
            )

    async def _push_feed(self, key: str, node: _Node) -> None:
        index, delay = 0, 15
        while key in (data := await self._store.read())["feeds"]:
            entities = data["feeds"][key]
            entity = entities[index % len(entities)] if entities else None
            try:
                await self._request(
                    node,
                    "PUT",
                    "/v1/display/feed",
                    body=display_feed(self._hass, entity),
                )
            except CalibrationError as error:
                node.feed_error = error.code
                delay = min(delay * 2, 120)
            else:
                node.feed_error = None
                index += 1
                delay = 15 if len(entities) > 1 else 30
            await asyncio.sleep(delay)

    async def _poll_tracks(self, key: str, node: _Node) -> None:
        window = TrackWindow()
        loop = asyncio.get_running_loop()
        delay = _POLL_SECONDS
        capture: _Training | None = None
        while key in self._nodes:
            data = await self._store.read()
            current = self._training
            active = (
                current is not None
                and current.entry_id == key
                and loop.time() < current.deadline
            )
            if (
                not active
                and node.model is None
                and not any(key in link for link in data["links"])
            ):
                self._clear_track(node)
                return
            if current is not capture:
                window.clear()
                capture = current
            started = loop.time()
            stale = (
                loop.call_later(1.2, self._clear_track, node)
                if node.last is not None
                else None
            )
            try:
                frame = live_frame(await self._request(node, "GET", "/v1/live"))
            except CalibrationError as error:
                node.track_error = error.code
                window.clear()
                self._clear_track(node)
                delay = min(delay * 2, 8)
            else:
                node.track_error = None
                delay = _POLL_SECONDS
                now = loop.time()
                observed = window.add(frame, now)
                if (
                    observed is None
                    and node.last is not None
                    and now - node.last_at > 1.2
                ):
                    self._clear_track(node)
                if observed is not None:
                    if active and current is self._training and now < current.deadline:
                        self._record_training(current, frame, observed, now)
                    elif self._training is None:
                        latest = await self._store.read()
                        features = (
                            observed.features if key in latest["enabled"] else None
                        )
                        self._track(node, frame, features, now, latest["links"])
            finally:
                if stale is not None:
                    stale.cancel()
            await asyncio.sleep(max(0, started + delay - loop.time()))

    def _record_training(
        self, current: _Training, frame: LiveFrame, observed: Observation, now: float
    ) -> None:
        if not frame.fresh or current.error is not None:
            return
        if current.capture is None:
            current.capture = [frame.boot_id, frame.uptime_ms, frame.uptime_ms]
        elif (
            current.capture[0] != frame.boot_id or frame.uptime_ms < current.capture[2]
        ):
            current.error = "training_restarted"
            return
        else:
            current.capture[2] = frame.uptime_ms
        current.ambiguous |= observed.ambiguous
        if (
            observed.features
            and now - current.last_window >= 1.5
            and len(current.features) < _MAX_WINDOWS
        ):
            track_id = frame.tracks[0].id
            if current.kind != "ambiguous" and current.track_id not in (None, track_id):
                current.error = "training_track_changed"
                return
            current.track_id = track_id
            current.features.append(observed.features)
            current.last_window = now

    def _publish_track(
        self, node: _Node, person: str | None, *, arrived: bool = False
    ) -> None:
        if person is None:
            self.residents.withdraw(node.entry.entry_id)
        else:
            self.residents.observe(node.entry, person)
        if arrived or person != node.identified:
            node.identified = person
            self._hass.bus.async_fire(
                TRACK_EVENT,
                {
                    "entry_id": node.entry.entry_id,
                    "person": person,
                    "state": "named" if person else "unknown",
                },
            )

    def _clear_track(self, node: _Node) -> None:
        key = node.entry.entry_id
        node.last = None
        node.leaving = None
        node.candidate = None
        self._publish_track(node, None)
        self._departures.pop(key, None)
        self._arrivals.pop(key, None)
        for target, handoff in list(self._arrivals.items()):
            if handoff.source.entry_id == key:
                self._arrivals.pop(target)

    def _track(
        self,
        node: _Node,
        frame: LiveFrame,
        features: tuple | None,
        now: float,
        links: list[list[str]],
    ) -> None:
        key = node.entry.entry_id
        if (
            not frame.fresh
            or len(frame.tracks) > 1
            or any(track.ambiguous for track in frame.tracks)
        ):
            self._clear_track(node)
            return
        previous = node.last
        continuous = (
            previous is not None
            and previous.boot_id == frame.boot_id
            and now - node.last_at <= 1.2
        )
        node.last, node.last_at = frame, now
        previous_track = previous.tracks[0] if continuous and previous.tracks else None
        if not continuous:
            self._publish_track(node, None)
            node.candidate = None
            self._arrivals.pop(key, None)
            self._departures.pop(key, None)
            node.leaving = None
        leaving = (
            previous_track
            and previous.entry
            and math.hypot(previous_track.vx, previous_track.vy) >= 250
        )
        if frame.tracks and frame.tracks[0].coasting:
            if (
                leaving
                and not previous_track.coasting
                and previous_track.id == frame.tracks[0].id
            ):
                node.leaving = _Departure(key, now, node.identified)
            self._publish_track(node, None)
            node.candidate = None
            self._arrivals.pop(key, None)
            return
        if not frame.tracks:
            if node.leaving and now - node.leaving.time <= 1.25:
                self._departures[key] = _Departure(key, now, node.leaving.person)
            elif leaving and not previous_track.coasting:
                self._departures[key] = _Departure(key, now, node.identified)
            node.leaving = None
            self._publish_track(node, None)
            node.candidate = None
            self._arrivals.pop(key, None)
            return
        [track] = frame.tracks
        node.leaving = None
        if previous_track is None or previous_track.id != track.id:
            self._publish_track(node, None, arrived=True)
            node.candidate = None
            self._departures.pop(key, None)
            self._arrivals.pop(key, None)
            if continuous and previous_track is None and frame.entry:
                sources = [
                    self._departures[other]
                    for link in links
                    if key in link
                    for other in link
                    if other != key
                    and other in self._departures
                    and 0.35 <= now - self._departures[other].time <= 4.0
                ]
                if len(sources) == 1:
                    source = self._departures.pop(sources[0].entry_id)
                    self._arrivals[key] = _Handoff(
                        source, frame.boot_id, track.id, now + 5.0
                    )
        person = node.model.predict(features) if node.model else None
        if person != node.candidate:
            node.candidate, node.candidate_since = person, now
        if not person or person != node.identified:
            self._publish_track(
                node, person if person and now - node.candidate_since >= 0.8 else None
            )
        elif node.identified is not None:
            self.residents.observe(node.entry, node.identified)
        pending = self._arrivals.get(key)
        if pending and list(_pair([key, pending.source.entry_id])) not in links:
            self._arrivals.pop(key)
            return
        if (
            pending
            and pending.target_boot == frame.boot_id
            and pending.target_track == track.id
        ):
            matched = (
                node.identified is not None and pending.source.person == node.identified
            )
            if (
                matched
                or pending.source.person is None
                or node.model is None
                or now >= pending.deadline
            ):
                self._arrivals.pop(key)
                self._hass.bus.async_fire(
                    HANDOFF_EVENT,
                    {
                        "from_entry_id": pending.source.entry_id,
                        "to_entry_id": key,
                        "person": node.identified if matched else None,
                        "state": "named" if matched else "unknown",
                    },
                )
