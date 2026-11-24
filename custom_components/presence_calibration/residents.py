"""Project validated, current radar observations into household room entities."""

from __future__ import annotations

import asyncio
import hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import EntityPlatform
from homeassistant.util import dt as dt_util

from .const import CONF_DEVICE_ID, DOMAIN

LAST_SEEN_SECONDS = 60.0
_SIMULTANEOUS_SECONDS = 1.5
_HEARTBEAT_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class _Sighting:
    person: str
    entry_id: str
    room_id: tuple[str, str]
    room: str
    monotonic: float
    timestamp: datetime


class ResidentRoomSensor(SensorEntity):
    """One resident's ephemeral last recognized room."""

    _attr_should_poll = False
    _attr_icon = "mdi:map-marker-account"

    def __init__(self, person: str) -> None:
        self._attr_name = f"{person} last seen room"
        identifier = hashlib.sha256(person.casefold().encode()).hexdigest()[:32]
        self._attr_unique_id = f"resident-room-{identifier}"
        self._attr_native_value = None
        self._attr_extra_state_attributes = {}
        self._published_at = -float("inf")

    @callback
    def update_room(self, sighting: _Sighting | None) -> None:
        value = sighting.room if sighting else None
        entry_id = sighting.entry_id if sighting else None
        current = self._attr_extra_state_attributes
        if (
            self._attr_native_value == value
            and current.get("room_entry_id") == entry_id
            and (
                sighting is None
                or sighting.monotonic - self._published_at < _HEARTBEAT_SECONDS
            )
        ):
            return
        self._attr_native_value = value
        self._attr_extra_state_attributes = (
            {"room_entry_id": entry_id, "last_seen": sighting.timestamp.isoformat()}
            if sighting
            else {}
        )
        self._published_at = sighting.monotonic if sighting else -float("inf")
        if self.platform and self.platform.entities.get(self.entity_id) is self:
            self.async_write_ha_state()


class ResidentRooms:
    """Maintain one native sensor per alias without restoring a previous sighting."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._platforms: dict[str, EntityPlatform] = {}
        self._entities: dict[str, tuple[str, ResidentRoomSensor]] = {}
        self._enrolled: dict[str, dict[str, str]] = {}
        self._allowed: dict[str, frozenset[str]] = {}
        self._claims: dict[str, _Sighting] = {}
        self._last_seen: dict[str, _Sighting] = {}
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._lock = asyncio.Lock()

    async def add_platform(self, entry_id: str, platform: EntityPlatform) -> None:
        async with self._lock:
            self._platforms[entry_id] = platform
            await self._sync_entities()

    async def remove_platform(self, entry_id: str) -> None:
        async with self._lock:
            self._platforms.pop(entry_id, None)
            self.invalidate(entry_id)
            await self._sync_entities()

    async def reconcile(
        self, samples: list[dict], allowed: dict[str, frozenset[str]]
    ) -> None:
        """Synchronize enrollment and forget readings that no longer pass the gate."""
        async with self._lock:
            self._enrolled = defaultdict(dict)
            for row in samples:
                if row["kind"] == "enroll":
                    self._enrolled[row["person"].casefold()].setdefault(
                        row["entry_id"], row["person"]
                    )
            self._allowed = {
                key: frozenset(person.casefold() for person in people)
                for key, people in allowed.items()
            }
            for key, claim in list(self._claims.items()):
                if not self._permitted(key, claim.person):
                    self._claims.pop(key)
            for person, last in list(self._last_seen.items()):
                if not self._permitted(last.entry_id, person):
                    self._forget(person)
            await self._sync_entities()

    async def _sync_entities(self) -> None:
        for person, (owner, sensor) in list(self._entities.items()):
            departed = person not in self._enrolled
            if not departed and owner in self._platforms:
                continue
            del self._entities[person]
            if departed:
                registry = er.async_get(self._hass)
                entity_id = registry.async_get_entity_id(
                    "sensor", DOMAIN, sensor.unique_id
                )
                if entity_id:
                    registry.async_remove(entity_id)
            if (
                sensor.platform
                and sensor.platform.entities.get(sensor.entity_id) is sensor
            ):
                await sensor.async_remove(force_remove=True)
        additions: dict[str, list[ResidentRoomSensor]] = defaultdict(list)
        for person, entries in self._enrolled.items():
            if person in self._entities:
                continue
            owners = sorted(entries.keys() & self._platforms.keys())
            if owners:
                owner = owners[0]
                sensor = ResidentRoomSensor(entries[owner])
                # Copy only this process's latest eligible reading when an owner is reloaded.
                sensor.update_room(self._last_seen.get(person))
                self._entities[person] = (owner, sensor)
                additions[owner].append(sensor)
        for owner, sensors in additions.items():
            await self._platforms[owner].async_add_entities(sensors)

    def _permitted(self, entry_id: str, person: str) -> bool:
        return person in self._allowed.get(entry_id, ())

    @callback
    def observe(self, entry: ConfigEntry, person: str) -> None:
        """Refresh a verified sighting. Two current rooms cause immediate abstention."""
        key = person.casefold()
        if not self._permitted(entry.entry_id, key):
            return
        device_id = entry.data.get(CONF_DEVICE_ID)
        device = dr.async_get(self._hass).async_get(device_id) if device_id else None
        area = (
            ar.async_get(self._hass).async_get_area(device.area_id)
            if device and device.area_id
            else None
        )
        now = self._hass.loop.time()
        sighting = _Sighting(
            key,
            entry.entry_id,
            ("area", area.id) if area else ("entry", entry.entry_id),
            area.name if area else entry.title,
            now,
            dt_util.utcnow(),
        )
        self._claims[entry.entry_id] = sighting
        if any(
            claim.person == key
            and claim.room_id != sighting.room_id
            and now - claim.monotonic <= _SIMULTANEOUS_SECONDS
            for claim in self._claims.values()
        ):
            self._forget(key)
            return
        self._last_seen[key] = sighting
        if key in self._entities:
            self._entities[key][1].update_room(sighting)
        if key not in self._timers:
            self._timers[key] = self._hass.loop.call_later(
                LAST_SEEN_SECONDS, self._expire, key
            )

    @callback
    def withdraw(self, entry_id: str) -> None:
        """The room has no current identity evidence. Keep the last valid observation."""
        self._claims.pop(entry_id, None)

    @callback
    def invalidate(self, entry_id: str) -> None:
        """Revoke observations when their source loses the validated model."""
        self.withdraw(entry_id)
        self._allowed.pop(entry_id, None)
        for person, sighting in list(self._last_seen.items()):
            if sighting.entry_id == entry_id:
                self._forget(person)

    @callback
    def _forget(self, person: str) -> None:
        self._last_seen.pop(person, None)
        if (timer := self._timers.pop(person, None)) is not None:
            timer.cancel()
        if person in self._entities:
            self._entities[person][1].update_room(None)

    @callback
    def _expire(self, person: str) -> None:
        self._timers.pop(person, None)
        sighting = self._last_seen.get(person)
        if sighting is None:
            return
        remaining = sighting.monotonic + LAST_SEEN_SECONDS - self._hass.loop.time()
        if remaining <= 0:
            self._forget(person)
        else:
            self._timers[person] = self._hass.loop.call_later(
                remaining, self._expire, person
            )
