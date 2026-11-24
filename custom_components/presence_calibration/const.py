"""Constants for Presence Calibration."""

DOMAIN = "presence_calibration"
CONF_CERTIFICATE_SHA256 = "certificate_sha256"
CONF_DEVICE_ID = "device_id"
CONF_SETUP_CODE = "setup_code"

MATTER_VENDOR_ID = 0xFFF1
MATTER_PRODUCT_ID = 0x8002
MATTER_PRODUCT_IDS = frozenset({MATTER_PRODUCT_ID, 0x8003})
TRUST_CLUSTER_ID = 0xFFF1FC00
PROTOCOL_PATH = f"1/{TRUST_CLUSTER_ID}/0"
FINGERPRINT_PATH = f"1/{TRUST_CLUSTER_ID}/1"
PROTOCOL_VERSION = 1
HTTPS_PORT = 8443
PREVIEW_INTERVAL = 0.5

PANEL_PATH = "presence-calibration"
PANEL_MODULE_URL = "/presence-calibration-static/panel.js"
PANEL_ELEMENT = "presence-calibration-panel"
