"""Admin-only WebSocket API used by the calibration panel."""

from __future__ import annotations

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback

from .const import CONF_DEVICE_ID, DOMAIN
from .device import CalibrationError
from .runtime import CalibrationRuntime

_REQUEST_ACTIONS = {"open", "profile", "draft", "save", "undo", "close"}


@callback
def async_register_api(hass: HomeAssistant) -> None:
    """Register the calibration panel's commands."""
    websocket_api.async_register_command(hass, async_status)
    websocket_api.async_register_command(hass, async_request)
    websocket_api.async_register_command(hass, async_subscribe)


@callback
def _runtime(hass: HomeAssistant, entry_id: str) -> CalibrationRuntime:
    entry = hass.config_entries.async_get_entry(entry_id)
    if (
        entry is None
        or entry.domain != DOMAIN
        or entry.state is not ConfigEntryState.LOADED
    ):
        raise CalibrationError("entry_unavailable")
    return entry.runtime_data


@websocket_api.require_admin
@websocket_api.websocket_command({"type": f"{DOMAIN}/status"})
@callback
def async_status(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the current configured devices for the selector."""
    entries = [
        {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "device_id": entry.data[CONF_DEVICE_ID],
        }
        for entry in hass.config_entries.async_entries(DOMAIN)
    ]
    connection.send_result(msg["id"], {"entries": entries})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/request",
        probatio.Required("entry_id"): str,
        probatio.Required("action"): probatio.In(_REQUEST_ACTIONS),
        probatio.Optional("payload"): dict,
    }
)
@websocket_api.async_response
async def async_request(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Validate and dispatch a single calibration operation."""
    try:
        result = await _runtime(hass, msg["entry_id"]).request(
            connection, msg["action"], msg.get("payload", {})
        )
    except CalibrationError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/subscribe",
        probatio.Required("entry_id"): str,
    }
)
@callback
def async_subscribe(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return preview updates from the owned device session."""
    try:
        _runtime(hass, msg["entry_id"]).subscribe(connection, msg["id"])
    except CalibrationError as error:
        connection.send_error(msg["id"], error.code, error.code)
