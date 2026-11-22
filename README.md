# presenceDaddy for Home Assistant

Presence Calibration is the Home Assistant app for presenceDaddy. Use it to see live radar detections, draw room, seating, entry, and ignore areas, then preview, save, or undo a configuration on the sensor.

## Install

[![Open in Home Assistant](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/marketplace_repository/?owner=sherlock-homo&repository=presencedaddy-ha&category=integration)

Use Home Assistant Core 2026.11.1 or later and a presenceDaddy sensor with calibration firmware 0.1.4 or later. Commission the sensor into Home Assistant and have its private calibration code ready.

Use the button above to add this repository to Marketplace and install **Presence Calibration**. You can also add the repository from **Settings → Marketplace → Add from link**. Under **Settings → Devices & services**, add Presence Calibration, select your sensor, and enter its calibration code. Open the Presence Calibration panel to start the room walkthrough. [Home Assistant Marketplace guide](https://www.home-assistant.io/integrations/marketplace/#custom-repositories)

The [installation guide](INSTALL.md) covers manual installation, the room walkthrough, and how to issue a replacement code.

## Release

The integration lives in `custom_components/presence_calibration/`. `hacs.json` declares the Home Assistant version supported by this release. Use the integration version in `manifest.json` for the corresponding Git tag. The sensor firmware is built and released in the companion firmware project.
