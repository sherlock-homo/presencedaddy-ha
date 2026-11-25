"""Exercise discovery and subsequent lookups with a mixed HA device registry."""

import unittest
from tempfile import TemporaryDirectory
from types import MappingProxyType, SimpleNamespace
from unittest.mock import patch

from homeassistant import loader
from homeassistant.components.matter.helpers import get_node_device_identifier
from homeassistant.config_entries import ConfigEntries, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import frame

from custom_components.presence_calibration import device


class DeviceDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_supported_roots_on_the_active_fabric_are_offered(self):
        with TemporaryDirectory() as directory:
            hass = HomeAssistant(directory)
            hass.config_entries = ConfigEntries(hass, {})
            await hass.config_entries.async_initialize()
            loader.async_setup(hass)
            frame.async_setup(hass)
            dr.async_setup(hass)
            await dr.async_load(hass, load_empty=True)
            await ar.async_load(hass, load_empty=True)
            entry = ConfigEntry(
                version=1,
                minor_version=2,
                domain="matter",
                title="Matter",
                data={},
                options={},
                source="user",
                unique_id=None,
                subentries_data=None,
                discovery_keys=MappingProxyType({}),
            )
            with patch.object(ConfigEntries, "async_setup", return_value=True):
                await hass.config_entries.async_add(entry)

            registry = dr.async_get(hass)
            fabric = SimpleNamespace(compressed_fabric_id=18)
            supported = SimpleNamespace(
                node_id=3,
                device_info=SimpleNamespace(vendorID=0xFFF1, productID=0x8003),
            )
            unsupported = SimpleNamespace(
                node_id=4,
                device_info=SimpleNamespace(vendorID=0xFFF1, productID=0x9999),
            )
            client = SimpleNamespace(
                server_info=fabric, get_nodes=lambda: (supported, unsupported)
            )
            adapter = SimpleNamespace(config_entry=entry, matter_client=client)

            def register(name, identifiers):
                return registry.async_get_or_create(
                    config_entry_id=entry.entry_id, name=name, identifiers=identifiers
                )

            unrelated = register("Other", {("other", "bridge", "switch")})
            root_id = get_node_device_identifier(fabric, supported.node_id)
            root = register("Radar", {root_id, ("other", "network", "module")})
            endpoint = register(
                "Endpoint", {("matter", root_id[1].replace("MatterNodeDevice", "1"))}
            )
            wrong = register(
                "Wrong model", {get_node_device_identifier(fabric, unsupported.node_id)}
            )

            with (
                patch.object(
                    ConfigEntries, "async_loaded_entries", return_value=[entry]
                ),
                patch.object(device, "get_matter", return_value=adapter),
            ):
                self.assertEqual(device.eligible_devices(hass), {root.id: "Radar"})
                self.assertEqual(device._resolve_node(hass, root.id), (client, 3))
                for other in (unrelated, endpoint, wrong):
                    with (
                        self.subTest(other=other.name),
                        self.assertRaisesRegex(
                            device.CalibrationError, "unsupported_device"
                        ),
                    ):
                        device._resolve_node(hass, other.id)
                registry.async_remove_device(root.id)
                self.assertEqual(device.eligible_devices(hass), {})
