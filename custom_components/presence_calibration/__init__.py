"""Home Assistant integration for the Thread presence sensor's calibration panel."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.config_validation import config_entry_only_config_schema
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_CERTIFICATE_SHA256,
    CONF_DEVICE_ID,
    CONF_SETUP_CODE,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_MODULE_URL,
    PANEL_PATH,
)
from .device import CalibrationClient
from .extras import DATA_EXTRAS, PresenceExtras
from .floorplan import DATA_FLOORPLANS, FloorplanStore
from .runtime import CalibrationRuntime
from .websocket import async_register_api

CONFIG_SCHEMA = config_entry_only_config_schema(DOMAIN)
PLATFORMS = (Platform.SENSOR,)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the panel asset and API once for this integration."""
    component_path = Path(__file__).parent
    asset_root = PANEL_MODULE_URL.rsplit("/", 1)[0]
    assets = (
        "panel.js",
        "floorplan-panel.js",
        "floorplan-geometry.js",
        "floorplan-wifi.js",
        "device-controls.js",
    )
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                f"{asset_root}/{filename}", str(component_path / filename), False
            )
            for filename in assets
        ]
    )
    await async_register_panel(
        hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title="Presence Calibration",
        sidebar_icon="mdi:radar",
        module_url=PANEL_MODULE_URL,
        require_admin=True,
        config_panel_domain=DOMAIN,
    )
    hass.data[DATA_FLOORPLANS] = FloorplanStore(hass)
    hass.data[DATA_EXTRAS] = PresenceExtras(hass)
    async_register_api(hass)
    return True


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry[CalibrationRuntime]
) -> bool:
    """Create a client per sensor and resolve its live Matter address on demand."""
    client = CalibrationClient(
        hass,
        async_get_clientsession(hass),
        entry.data[CONF_DEVICE_ID],
        entry.data[CONF_CERTIFICATE_SHA256],
        entry.data[CONF_SETUP_CODE],
    )
    entry.runtime_data = CalibrationRuntime(hass, entry, client)
    extras = hass.data[DATA_EXTRAS]
    await extras.add(entry, client)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    extras.schedule_setup_check(entry.entry_id)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ConfigEntry[CalibrationRuntime]
) -> bool:
    """Release the live calibration session and cancel preview polling."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    await hass.data[DATA_EXTRAS].remove(entry.entry_id)
    await entry.runtime_data.shutdown()
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Remove saved selections, doorway links and local training for this device."""
    await hass.data[DATA_EXTRAS].remove(entry.entry_id, delete=True)
