# Install Presence Calibration in Home Assistant

You need Home Assistant admin access and a presence sensor already commissioned into that Home Assistant instance. The sensor needs calibration firmware 0.1.4 or later and its private calibration code. The code is on the setup card that came with the sensor. The Matter pairing QR code is separate.

The integration targets Home Assistant Core 2026.11.1 with the stock Matter Server 9.3.0 app. Home Assistant needs an IPv6 route to the sensor through your existing Thread border router. Your phone connects to Home Assistant as usual.

## Install from a Marketplace repository

On Home Assistant 2026.11 and later, open **Settings → Marketplace → Add from link** and enter the public GitHub repository URL for Presence Calibration. Connect GitHub when prompted, then open **Presence Calibration** in the Marketplace and select **Install**. Follow any restart prompt before adding the integration. [Home Assistant custom repository instructions](https://www.home-assistant.io/integrations/marketplace/#custom-repositories)

The installation URL is [sherlock-homo/presencedaddy-ha](https://github.com/sherlock-homo/presencedaddy-ha). On an installation that still has HACS, use **Custom repositories** and choose **Integration**. The preview ZIP installs the supplied version from disk. Marketplace and HACS install versions published to GitHub. [Open in Marketplace](https://my.home-assistant.io/redirect/marketplace_repository/?owner=sherlock-homo&repository=presencedaddy-ha&category=integration) · [Open in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=sherlock-homo&repository=presencedaddy-ha&category=integration)

## Install from the ZIP

1. Unzip the download and copy `custom_components/presence_calibration` into the `custom_components` folder in your Home Assistant configuration directory. The manifest should end up at `/config/custom_components/presence_calibration/manifest.json` on Home Assistant OS.
2. Restart Home Assistant.

## Connect your sensor

1. Open **Settings → Devices & services → Add integration** and search for **Presence Calibration**.
2. Select the commissioned sensor and enter its calibration code. If you have more than one sensor, select the matching device name and area.
3. Open **Presence Calibration** in the sidebar, choose the sensor, and tap **Start calibration**.

On a fresh compatible LCD unit, hold BOOT for 2–7 seconds and release to generate the private calibration code and briefly display it. Keep the code before the display returns to setup. On an already provisioned unit, use its existing setup card or Home Assistant entry. BOOT preserves working credentials.

## Walk the room

1. Aim the sensor into the room. Step outside with your phone and run the 30-second empty-room check.
2. Walk in through the doorway, around the usable edges, and past the usual seating area. The map shows the radar detections from your walk. Re-aim and repeat if the radar misses an important spot.
3. Drag the room rectangle on the map. Add **Entry**, **Seating**, or an ignore area if useful. The optional areas fit inside the room rectangle. **Precise bounds** gives you a keyboard alternative to drawing.
4. Test entry and nearby hallway movement against the draft indicators. If you added **Seating**, stand next to the seat until its indicator shows occupied, start the one-minute check, then sit normally. If coverage drops, re-aim and retest or clear the seating zone.
5. Tap **Save to sensor**. The settings take effect on the Matter entities and survive a power cycle. **Undo** restores the previous saved profile.

## Set the LCD and revisit calibration

Home Assistant marks setup complete on compatible LCD firmware (Waveshare 0.3.0 or later) after the integration loads. If the sensor was briefly unreachable, a later calibration request or opening **Device tools** retries completion. You can also choose **Mark setup complete**. Saving a room profile also marks setup complete.

In **Device tools**, choose Horizontal or Vertical and select Eyes or Dashboard. Save LCD settings. You can select either display mode whenever you want.

To move the sensor, pause named automation events and remove links to doorways it will no longer cover. For the magnetic enclosure, lift it off the mount and use the indexed internal carrier to keep the radar upright with four patches above two when changing the enclosure orientation. Update the sensor placement in **Floor plans**. Use **Recalibrate sensor** in **Device tools** to reopen the walkthrough, then preview and save the new regions. Validate the new position before re-enabling named automation events.

## If setup stops

- If the device list is empty, finish adding the presence sensor to the stock Matter integration first. Confirm it is online and on calibration-capable firmware.
- If Matter shows the sensor online and calibration cannot connect, confirm the HA host has IPv6 connectivity to its Thread network. The panel uses the sensor's Thread IPv6 address on TCP port 8443. The builder can use the USB console for recovery.
- If the save response is interrupted, reopen the panel to read the current profile from the sensor. The pane shows what the sensor stored.
- If you receive a replacement calibration code, use **Reconfigure** on the Presence Calibration integration entry and enter the new code.

## For the builder

In the companion firmware checkout, build signed calibration firmware with `./build.sh --lcd-ota` for Waveshare LCD hardware or `./build.sh --ota` for the original XIAO C6. Follow the firmware kit’s USB bootstrap or Matter update instructions for that board.

Run `calibration provision` once at 115200 baud on the USB console to generate the device's certificate and display its calibration code. This works before Matter commissioning. Put that code on a private setup card alongside the Matter pairing information. `calibration rotate` replaces the setup code and retains the certificate. After a full physical factory reset, run `calibration provision` again and replace the setup card.

The HA panel sends calibration data locally. Live points are held in memory during the session. The sensor stores the saved and previous profiles. The map shows observed radar positions. A successful one-minute seated check covers that position and sensor placement during the check.
