"""Admin-only WebSocket API used by the calibration panel."""

from __future__ import annotations

from typing import Any

import probatio
import segno
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback

from .const import CONF_DEVICE_ID, DOMAIN
from .device import CalibrationError
from .extras import DATA_EXTRAS
from .floorplan import DATA_FLOORPLANS, FloorplanError
from .roomplan import RoomPlanError, normalize_roomplan, valid_placement_entry_id
from .runtime import CalibrationRuntime

_REQUEST_ACTIONS = {"open", "profile", "draft", "save", "undo", "close"}


@callback
def async_register_api(hass: HomeAssistant) -> None:
    """Register the calibration panel's commands."""
    websocket_api.async_register_command(hass, async_status)
    websocket_api.async_register_command(hass, async_request)
    websocket_api.async_register_command(hass, async_subscribe)
    websocket_api.async_register_command(hass, async_floorplans_list)
    websocket_api.async_register_command(hass, async_floorplans_save)
    websocket_api.async_register_command(hass, async_floorplans_delete)
    websocket_api.async_register_command(hass, async_floorplans_import_roomplan)
    websocket_api.async_register_command(hass, async_floorplans_placement_label)
    websocket_api.async_register_command(hass, async_display)
    websocket_api.async_register_command(hass, async_training)


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
        if msg["action"] in {"open", "profile", "save", "undo"}:
            hass.data[DATA_EXTRAS].schedule_setup_check(msg["entry_id"])


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


@websocket_api.require_admin
@websocket_api.websocket_command({"type": f"{DOMAIN}/floorplans/list"})
@websocket_api.async_response
async def async_floorplans_list(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """List stored floor plans."""
    try:
        plans = await hass.data[DATA_FLOORPLANS].async_list()
    except FloorplanError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], {"plans": plans})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/floorplans/save",
        probatio.Required("plan"): dict,
        probatio.Required("expected_revision"): int,
    }
)
@websocket_api.async_response
async def async_floorplans_save(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Commit an edit against the revision the panel started from."""
    try:
        plan = await hass.data[DATA_FLOORPLANS].async_save(
            msg["plan"], msg["expected_revision"]
        )
    except FloorplanError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], plan)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/floorplans/delete",
        probatio.Required("plan_id"): str,
        probatio.Required("expected_revision"): int,
    }
)
@websocket_api.async_response
async def async_floorplans_delete(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Remove the exact saved revision."""
    try:
        await hass.data[DATA_FLOORPLANS].async_delete(
            msg["plan_id"], msg["expected_revision"]
        )
    except FloorplanError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], {})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/floorplans/import_roomplan",
        probatio.Required("capture"): dict,
    }
)
@websocket_api.async_response
async def async_floorplans_import_roomplan(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Convert an offline RoomPlan capture before the user edits or saves it."""
    try:
        result = await hass.async_add_executor_job(normalize_roomplan, msg["capture"])
    except RoomPlanError:
        connection.send_error(msg["id"], "invalid_roomplan", "invalid_roomplan")
    else:
        connection.send_result(msg["id"], result)


def _placement_label_matrix(entry_id: str) -> list[str]:
    qr = segno.make_qr(f"presenceDaddy:placement:v1:{entry_id}", error="M")
    return ["".join("1" if module else "0" for module in row) for row in qr.matrix]


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/floorplans/placement_label",
        probatio.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def async_floorplans_placement_label(
    hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
) -> None:
    """Generate a local QR label for a configured presence sensor."""
    entry_id = msg["entry_id"]
    entry = (
        hass.config_entries.async_get_entry(entry_id)
        if valid_placement_entry_id(entry_id)
        else None
    )
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "entry_unavailable", "entry_unavailable")
        return
    matrix = await hass.async_add_executor_job(_placement_label_matrix, entry_id)
    connection.send_result(msg["id"], {"matrix": matrix})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/display",
        probatio.Required("entry_id"): str,
        probatio.Required("action"): probatio.In(
            {"status", "set", "feed", "close_eyes", "complete_setup"}
        ),
        probatio.Optional("payload"): dict,
    }
)
@websocket_api.async_response
async def async_display(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Manage display settings through Home Assistant's pinned device client."""
    try:
        result = await hass.data[DATA_EXTRAS].display(msg["entry_id"], msg["action"], msg.get("payload", {}))
    except CalibrationError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/training",
        probatio.Required("entry_id"): str,
        probatio.Required("action"): probatio.In({"status", "start", "end", "cancel", "enable", "forget", "link", "unlink", "sd_import"}),
        probatio.Optional("payload"): dict,
    }
)
@websocket_api.async_response
async def async_training(hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]) -> None:
    """Keep label entry and opt-in motion features local to the HA administrator."""
    try:
        result = await hass.data[DATA_EXTRAS].train(connection, msg["entry_id"], msg["action"], msg.get("payload", {}))
    except CalibrationError as error:
        connection.send_error(msg["id"], error.code, error.code)
    else:
        connection.send_result(msg["id"], result)
