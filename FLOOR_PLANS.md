# Map a room and check sensor coverage

Open **Presence Calibration → Floor plans**. Create a plan for a floor. Plans are saved in Home Assistant. Each sensor can have its own alignment on the same plan.

## Draw or import the rooms

- **Draw room** lets you tap the corners or enter measured coordinates in meters. Use **Draw feature** to add a wall, door, opening, window, piece of furniture, seating area, entry, ignore area, or other named area. Select a feature to rename, change its type, or redraw its outline.
- **Import RoomPlan** accepts a scan from the presenceDaddy iPhone/iPad capture app or a compatible Apple RoomPlan JSON export. For a new floor, place the capture as-is. To add it to an existing plan, tap the map to move the entire capture and enter its rotation before placing it. The capture preserves room positions relative to one another. Review walls, openings, and furniture against the room, then save the plan.

RoomPlan uses the camera and LiDAR on supported Apple devices. The separately distributed capture helper exports geometry and object categories as local JSON. [Apple RoomPlan](https://developer.apple.com/documentation/roomplan)

## Detect sensor placements during the iPhone scan

1. Create or open a floor plan. In **Sensors**, select a configured presenceDaddy and choose **Download QR label**. Print it at **100%**. The QR symbol itself should measure **50 × 50 mm**, with the surrounding white border intact.
2. Mount the label flat on the sensor front or directly above or below its horizontal center, facing the same direction as the radar. Use one label for each sensor. The label contains a Home Assistant sensor reference. Keep your separate Matter and calibration codes for commissioning and setup.
3. During **Scan room** on the iPhone, aim at each label and move slightly to one side to capture a second angle. Wait for the **Labeled sensors located** count to increase. Finish the room, scan the remaining rooms, then export the floor plan.
4. Import the file in Home Assistant. Check each detected sensor’s position and direction on the map. Select the placements you want to use, then place and save the scan. Existing sensor alignments stay in place. Repeat the label setup if a sensor is removed and re-added to Home Assistant under a new integration entry.

The label provides an initial position and facing direction. Check the position with live radar before relying on coverage, and use walked anchors when you need to tune the fit or send calibration rectangles to the sensor.

## Align each presenceDaddy

1. In **Sensors**, select a presenceDaddy configured in Home Assistant and start radar preview.
2. Tap a spot you can identify on the floor, then walk to it and move slightly until the map reports a single radar dot. Tap **Capture anchor**. Repeat at a second spot at least 0.75 m away. Mark a third spot in a different direction and stand there. Once the dot is steady, read its distance from the marked point below the map. Check that distance before adding the third anchor so it measures how well the existing fit works away from its anchors.
3. Walk through the areas you care about. The shaded sector estimates which rooms and features fall within radar coverage. The white dots show actual detections, including detections outside the estimate. The estimate uses the LD2450’s nominal range of 6 m and the drawn walls, with marked doors and openings treated as open. For a previously imported doorway labeled **Entry**, change its type to **Opening** if it represents a physical passage. [Hi-Link LD2450 specifications](https://hlktech.com/Goods-352.html)
4. Choose a room and use **Review radar rectangles** to open a calibration draft for that sensor. The draft uses the room's first **Seating**, **Entry**, and **Area** features for the corresponding zones, with **Area** filling **Extra zone**. Check where the rectangles land, especially around rotated or irregular rooms, and use the existing preview and save flow to apply them. **Save plan** stores the floor plan and alignment in Home Assistant.

## Add Wi-Fi measurements

Record samples at known locations with the macOS Wi-Fi survey collector. On the **Wi-Fi** tab, import the survey JSON, select a sample, tap its collection point on the map, and pin it. Select an access point to see its readings in dBm. A shaded estimate appears within its sampled area when there are enough spatially separate points. Keep taking and pinning samples to cover more of the floor.

The Wi-Fi layer, the room outlines, and the radar overlays use the same coordinates. In **Sensors**, select **Show Wi-Fi signal beneath radar coverage** to see both layers. RoomPlan and measured dimensions supply the geometry. Wi-Fi adds signal measurements at locations you mark. The app stores pseudonymous access-point labels and the plotted readings.
