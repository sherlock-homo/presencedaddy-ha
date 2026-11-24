"""Resolve the commissioned Matter device and call its pinned HTTPS API."""

from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from ipaddress import IPv6Address, IPv6Network
from typing import Any

import aiohttp
from homeassistant.components.matter.helpers import (
    get_matter,
    get_node_from_device_entry,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from matter_server.client import MatterClient
from matter_server.client.exceptions import NotConnected
from matter_server.client.models.node import MatterNode
from matter_server.common.errors import MatterError
from yarl import URL

from .const import (
    FINGERPRINT_PATH,
    HTTPS_PORT,
    MATTER_PRODUCT_IDS,
    MATTER_VENDOR_ID,
    PROTOCOL_PATH,
    PROTOCOL_VERSION,
)

_MATTER_TIMEOUT = 10
_REQUEST_TIMEOUT = 18
# The first TLS handshake on the C6 takes several seconds over Thread.
# Polling reuses the pinned connection and stays on the shorter read timeout.
_HTTP_TIMEOUT = aiohttp.ClientTimeout(total=9, connect=6, sock_read=4)
_MAX_RESPONSE_BYTES = 16_384
_MAX_ADDRESSES = 4
_ULA = IPv6Network("fc00::/7")
_GLOBAL_UNICAST = IPv6Network("2000::/3")
_CODE = re.compile(r"[A-Z2-7]{26}")
_FINGERPRINT = re.compile(r"[0-9a-f]{64}")
_ERROR = re.compile(r"[a-z][a-z0-9_]{0,63}")


class CalibrationError(Exception):
    """An error whose code and message may be returned to an HA administrator."""

    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@callback
def _matter_client(hass: HomeAssistant) -> MatterClient:
    if not hass.config_entries.async_loaded_entries("matter"):
        raise CalibrationError("matter_unavailable")
    client = get_matter(hass).matter_client
    if client.server_info is None:
        raise CalibrationError("matter_unavailable")
    return client


@callback
def _matching_node(hass: HomeAssistant, device: dr.DeviceEntry) -> MatterNode | None:
    if not any(
        domain == "matter" and identifier.endswith("-MatterNodeDevice")
        for domain, identifier in device.identifiers
    ):
        return None
    node = get_node_from_device_entry(hass, device)
    info = node.device_info if node is not None else None
    if (
        info is not None
        and info.vendorID == MATTER_VENDOR_ID
        and info.productID in MATTER_PRODUCT_IDS
    ):
        return node
    return None


@callback
def eligible_devices(hass: HomeAssistant) -> dict[str, str]:
    """Return present registry devices that match the Matter VID and PID."""
    _matter_client(hass)
    registry = dr.async_get(hass)
    areas = ar.async_get(hass)
    candidates: list[tuple[str, str, int]] = []
    for device in registry.devices.values():
        node = _matching_node(hass, device)
        if node is None:
            continue
        label = device.name_by_user or device.name or "Presence Sensor"
        if (
            device.area_id
            and (area := areas.async_get_area(device.area_id)) is not None
        ):
            label = f"{label} ({area.name})"
        candidates.append((device.id, label, node.node_id))
    labels = Counter(label.casefold() for _, label, _ in candidates)
    return {
        device_id: f"{label} (Matter node {node_id})"
        if labels[label.casefold()] > 1
        else label
        for device_id, label, node_id in candidates
    }


@callback
def _resolve_node(hass: HomeAssistant, device_id: str) -> tuple[MatterClient, int]:
    client = _matter_client(hass)
    device = dr.async_get(hass).async_get(device_id, include_child_devices=False)
    if device is None:
        raise CalibrationError("unsupported_device")
    node = _matching_node(hass, device)
    if node is None:
        raise CalibrationError("unsupported_device")
    return client, node.node_id


def normalize_setup_code(value: str) -> str:
    """Normalize and validate the owner code printed by the device."""
    value = value.strip().upper()
    if _CODE.fullmatch(value) is None:
        raise CalibrationError("invalid_code")
    return value


async def read_fingerprint(hass: HomeAssistant, device_id: str) -> str:
    """Read the protocol and certificate pin over the commissioned Matter fabric."""
    client, node_id = _resolve_node(hass, device_id)
    try:
        async with asyncio.timeout(_MATTER_TIMEOUT):
            attributes = await client.read_attribute(
                node_id, [PROTOCOL_PATH, FINGERPRINT_PATH]
            )
    except (MatterError, NotConnected, OSError, TimeoutError):
        raise CalibrationError("matter_unavailable") from None
    version = attributes.get(PROTOCOL_PATH)
    fingerprint = attributes.get(FINGERPRINT_PATH)
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise CalibrationError("unsupported_firmware")
    if not isinstance(fingerprint, str) or _FINGERPRINT.fullmatch(fingerprint) is None:
        raise CalibrationError("invalid_fingerprint")
    return fingerprint


def routed_addresses(addresses: list[str]) -> list[IPv6Address]:
    """Keep only numeric IPv6 candidates within routable unicast ranges."""
    result: list[IPv6Address] = []
    for value in addresses:
        if not isinstance(value, str) or "%" in value:
            continue
        try:
            address = IPv6Address(value)
        except ValueError:
            continue
        if (address in _ULA or address in _GLOBAL_UNICAST) and address not in result:
            result.append(address)
    return result[:_MAX_ADDRESSES]


async def _read_json(response: aiohttp.ClientResponse) -> dict[str, Any]:
    content = bytearray()
    async for chunk in response.content.iter_chunked(1024):
        content.extend(chunk)
        if len(content) > _MAX_RESPONSE_BYTES:
            raise CalibrationError("invalid_response")
    try:
        value = json.loads(content)
    except (ValueError, RecursionError):
        raise CalibrationError("invalid_response") from None
    if not isinstance(value, dict):
        raise CalibrationError("invalid_response")
    return value


async def _do_not_replay_write(
    request: aiohttp.ClientRequest, handler: aiohttp.ClientHandlerType
) -> aiohttp.ClientResponse:
    """Keep aiohttp from silently replaying an interrupted PUT or DELETE."""
    try:
        return await handler(request)
    except aiohttp.ClientConnectorError:
        raise
    except (aiohttp.ClientOSError, aiohttp.ServerDisconnectedError):
        raise CalibrationError("request_uncertain") from None


class CalibrationClient:
    """Use the commissioned node's certificate pin and routed IPv6 addresses."""

    def __init__(
        self,
        hass: HomeAssistant,
        http: aiohttp.ClientSession,
        device_id: str,
        fingerprint: str,
        setup_code: str,
    ) -> None:
        self._hass = hass
        self._http = http
        self._device_id = device_id
        self._fingerprint = aiohttp.Fingerprint(bytes.fromhex(fingerprint))
        self._authorization = f"Bearer {setup_code}"
        self._last_address: IPv6Address | None = None
        self._request_lock = asyncio.Lock()

    async def _addresses(self, prefer_cache: bool) -> list[IPv6Address]:
        client, node_id = _resolve_node(self._hass, self._device_id)
        try:
            async with asyncio.timeout(_MATTER_TIMEOUT):
                addresses = await client.get_node_ip_addresses(
                    node_id, prefer_cache=prefer_cache, scoped=False
                )
        except (MatterError, NotConnected, OSError, TimeoutError):
            raise CalibrationError("matter_unavailable") from None
        return routed_addresses(addresses)

    async def request(
        self,
        method: str,
        path: str,
        *,
        session: str | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Send one request. Retry mutations only when a connection never opened."""
        started = False
        try:
            async with asyncio.timeout(_REQUEST_TIMEOUT):
                # The device has room for a calibration connection and its peer,
                # not parallel sockets for preview, display, and live tracking.
                async with self._request_lock:
                    started = True
                    return await self._request(method, path, session=session, body=body)
        except TimeoutError:
            if started:
                self._last_address = None
            code = (
                "request_uncertain"
                if started and method != "GET"
                else "device_unavailable"
            )
            raise CalibrationError(code) from None
        except CalibrationError as error:
            if error.code == "request_uncertain":
                self._last_address = None
            raise

    async def _request(
        self,
        method: str,
        path: str,
        *,
        session: str | None,
        body: dict[str, Any] | None,
    ) -> dict[str, Any]:
        headers = {
            "Authorization": self._authorization,
            "Accept": "application/json",
            "Accept-Encoding": "identity",
        }
        if session is not None:
            headers["X-Calibration-Session"] = session

        attempted: set[IPv6Address] = set()
        pin_failed = False
        for prefer_cache in (True, False):
            if prefer_cache and self._last_address is not None:
                addresses = [self._last_address]
            else:
                try:
                    addresses = await self._addresses(prefer_cache)
                except CalibrationError:
                    if not pin_failed:
                        raise
                    raise CalibrationError("certificate_mismatch") from None
            for address in addresses:
                if address in attempted:
                    continue
                attempted.add(address)
                url = URL.build(
                    scheme="https", host=str(address), port=HTTPS_PORT, path=path
                )
                try:
                    async with self._http.request(
                        method,
                        url,
                        ssl=self._fingerprint,
                        headers=headers,
                        json=body,
                        allow_redirects=False,
                        auto_decompress=False,
                        timeout=_HTTP_TIMEOUT,
                        middlewares=None
                        if method == "GET"
                        else (_do_not_replay_write,),
                    ) as response:
                        self._last_address = address
                        status = response.status
                        if status == 401:
                            raise CalibrationError("invalid_code", status)
                        if status == 410:
                            raise CalibrationError("session_expired", status)
                        if status == 503:
                            raise CalibrationError("device_unavailable", status)
                        if status in {400, 409}:
                            value = await _read_json(response)
                            code = value.get("error")
                            if (
                                not isinstance(code, str)
                                or _ERROR.fullmatch(code) is None
                            ):
                                code = (
                                    "conflict" if status == 409 else "invalid_request"
                                )
                            raise CalibrationError(code, status)
                        if status != 200:
                            raise CalibrationError("invalid_response", status)
                        return await _read_json(response)
                except aiohttp.ServerFingerprintMismatch:
                    pin_failed = True
                except aiohttp.ClientConnectorError:
                    pass
                except (aiohttp.ClientError, TimeoutError):
                    if method != "GET":
                        self._last_address = None
                        raise CalibrationError("request_uncertain") from None
                self._last_address = None

        if pin_failed:
            raise CalibrationError("certificate_mismatch")
        if not attempted:
            raise CalibrationError("no_routed_address")
        raise CalibrationError("device_unavailable")
