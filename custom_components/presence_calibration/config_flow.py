"""Pair a Home Assistant calibration entry with an existing Matter device."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import (
    CONF_CERTIFICATE_SHA256,
    CONF_DEVICE_ID,
    CONF_SETUP_CODE,
    DOMAIN,
)
from .device import (
    CalibrationClient,
    CalibrationError,
    eligible_devices,
    normalize_setup_code,
    read_fingerprint,
)
from .protocol import profile_envelope

_SETUP_ERRORS = {
    "certificate_mismatch",
    "device_unavailable",
    "invalid_code",
    "invalid_fingerprint",
    "invalid_response",
    "matter_unavailable",
    "no_routed_address",
    "unsupported_device",
    "unsupported_firmware",
}


class PresenceCalibrationConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask an administrator for a device and authenticate its HTTPS service."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._async_pair("user", user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._async_pair("reconfigure", user_input)

    async def _async_pair(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        try:
            devices = eligible_devices(self.hass)
        except CalibrationError:
            return self.async_abort(reason="matter_unavailable")
        entry = self._get_reconfigure_entry() if step_id == "reconfigure" else None
        device_id = entry.data[CONF_DEVICE_ID] if entry is not None else None
        if not devices or (entry is not None and device_id not in devices):
            return self.async_abort(reason="no_devices")

        errors: dict[str, str] = {}
        if user_input is not None:
            if entry is None:
                device_id = user_input[CONF_DEVICE_ID]
                await self.async_set_unique_id(device_id)
                self._abort_if_unique_id_configured()
            assert device_id is not None
            try:
                setup_code = normalize_setup_code(user_input[CONF_SETUP_CODE])
                fingerprint = await read_fingerprint(self.hass, device_id)
                client = CalibrationClient(
                    self.hass,
                    async_get_clientsession(self.hass),
                    device_id,
                    fingerprint,
                    setup_code,
                )
                profile_envelope(await client.request("GET", "/v1/profile"))
            except CalibrationError as error:
                key = CONF_SETUP_CODE if error.code == "invalid_code" else "base"
                errors[key] = (
                    error.code if error.code in _SETUP_ERRORS else "cannot_connect"
                )
            else:
                data = {
                    CONF_DEVICE_ID: device_id,
                    CONF_CERTIFICATE_SHA256: fingerprint,
                    CONF_SETUP_CODE: setup_code,
                }
                if entry is not None:
                    return self.async_update_reload_and_abort(entry, data_updates=data)
                return self.async_create_entry(title=devices[device_id], data=data)

        fields: dict[Any, Any] = {}
        if entry is None:
            fields[vol.Required(CONF_DEVICE_ID)] = vol.In(devices)
        fields[vol.Required(CONF_SETUP_CODE)] = TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        )
        return self.async_show_form(
            step_id=step_id, data_schema=vol.Schema(fields), errors=errors
        )
