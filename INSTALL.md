# Install Presence Calibration in Home Assistant

You need Home Assistant admin access and a presence sensor already commissioned into that Home Assistant instance. The sensor needs calibration firmware 0.1.4 or later and its private calibration code. The code is on the setup card that came with the sensor. The Matter pairing QR code is separate.

The integration targets Home Assistant Core 2026.11.1 with the stock Matter Server 9.3.0 app. Home Assistant needs an IPv6 route to the sensor through your existing Thread border router. Your phone connects to Home Assistant as usual.

## Install from a Marketplace repository

On Home Assistant 2026.11 and later, open **Settings → Marketplace → Add from link** and enter the public GitHub repository URL for Presence Calibration. Connect GitHub when prompted, then open **Presence Calibration** in the Marketplace and select **Install**. Follow any restart prompt before adding the integration. [Home Assistant custom repository instructions](https://www.home-assistant.io/integrations/marketplace/#custom-repositories)

## Install from the ZIP

1. Unzip the download and copy `custom_components/presence_calibration` into the `custom_components` folder in your Home Assistant configuration directory. The manifest should end up at `/config/custom_components/presence_calibration/manifest.json` on Home Assistant OS.
2. Restart Home Assistant.

## Connect your sensor

1. Open **Settings → Devices & services → Add integration** and search for **Presence Calibration**.
2. Select the commissioned sensor and enter its calibration code. If you have more than one sensor, select the matching device name and area.
3. Open **Presence Calibration** in the sidebar, choose the sensor, and tap **Start calibration**.

## Walk the room

1. Aim the sensor into the room. Step outside with your phone and run the 30-second empty-room check.
2. Walk in through the doorway, around the usable edges, and past the usual seating area. The map shows the radar detections from your walk. Re-aim and repeat if the radar misses an important spot.
3. Drag the room rectangle on the map. Add **Entry**, **Seating**, or an ignore area if useful. The optional areas fit inside the room rectangle. **Precise bounds** gives you a keyboard alternative to drawing.
4. Test entry and nearby hallway movement against the draft indicators. If you added **Seating**, stand next to the seat until its indicator shows occupied, start the one-minute check, then sit normally. If coverage drops, re-aim and retest or clear the seating zone.
5. Tap **Save to sensor**. The settings take effect on the Matter entities and survive a power cycle. **Undo** restores the previous saved profile.

## If setup stops

- If the device list is empty, finish adding the presence sensor to the stock Matter integration first. Confirm it is online and on calibration-capable firmware.
- If Matter shows the sensor online and calibration cannot connect, confirm the HA host has IPv6 connectivity to its Thread network. The panel uses the sensor's Thread IPv6 address on TCP port 8443. The builder can use the USB console for recovery.
- If the save response is interrupted, reopen the panel to read the current profile from the sensor. The pane shows what the sensor stored.
- If you receive a replacement calibration code, use **Reconfigure** on the Presence Calibration integration entry and enter the new code.

## For the builder

In the companion firmware checkout, build the signed calibration firmware with `./build.sh --ota`. For a new board, flash the verified V5 USB images using `flash_args` in `build-ota/calibration/firmware`. For a sensor already on 0.1.2, use `presence_sensor-ota.bin` from that directory for a Matter update.

Run `calibration provision` once at 115200 baud on the USB console to generate the device's certificate and display its calibration code. This works before Matter commissioning. Put that code on a private setup card alongside the Matter pairing information. `calibration rotate` replaces the setup code and retains the certificate. After a full physical factory reset, run `calibration provision` again and replace the setup card.

The HA panel sends calibration data locally. Live points are held in memory during the session. The sensor stores the saved and previous profiles. The map shows observed radar positions. A successful one-minute seated check covers that position and sensor placement during the check.
