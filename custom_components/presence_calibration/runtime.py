"""Keep device session ownership and preview polling on the HA backend."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, PREVIEW_INTERVAL
from .device import CalibrationClient, CalibrationError
from .protocol import preview_report, profile_envelope, session_token, validate_payload

_SESSION_ACTIONS = {
    "draft": ("PUT", "/v1/draft"),
    "save": ("PUT", "/v1/profile"),
    "undo": ("POST", "/v1/undo"),
}
_MAX_PREVIEW_RETRY_DELAY = 8


@dataclass(slots=True)
class _Session:
    connection: ActiveConnection
    token: str | None = None
    disconnected: bool = False
    preview_id: int | None = None
    preview_task: asyncio.Task[None] | None = None


class CalibrationRuntime:
    """Serialize operations and allow one owner per configured sensor."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, client: CalibrationClient
    ) -> None:
        self._hass = hass
        self._entry = entry
        self._client = client
        self._owner_key = (DOMAIN, entry.entry_id)
        self._session: _Session | None = None
        self._lock = asyncio.Lock()
        self._stopping = False

    async def request(
        self, connection: ActiveConnection, action: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Run a calibration operation without sending credentials to the panel."""
        body = validate_payload(action, payload)
        if action == "open":
            return await self._open_when_available(connection)
        async with self._lock:
            if self._stopping:
                raise CalibrationError("device_unavailable")
            if action == "profile":
                return profile_envelope(
                    await self._client.request("GET", "/v1/profile")
                )
            if action == "close" and self._session is None:
                return {}
            current = self._require_owner(connection)
            if action == "close":
                await self._release(current, report_error=True)
                return {}
            method, path = _SESSION_ACTIONS[action]
            try:
                result = await self._client.request(
                    method, path, session=current.token, body=body
                )
            except CalibrationError as error:
                if error.status == 410:
                    self._detach(current)
                raise
            if action == "draft":
                return {}
            return profile_envelope(result)

    async def _open_when_available(
        self, connection: ActiveConnection
    ) -> dict[str, Any]:
        # The requester can disconnect while a previous operation holds the lock.
        pending_key = object()
        connection_closed = False

        def disconnected() -> None:
            nonlocal connection_closed
            connection_closed = True

        connection.subscriptions[pending_key] = disconnected
        try:
            async with self._lock:
                if connection_closed or self._stopping:
                    raise CalibrationError("session_closed")
                return await self._open(connection)
        finally:
            connection.subscriptions.pop(pending_key, None)

    async def _open(self, connection: ActiveConnection) -> dict[str, Any]:
        if self._session is not None:
            self._require_owner(connection)
            return profile_envelope(await self._client.request("GET", "/v1/profile"))

        current = _Session(connection)
        self._session = current

        def disconnected() -> None:
            current.disconnected = True
            self._entry.async_create_background_task(
                self._hass,
                self._disconnect(current),
                "presence-calibration-disconnect",
                eager_start=False,
            )

        connection.subscriptions[self._owner_key] = disconnected
        try:
            result = await self._client.request("POST", "/v1/session")
            current.token = session_token(result)
            envelope = profile_envelope(result)
        except BaseException:
            await self._release(current)
            raise
        if current.disconnected or self._stopping:
            await self._release(current)
            raise CalibrationError("session_closed")
        return envelope

    @callback
    def _require_owner(self, connection: ActiveConnection) -> _Session:
        if self._stopping:
            raise CalibrationError("device_unavailable")
        current = self._session
        if current is None:
            raise CalibrationError("session_required")
        if current.connection is not connection:
            raise CalibrationError("session_busy")
        if current.disconnected or current.token is None:
            raise CalibrationError("session_closed")
        return current

    @callback
    def _detach(self, current: _Session) -> None:
        if self._session is not current:
            return
        self._session = None
        current.connection.subscriptions.pop(self._owner_key, None)
        if current.preview_id is not None:
            current.connection.subscriptions.pop(current.preview_id, None)
        if (
            current.preview_task is not None
            and current.preview_task is not asyncio.current_task()
        ):
            current.preview_task.cancel()

    async def _release(self, current: _Session, *, report_error: bool = False) -> None:
        if self._session is not current:
            return
        self._detach(current)
        if current.token is None:
            return
        try:
            await self._client.request("DELETE", "/v1/session", session=current.token)
        except CalibrationError as error:
            if report_error and error.status != 410:
                raise

    async def _disconnect(self, current: _Session) -> None:
        async with self._lock:
            await self._release(current)

    @callback
    def subscribe(self, connection: ActiveConnection, message_id: int) -> None:
        """Poll previews for the session owner, with one stream per session."""
        current = self._require_owner(connection)
        if current.preview_task is not None and not current.preview_task.done():
            raise CalibrationError("already_subscribed")
        task = self._entry.async_create_background_task(
            self._hass,
            self._preview(current, message_id),
            "presence-calibration-preview",
            eager_start=False,
        )
        current.preview_id = message_id
        current.preview_task = task
        connection.subscriptions[message_id] = task.cancel
        connection.send_result(message_id)

    async def _preview(self, current: _Session, message_id: int) -> None:
        delay = PREVIEW_INTERVAL
        last_error: str | None = None
        loop = asyncio.get_running_loop()
        try:
            while (
                self._session is current
                and not current.disconnected
                and not self._stopping
            ):
                started = loop.time()
                async with self._lock:
                    if self._session is not current or current.disconnected:
                        return
                    try:
                        response = await self._client.request(
                            "GET", "/v1/preview", session=current.token
                        )
                        preview = preview_report(response)
                    except CalibrationError as error:
                        if not current.disconnected and error.code != last_error:
                            current.connection.send_event(
                                message_id, {"error": error.code}
                            )
                        if error.status == 410:
                            self._detach(current)
                            return
                        delay = min(delay * 2, _MAX_PREVIEW_RETRY_DELAY)
                        last_error = error.code
                    else:
                        if not current.disconnected:
                            current.connection.send_event(message_id, preview)
                        delay = PREVIEW_INTERVAL
                        last_error = None
                await asyncio.sleep(
                    delay
                    if last_error is not None
                    else max(0, started + delay - loop.time())
                )
        finally:
            if current.preview_id == message_id:
                current.connection.subscriptions.pop(message_id, None)
                current.preview_id = None
                current.preview_task = None

    async def shutdown(self) -> None:
        """Stop preview polling and release the device session during unload."""
        self._stopping = True
        current = self._session
        if current is not None and current.preview_task is not None:
            current.preview_task.cancel()
        async with self._lock:
            if self._session is not None:
                await self._release(self._session)
