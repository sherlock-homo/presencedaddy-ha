# presenceDaddy for Home Assistant

Presence Calibration is the Home Assistant app for presenceDaddy. Use it to see live radar detections, draw room, seating, entry, and ignore areas, then preview, save, or undo a configuration on the sensor.

## Install

[![Open in Home Assistant](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/marketplace_repository/?owner=sherlock-homo&repository=presencedaddy-ha&category=integration)

Use Home Assistant Core 2026.11.1 or later and a presenceDaddy sensor with calibration firmware 0.1.4 or later. Commission the sensor into Home Assistant and have its private calibration code ready.

Use the button above to add this repository to Marketplace and install **Presence Calibration**. You can also add the repository from **Settings → Marketplace → Add from link**. Under **Settings → Devices & services**, add Presence Calibration, select your sensor, and enter its calibration code. Open the Presence Calibration panel to start the room walkthrough. [Home Assistant Marketplace guide](https://www.home-assistant.io/integrations/marketplace/#custom-repositories)

For an installation that still uses HACS, add [the public GitHub repository](https://github.com/sherlock-homo/presencedaddy-ha) as a custom **Integration**. [Open in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=sherlock-homo&repository=presencedaddy-ha&category=integration)

The [installation guide](INSTALL.md) covers manual installation, the room walkthrough, and how to issue a replacement code.

## Floor plans

Draw rooms, import Apple RoomPlan scans, and arrange furniture and named areas. Align each sensor with walked anchors to see radar coverage and live detections on the shared plan. Pin Wi-Fi survey readings to compare signal strength across the floor. [Floor plan guide](FLOOR_PLANS.md)

## Device tools

In **Device tools**, select the sensor and save its LCD options. Enable the Home Assistant feed to set the local date and time. The LCD can cycle through up to four selected entity values, including temperature and humidity with units. Compatible firmware provides the LCD and live radar options.

On Waveshare LCD firmware 0.3.0 or later, the integration finishes setup automatically after it loads. **Device tools** lets you retry setup completion, choose the LCD orientation, or switch between Eyes and Dashboard. When moving the magnetic enclosure between horizontal and vertical, use the indexed carrier to keep the LD2450 upright. Set the matching LCD orientation and revisit calibration if the sensor’s position or aim changes.

For household training, use a name or alias and get each participant’s agreement before starting. Record one person walking at a time and vary the routes, speeds, and footwear across days. For an ambiguous challenge, record people crossing or overlapping. Start and end a short live session or select a segment of an SD recording. Home Assistant saves derived motion features and the segment boundaries in private storage. Use **Delete training data** to remove samples for a resident or sensor. Any raw SD recording remains on the card until you remove it.

An LD2450 tracks coarse motion. Similar movement and occlusion can make different people indistinguishable. Named automation events require at least two enrollment days and two separate validation days per person, at least three validation sessions and ten usable windows per person, 95% named precision, 70% moving-track coverage, and zero false names in 50 guest and 50 ambiguous trials. Enable names separately for each sensor after it passes. Training changes disable names until you enable them again.

To watch a doorway handoff, configure an Entry zone on both sensors and link them in Device tools. The `presence_daddy_track` event carries `entry_id`, `state`, and `person`. The `presence_daddy_handoff` event carries `from_entry_id`, `to_entry_id`, `state`, and `person`. Filter on `state: named` and an exact `person` for a resident-specific automation. An unknown event has a null `person`. Named handoffs require both sensors to identify the same resident independently.

Each enrolled alias also has a **last seen room** sensor. Find it in Home Assistant's entity list. It reports the sensor's assigned Home Assistant area, or its name if unassigned, with `last_seen` and `room_entry_id` attributes. The state expires 60 seconds after the last validated observation. Simultaneous claims in different rooms clear it to unknown, and Home Assistant starts the readout at unknown after restart. Read `unknown` as missing identity evidence. Home Assistant permissions and Recorder settings control access and history for these entities.

## Release

The integration lives in `custom_components/presence_calibration/`. `hacs.json` declares the Home Assistant version supported by this release. Use the integration version in `manifest.json` for the corresponding Git tag. The sensor firmware is built and released in the companion firmware project.
