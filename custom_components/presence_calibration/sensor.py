"""Native Home Assistant sensors for enrolled residents."""

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import (
    AddConfigEntryEntitiesCallback,
    async_get_current_platform,
)

from .extras import DATA_EXTRAS


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    _async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Register this entry as a possible owner of household room entities."""
    await hass.data[DATA_EXTRAS].residents.add_platform(
        entry.entry_id, async_get_current_platform()
    )
