import {
  bounds, calibrationFromPlan, coverageOutline, detectionsInRegions, fitPlanSensor, fitSensor,
  planPoint, pointInPolygon, ringArea, transformPlacements, transformRooms, validOutline, validSensorPlacement, visibleRegions,
} from './floorplan-geometry.js';
import {createWifiField, parseWifiSurvey, pinWifiScan, wifiAccessPoints} from './floorplan-wifi.js';

const API = 'presence_calibration';
const FEATURES = {
  wall: ['Wall', '#a1bfcd'], door: ['Door', '#e6bb7d'], opening: ['Opening', '#f1cf9f'], window: ['Window', '#8bd7ef'],
  object: ['Object', '#c2a8d2'], seating: ['Seating', '#d1a4fa'], entry: ['Entry', '#85afff'],
  ignore: ['Ignore area', '#ed986c'], area: ['Area', '#6ed1a2'],
};
const ERRORS = {
  invalid_floorplan: 'The plan contains an invalid name, shape, measurement or sensor alignment.',
  floorplan_conflict: 'Someone saved a newer version of this plan. Reload before saving again.',
  floorplan_limit: 'This instance has reached its floor plan storage limit.',
  floorplan_storage_failed: 'Home Assistant could not store the plan.',
  invalid_roomplan: 'The RoomPlan file has no usable room geometry.',
  device_unavailable: 'Home Assistant lost contact with the presenceDaddy.',
  session_closed: 'The radar session ended. Start it again to continue.',
  session_expired: 'The radar session ended. Start it again to continue.',
  session_required: 'The radar session ended. Start it again to continue.',
  session_busy: 'This presenceDaddy already has a calibration session open.',
  session_open: 'This presenceDaddy already has a calibration session open.',
};

const clone = data => JSON.parse(JSON.stringify(data));
const id = () => globalThis.crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rounded = point => point.map(n => Math.round(n / 50) * 50);
const labelPoint = points => points.reduce(([x, y], [a, b]) => [x + a / points.length, y + b / points.length], [0, 0]);
const errorText = error => ERRORS[error?.code ?? error] ?? 'The floor plan operation could not finish. Try again.';
const headingText = heading => `${heading / 1000}°`;

function placementLabelSvg(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 21 || matrix.length > 177 ||
      (matrix.length - 21) % 4 !== 0 ||
      matrix.some(row => typeof row !== 'string' || row.length !== matrix.length || /[^01]/.test(row))) return null;
  const quiet = 4;
  const units = matrix.length + 2 * quiet;
  const millimeters = (50 * units / matrix.length).toFixed(6);
  const modules = [];
  for (const [y, row] of matrix.entries()) {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') modules.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${millimeters}mm" height="${millimeters}mm" viewBox="0 0 ${units} ${units}" shape-rendering="crispEdges"><rect width="${units}" height="${units}" fill="#fff"/><path fill="#000" d="${modules.join('')}"/></svg>`;
}

const template = `
<style>
  :host { display:block; color:var(--primary-text-color,#21343a); font:400 15px/1.5 var(--primary-font-family,system-ui,sans-serif); --border:var(--divider-color,#cedce1); --surface:var(--card-background-color,#fff); --muted:var(--secondary-text-color,#546b73); --green:#14675a; }
  * { box-sizing:border-box; }
  main { max-width:1250px; margin:auto; padding:20px 20px 36px; }
  .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .split { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:12px; }
  .layout { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(275px,1fr); gap:14px; align-items:start; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:13px; padding:16px; min-width:0; }
  .map-card { padding:0; overflow:hidden; }
  .map-tools { padding:10px 12px; justify-content:space-between; }
  .map-tools button { min-width:42px; }
  h2,h3,p { margin:0 0 8px; }
  h2 { font-size:22px; letter-spacing:-.02em; }
  h3 { font-size:16px; }
  p,small { color:var(--muted); }
  label { display:block; margin:8px 0 4px; font-weight:550; }
  select,input,button { border:1px solid var(--border); border-radius:8px; min-height:42px; font:inherit; background:var(--surface); color:inherit; padding:7px 10px; }
  input,select { width:100%; }
  button { font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  button.primary,[aria-current=page] { color:white; background:var(--green); border-color:var(--green); }
  button:focus-visible,select:focus-visible,input:focus-visible { outline:3px solid #4195ce; outline-offset:2px; }
  nav { display:flex; gap:6px; margin-bottom:12px; }
  nav button { flex:1; }
  canvas { display:block; width:100%; height:clamp(280px,50vw,590px); background:#15272d; touch-action:manipulation; }
  canvas.active { cursor:crosshair; }
  .legend,.feedback { padding:8px 12px; font-size:13px; }
  .feedback { border-left:3px solid #439c8b; margin:0 0 12px; background:var(--surface); }
  .error { border-left-color:var(--error-color,#b94237); }
  section .row { margin-top:8px; }
  ol,ul { padding-left:20px; }
  li { margin:4px 0; }
  hr { border:0; border-top:1px solid var(--border); margin:14px 0; }
  details { margin-top:8px; }
  .coord input { width:85px; }
  .check { display:flex; gap:8px; align-items:center; overflow-wrap:anywhere; }
  .check input { width:auto; min-height:auto; }
  [hidden] { display:none!important; }
  @media(max-width:740px){main{padding:12px}.layout{grid-template-columns:1fr;gap:10px}.card{padding:12px}.map-card{padding:0}.split{display:block}.split>.row{margin-top:8px}.map-tools{padding:7px 10px}canvas{height:300px}}
</style>
<main>
  <div class="split">
    <div><h2>Floor plans</h2><p id="status">Loading plans…</p></div>
    <div class="row"><button id="new-plan">New plan</button><button id="save-plan" class="primary" disabled>Save plan</button><button id="revert-plan" disabled>Revert draft</button></div>
  </div>
  <div id="notice" class="feedback" role="status" hidden></div>
  <div id="empty" class="card" hidden><p>Create a plan to draw the rooms or add a RoomPlan scan.</p></div>
  <div id="workspace" hidden>
    <div class="layout">
      <section class="card map-card">
        <div class="row map-tools"><strong id="map-name"></strong><div class="row"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="fit-map">Fit</button></div></div>
        <canvas id="map" aria-label="Floor plan with room outlines, sensor coverage and survey points"></canvas>
        <div class="row map-tools" id="map-actions" hidden><button class="primary" id="anchor">Capture anchor</button><button class="primary" id="scan-pin">Pin sample</button><small id="map-action-label"></small></div>
        <div id="legend" class="legend"></div>
        <details class="legend"><summary>Enter a point by coordinates</summary><p>X increases right. Y increases up.</p><div class="row coord"><label>X (m)<input id="point-x" type="number" step="0.05"></label><label>Y (m)<input id="point-y" type="number" step="0.05"></label><button id="point-use">Use point</button></div></details>
      </section>
      <section class="card">
        <label for="plan">Plan</label><select id="plan"></select>
        <label for="plan-name">Plan name</label><input id="plan-name" maxlength="80">
        <hr>
        <nav aria-label="Plan tools"><button data-pane="layout" aria-current="page">Layout</button><button data-pane="sensors">Sensors</button><button data-pane="wifi">Wi-Fi</button></nav>
        <section id="pane-layout">
          <div class="row"><button id="room-draw">Draw room</button><button id="ar-pick">Import RoomPlan</button></div>
          <input id="ar-file" type="file" accept=".json,application/json" hidden>
          <div id="placement" hidden>
            <label for="rotation">Rotation (degrees)</label><input id="rotation" type="number" value="0" step="5">
            <p>Tap the map to move the scan. Rotate it to meet your existing walls.</p>
            <div id="placement-review" hidden><h3>Review sensor placements</h3><p>Select the QR labels to place with the scan.</p><ul id="placement-options"></ul></div>
            <div class="row"><button id="ar-place" class="primary">Place scan</button><button id="ar-cancel">Cancel</button></div>
          </div>
          <label for="room">Room</label><select id="room"></select>
          <div id="room-controls" hidden>
            <label for="room-name">Room name</label><input id="room-name" maxlength="80">
            <label for="kind">New feature</label><select id="kind"></select>
            <div class="row"><button id="feature-draw">Draw feature</button><button id="room-redraw">Redraw room</button><button id="room-remove">Remove room</button></div>
            <ul id="features"></ul>
            <div id="feature-edit" hidden><label for="feature-name">Feature name</label><input id="feature-name" maxlength="80"><label for="feature-kind">Type</label><select id="feature-kind"></select><div class="row"><button id="feature-redraw">Redraw feature</button></div></div>
          </div>
          <div id="drawing" hidden><label for="draw-name">Shape name</label><input id="draw-name" maxlength="80"><p>Tap each corner in order. Use at least three points.</p><div class="row"><button id="draw-finish" class="primary">Finish shape</button><button id="draw-back">Last point</button><button id="draw-cancel">Cancel</button></div></div>
        </section>
        <section id="pane-sensors" hidden>
          <label for="sensor">presenceDaddy</label><select id="sensor"></select>
          <details id="placement-label">
            <summary>Sensor QR label</summary>
            <p>Print at 100% so the QR square measures 50 mm, excluding the white border. Center the label horizontally, flat and upright on the sensor front. Scan it while mapping the room.</p>
            <div class="row"><button id="download-label">Download QR label</button></div>
          </details>
          <div class="row"><button id="radar-start">Start radar</button><button id="radar-stop" disabled>Stop radar</button></div>
          <p id="radar-status" role="status">Radar is idle.</p>
          <p>Tap a known spot on the plan. Walk to it, then capture one steady radar dot. Repeat at a second spot at least 0.75 m away. At a third marked spot, read the distance below the map to check alignment.</p>
          <div class="row"><button id="anchor-back">Remove last anchor</button></div>
          <label><input id="mirror" type="checkbox" style="width:auto;min-height:auto"> Mirror radar left and right</label>
          <p id="alignment"></p>
          <div class="row" id="label-actions" hidden><button id="remove-placement">Remove label placement</button></div>
          <label for="cal-room">Room to calibrate</label><select id="cal-room"></select>
          <div class="row"><button id="send-profile" disabled>Review radar rectangles</button></div>
          <p>The calibration draft fits polygons to radar-aligned rectangles.</p>
          <label id="combined-layer" hidden><input id="also-wifi" type="checkbox" style="width:auto;min-height:auto"> Show Wi-Fi signal beneath radar coverage</label>
          <h3>Estimated coverage</h3><ul id="visible"></ul>
          <p>Doors on the plan are modeled as open. Walk the room to verify coverage.</p>
        </section>
        <section id="pane-wifi" hidden>
          <p>Import a survey, then tap where each sample was taken. The map shows signal strength for those spots.</p>
          <div class="row"><button id="wifi-pick">Import Wi-Fi survey</button></div><input id="wifi-file" type="file" accept=".json,application/json" hidden>
          <label for="scan">Survey sample</label><select id="scan"></select>
          <label for="ap">Signal layer</label><select id="ap"></select>
          <ul id="scan-list"></ul>
        </section>
      </section>
    </div>
  </div>
</main>`;

export class FloorplanPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'}).innerHTML = template;
    this.$ = key => this.shadowRoot.getElementById(key);
    this.plans = [];
    this.entries = [];
    this.scans = [];
    this.pane = 'layout';
    this.generation = 0;
    this.radarGeneration = 0;
    this.zoom = 1;
    this.radarSamples = [];
    this.observed = new Set();
    this.labelPending = false;
    this.resize = new ResizeObserver(() => this.draw());
    this.bind();
  }

  bind() {
    const actions = {
      'new-plan': () => this.newPlan(), 'save-plan': () => this.save(), 'revert-plan': () => this.revert(),
      'room-draw': () => this.beginShape('room'), 'feature-draw': () => this.beginShape(this.$('kind').value),
      'room-redraw': () => this.beginShape('room', this.room), 'feature-redraw': () => this.beginShape(this.feature.kind, this.feature),
      'room-remove': () => this.removeRoom(), 'draw-finish': () => this.finishShape(),
      'draw-back': () => { this.shape.points.pop(); this.draw(); }, 'draw-cancel': () => { this.shape = null; this.render(); },
      'ar-pick': () => this.$('ar-file').click(), 'ar-place': () => this.placeImport(), 'ar-cancel': () => { this.placement = null; this.render(); },
      'wifi-pick': () => this.$('wifi-file').click(), 'scan-pin': () => this.pinScan(),
      'radar-start': () => this.startRadar(), 'radar-stop': () => this.stopRadar(), 'anchor': () => this.captureAnchor(),
      'anchor-back': () => this.removeAnchor(), 'send-profile': () => this.sendProfile(),
      'download-label': () => this.downloadPlacementLabel(), 'remove-placement': () => this.removePlacement(),
      'zoom-in': () => this.changeZoom(1.35), 'zoom-out': () => this.changeZoom(1 / 1.35),
      'fit-map': () => { this.zoom = 1; this.draw(); }, 'point-use': () => this.enterPoint(),
    };
    Object.entries(actions).forEach(([key, action]) => { this.$(key).onclick = action; });
    Object.entries(FEATURES).forEach(([key, [name]]) => {
      this.$('kind').add(new Option(name, key)); this.$('feature-kind').add(new Option(name, key));
    });
    this.shadowRoot.querySelectorAll('[data-pane]').forEach(button => { button.onclick = () => this.setPane(button.dataset.pane); });
    this.$('plan').onchange = () => {
      if (this.dirty) { this.$('plan').value = this.current.id; this.notice('Save or revert the draft before switching plans.', true); }
      else this.choose(this.$('plan').value);
    };
    this.$('plan-name').oninput = () => { this.current.name = this.$('plan-name').value; this.changed(); };
    const selectRoom = key => { this.shape = null; this.roomId = this.$(key).value; this.render(); };
    this.$('room').onchange = () => selectRoom('room');
    this.$('cal-room').onchange = () => selectRoom('cal-room');
    this.$('room-name').oninput = () => { this.room.name = this.$('room-name').value; this.changed(); };
    this.$('feature-name').oninput = () => { this.feature.name = this.$('feature-name').value; this.changed(); };
    this.$('feature-kind').onchange = () => {
      this.feature.kind = this.$('feature-kind').value;
      this.observed.delete(this.feature.id);
      this.changed();
      this.render();
    };
    this.$('sensor').onchange = () => this.selectSensor(this.$('sensor').value);
    this.$('mirror').onchange = () => this.setMirror(this.$('mirror').checked);
    this.$('rotation').oninput = () => {
      if (!this.placement) return;
      this.placement.angle = Number(this.$('rotation').value) || 0;
      this.renderPlacementReview(); this.draw();
    };
    this.$('ar-file').onchange = () => this.readImport('room');
    this.$('wifi-file').onchange = () => this.readImport('wifi');
    this.$('scan').onchange = () => { this.scanId = this.$('scan').value; this.refreshControls(); };
    this.$('ap').onchange = () => { this.ap = this.$('ap').value; this.draw(); };
    this.$('also-wifi').onchange = () => this.draw();
    this.$('map').onclick = event => {
      if (!this.view) return;
      const rect = this.$('map').getBoundingClientRect();
      this.usePoint(rounded(this.view.world(event.clientX - rect.left, event.clientY - rect.top)));
    };
  }

  connectedCallback() { this.resize.observe(this.$('map')); }
  disconnectedCallback() { this.resize.disconnect(); this.setActive(false); }

  set hass(value) {
    if (value?.connection === this.connection) return;
    void this.stopRadar();
    this.connection = value?.connection;
    if (this.active) void this.load();
  }

  async setActive(value) {
    this.active = value;
    if (!value) { this.generation++; await this.stopRadar(); return; }
    if (!this.loaded && this.connection) await this.load();
    this.render();
  }

  request(route, fields = {}, connection = this.connection) {
    return connection.sendMessagePromise({type: `${API}/floorplans/${route}`, ...fields});
  }

  sensorRequest(action, entry = this.sensorId, connection = this.connection) {
    return connection.sendMessagePromise({type: `${API}/request`, entry_id: entry, action});
  }

  notice(message = '', error = false) {
    const node = this.$('notice');
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle('error', error);
  }

  async load() {
    const active = ++this.generation;
    const connection = this.connection;
    const [plans, sensors] = await Promise.allSettled([
      this.request('list'), connection.sendMessagePromise({type: `${API}/status`}),
    ]);
    if (active !== this.generation) return;
    if (plans.status === 'rejected') { this.notice(errorText(plans.reason), true); this.$('status').textContent = 'Plans unavailable'; return; }
    this.plans = plans.value.plans;
    this.entries = sensors.status === 'fulfilled' ? sensors.value.entries : [];
    this.loaded = true;
    if (!this.dirty) this.choose(this.current?.id ?? this.plans[0]?.id);
    this.render();
  }

  get room() { return this.current?.rooms.find(room => room.id === this.roomId); }
  get feature() { return this.room?.features.find(feature => feature.id === this.selectedFeature); }
  get sensor() { return this.current?.sensors.find(sensor => sensor.entry_id === this.sensorId); }
  get fit() { return fitPlanSensor(this.sensor); }

  choose(planId) {
    void this.stopRadar();
    const plan = this.plans.find(p => p.id === planId);
    this.current = plan ? clone(plan) : null;
    this.dirty = false;
    this.resetSelection();
    this.render();
  }

  resetSelection() {
    this.estimate = null;
    this.roomId = this.current?.rooms[0]?.id;
    this.sensorId = this.current?.sensors[0]?.entry_id ?? this.entries[0]?.entry_id ?? '';
    this.shape = this.placement = this.point = null;
    this.observed.clear();
    this.zoom = 1;
  }

  newPlan() {
    if (this.dirty) { this.notice('Save or revert the draft before starting a new plan.', true); return; }
    void this.stopRadar();
    this.current = {id: id(), name: 'New floor plan', revision: 0, rooms: [], sensors: [], wifi: []};
    this.resetSelection();
    this.dirty = true;
    this.setPane('layout');
    this.$('plan-name').focus();
    this.$('plan-name').select();
  }

  async revert() {
    if (this.stale) await this.load();
    this.stale = false;
    this.choose(this.current?.revision ? this.current.id : this.plans[0]?.id);
    this.notice();
  }

  changed() {
    this.estimate = null;
    this.dirty = true;
    this.$('status').textContent = 'Unsaved changes';
    this.$('map-name').textContent = this.current.name;
    this.refreshControls();
    this.draw();
  }

  async save() {
    if (this.saving || !this.dirty || !this.current.name.trim()) return;
    if (this.current.sensors.some(s => s.anchors.length ? !fitSensor(s.anchors, s.mirrored) : !validSensorPlacement(s.placement))) {
      this.notice('Finish or remove incomplete sensor anchors before saving.', true);
      return;
    }
    const plan = clone(this.current);
    this.saving = true;
    this.refreshControls();
    try {
      const result = await this.request('save', {plan, expected_revision: plan.revision});
      this.plans = [...this.plans.filter(p => p.id !== result.id), result].sort((a, b) => a.name.localeCompare(b.name));
      if (JSON.stringify(this.current) === JSON.stringify(plan)) { this.current = clone(result); this.dirty = false; this.estimate = null; }
      else if (this.current.id === result.id) this.current.revision = result.revision;
      this.notice('Plan saved.');
    } catch (error) {
      this.stale = error?.code === 'floorplan_conflict';
      this.notice(this.stale ? 'Another edit was saved first. Revert draft to reload the saved plan.' : errorText(error), true);
    } finally { this.saving = false; this.render(); }
  }

  setPane(pane) {
    if (pane !== 'sensors') void this.stopRadar();
    this.pane = pane;
    this.point = null;
    this.render();
  }

  setOptions(element, items, selected, emptyLabel) {
    if (!items.length) element.replaceChildren(new Option(emptyLabel, ''));
    else element.replaceChildren(...items.map(item => new Option(item.label, item.value)));
    if (items.some(item => item.value === selected)) element.value = selected;
  }

  render() {
    this.$('workspace').hidden = !this.current;
    this.$('empty').hidden = !this.loaded || Boolean(this.current);
    this.$('status').textContent = this.dirty ? 'Unsaved changes' : this.loaded ? '' : 'Loading plans…';
    this.refreshControls();
    if (!this.current) return;
    const planList = this.current.revision ? this.plans : [...this.plans, this.current];
    this.setOptions(this.$('plan'), planList.map(p => ({label: p.name, value: p.id})), this.current.id, 'No plans');
    this.$('plan-name').value = this.current.name;
    this.$('map-name').textContent = this.current.name;
    this.shadowRoot.querySelectorAll('[data-pane]').forEach(button => {
      const active = button.dataset.pane === this.pane;
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      this.$(`pane-${button.dataset.pane}`).hidden = !active;
    });
    this.setOptions(this.$('room'), this.current.rooms.map(room => ({label: room.name, value: room.id})), this.roomId, 'No rooms');
    this.setOptions(this.$('cal-room'), this.current.rooms.map(room => ({label: room.name, value: room.id})), this.roomId, 'No rooms');
    this.$('room-controls').hidden = !this.room;
    this.$('room-name').value = this.room?.name ?? '';
    this.$('features').replaceChildren(...(this.room?.features ?? []).map(f => this.featureItem(f)));
    this.$('feature-edit').hidden = !this.feature;
    this.$('feature-name').value = this.feature?.name ?? '';
    this.$('feature-kind').value = this.feature?.kind ?? 'object';
    this.$('drawing').hidden = !this.shape;
    this.$('placement').hidden = !this.placement;
    this.renderPlacementReview();
    const sensors = this.entries.map(e => ({value: e.entry_id, label: e.title}));
    for (const entry of this.current.sensors) {
      if (!sensors.some(e => e.value === entry.entry_id)) sensors.push({value: entry.entry_id, label: 'Unavailable sensor'});
    }
    this.setOptions(this.$('sensor'), sensors, this.sensorId, 'Add a Presence Calibration device first');
    this.$('mirror').checked = Boolean(this.sensor?.mirrored);
    this.setOptions(this.$('scan'), this.scans.map(s => ({value: s.id, label: s.name})), this.scanId, 'No survey samples');
    const aps = wifiAccessPoints(this.current.wifi);
    this.ap = aps.some(a => a.ap === this.ap) ? this.ap : aps[0]?.ap;
    this.setOptions(this.$('ap'), aps.map((a, i) => ({value: a.ap, label: `Access point ${i + 1} · ${a.samples} samples`})), this.ap, 'No pinned signals');
    this.$('scan-list').replaceChildren(...this.current.wifi.map((scan, i) => this.removableItem(`Point ${i + 1} · ${scan.signals.length} APs`, () => {
      this.current.wifi = this.current.wifi.filter(item => item.id !== scan.id); this.changed(); this.render();
    })));
    this.$('combined-layer').hidden = !this.ap;
    this.$('legend').textContent = this.pane === 'sensors' ? (this.fit?.source === 'label' ?
      'Shaded sector and dot positions use the estimated QR placement.' : 'Shaded sector is estimated. White dots are observed radar detections.') :
      this.pane === 'wifi' ? 'Dots show measured values. Shading interpolates between sampled points.' : 'Grid spacing is shown on the map.';
    this.refreshControls();
    this.draw();
  }

  featureItem(feature) {
    const item = this.removableItem(`${feature.name} · ${FEATURES[feature.kind][0]}`, () => {
      this.room.features = this.room.features.filter(f => f.id !== feature.id); this.changed(); this.render();
    });
    const label = item.querySelector('span');
    const edit = document.createElement('button');
    edit.textContent = label.textContent;
    edit.setAttribute('aria-label', `Edit ${label.textContent}`);
    edit.onclick = () => { this.selectedFeature = feature.id; this.render(); this.$('feature-name').focus(); };
    label.replaceWith(edit);
    return item;
  }

  removableItem(text, remove) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = text;
    const button = document.createElement('button');
    button.textContent = 'Remove'; button.onclick = remove;
    button.setAttribute('aria-label', `Remove ${text}`);
    item.className = 'row'; item.append(label, button);
    return item;
  }

  beginShape(kind, target = null) {
    this.placement = null;
    this.shape = {kind, points: [], base: this.sceneBounds(), target};
    this.$('draw-name').value = target?.name ?? (kind === 'room' ? `Room ${this.current.rooms.length + 1}` : FEATURES[kind][0]);
    this.render();
  }

  finishShape() {
    const name = this.$('draw-name').value.trim();
    const {kind, points, target} = this.shape;
    if (!name || !validOutline(points)) { this.notice('Enter a name and draw a shape with distinct corners and no crossings.', true); return; }
    if (target) {
      Object.assign(target, {name, outline: points});
      this.observed.delete(target.id);
    } else if (kind === 'room') {
      this.roomId = id();
      this.current.rooms.push({id: this.roomId, name, outline: points, features: []});
    } else this.room.features.push({id: id(), kind, name, outline: points});
    this.shape = null;
    this.notice();
    this.changed();
    this.render();
  }

  removeRoom() {
    this.current.rooms = this.current.rooms.filter(room => room.id !== this.roomId);
    this.roomId = this.current.rooms[0]?.id;
    this.shape = null;
    this.changed();
    this.render();
  }

  usePoint(point) {
    if (this.pane === 'layout' && this.shape) {
      if (!this.shape.points.some(p => distance(p, point) < 10)) this.shape.points.push(point);
    } else if (this.pane === 'layout' && this.placement) {
      this.placement.offset = point.map((n, i) => n - this.placement.pivot[i]);
      this.renderPlacementReview();
    } else if (this.pane === 'layout') {
      const room = this.current.rooms.find(room => pointInPolygon(point, room.outline));
      if (room) { this.roomId = room.id; this.render(); }
    } else this.point = point;
    this.refreshControls();
    this.draw();
  }

  enterPoint() {
    const meters = [this.$('point-x').valueAsNumber, this.$('point-y').valueAsNumber];
    if (meters.some(v => !Number.isFinite(v) || Math.abs(v) > 1000)) { this.notice('Enter both coordinates within ±1000 m.', true); return; }
    this.usePoint(meters.map(n => Math.round(n * 1000)));
  }

  async readImport(kind) {
    const input = this.$(kind === 'room' ? 'ar-file' : 'wifi-file');
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const planId = this.current.id;
    if (file.size > 2 * 1024 * 1024) { this.notice('Choose a JSON file smaller than 2 MiB.', true); return; }
    try {
      const data = JSON.parse(await file.text(), (key, value) => key === 'coreModel' ? undefined : value);
      if (kind === 'room') {
        const capture = await this.request('import_roomplan', {capture: data});
        if (this.current?.id !== planId) return;
        this.shape = null;
        const all = capture.rooms.flatMap(room => room.outline);
        const markers = Array.isArray(capture.placements) ? capture.placements.filter(validSensorPlacement) : [];
        this.placement = {rooms: capture.rooms, markers, accepted: new Set(), pivot: labelPoint(all), angle: 0, offset: [0, 0]};
        this.$('rotation').value = '0';
        this.notice(`Ready to place ${capture.rooms.length} ${capture.rooms.length === 1 ? 'room' : 'rooms'}.`);
      } else {
        const incoming = parseWifiSurvey(data);
        if (this.current?.id !== planId) return;
        this.scans = [...new Map([...this.scans, ...incoming].map(scan => [scan.id, scan])).values()];
        this.scanId = incoming[0]?.id;
        this.notice(`Ready to pin ${incoming.length} Wi-Fi ${incoming.length === 1 ? 'sample' : 'samples'}.`);
      }
      this.render();
    } catch (error) { this.notice(error?.code ? errorText(error) : 'The file could not be read as a supported survey.', true); }
  }

  importedRooms() {
    const p = this.placement;
    return p ? transformRooms(p.rooms, p.pivot, p.offset, p.angle) : [];
  }

  placementReview() {
    const p = this.placement;
    if (!p?.markers.length) return [];
    const existing = new Set(this.current.sensors.map(sensor => sensor.entry_id));
    const entries = new Map(this.entries.map(entry => [entry.entry_id, entry.title]));
    const counts = new Map();
    for (const {entry_id: id} of p.markers) counts.set(id, (counts.get(id) || 0) + 1);
    const review = [];
    const seen = new Set();
    for (const marker of transformPlacements(p.markers, p.pivot, p.offset, p.angle)) {
      const id = marker.entry_id;
      if (seen.has(id)) continue;
      seen.add(id);
      let reason = '';
      if (!entries.has(id)) reason = 'Sensor is unavailable in this Home Assistant.';
      else if (counts.get(id) > 1) reason = 'Multiple labels found for this sensor.';
      else if (existing.has(id)) reason = 'This sensor already has an alignment on the plan.';
      else if (!validSensorPlacement(marker)) reason = 'Placement is outside the plan coordinate range.';
      review.push({marker, title: entries.get(id) ?? 'Unconfigured sensor', reason});
    }
    return review;
  }

  renderPlacementReview() {
    const review = this.placementReview();
    this.$('placement-review').hidden = !review.length;
    this.$('placement-options').replaceChildren(...review.map(({marker, title, reason}) => {
      const item = document.createElement('li');
      item.dataset.headingMdeg = marker.heading_mdeg;
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.placementEntry = marker.entry_id;
      input.disabled = Boolean(reason);
      input.checked = !reason && this.placement.accepted.has(marker.entry_id);
      input.onchange = () => {
        if (input.checked) this.placement.accepted.add(marker.entry_id);
        else this.placement.accepted.delete(marker.entry_id);
        this.draw();
      };
      label.append(input, document.createTextNode(title));
      const detail = document.createElement('small');
      detail.textContent = reason || `Heading ${headingText(marker.heading_mdeg)}`;
      item.append(label, detail);
      return item;
    }));
  }

  placeImport() {
    if (!this.placement) return;
    const accepted = this.placementReview().filter(({marker, reason}) => !reason && this.placement.accepted.has(marker.entry_id));
    const rooms = this.importedRooms().map(room => ({...room, id: id(), features: room.features.map(feature => ({...feature, id: id()}))}));
    this.current.rooms.push(...rooms);
    for (const {marker: {entry_id, origin, heading_mdeg}} of accepted) {
      this.current.sensors.push({entry_id, anchors: [], mirrored: false, placement: {origin, heading_mdeg}});
    }
    if (accepted.length) {
      this.sensorId = accepted[0].marker.entry_id;
      this.observed.clear();
    }
    this.roomId = rooms[0].id;
    this.placement = null;
    this.notice();
    this.changed();
    this.render();
  }

  async downloadPlacementLabel() {
    const entry = this.entries.find(entry => entry.entry_id === this.sensorId);
    if (!entry || this.labelPending) return;
    const connection = this.connection;
    this.labelPending = true;
    this.refreshControls();
    try {
      const result = await this.request('placement_label', {entry_id: entry.entry_id}, connection);
      if (!this.active || this.pane !== 'sensors' || this.connection !== connection || this.sensorId !== entry.entry_id) return;
      const svg = placementLabelSvg(result?.matrix);
      if (!svg) {
        this.notice('Home Assistant returned an invalid QR label.', true);
        return;
      }
      const filename = entry.title.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'sensor';
      const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = `presenceDaddy-${filename}-placement.svg`;
      link.hidden = true;
      this.shadowRoot.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.notice(errorText(error), true);
    } finally {
      this.labelPending = false;
      this.refreshControls();
    }
  }

  pinScan() {
    const scan = this.scans.find(scan => scan.id === this.scanId);
    if (!scan || !this.point) return;
    try {
      this.current.wifi = pinWifiScan(this.current.wifi, scan, this.point);
      this.point = null;
      const pinned = new Set(this.current.wifi.map(item => item.id));
      this.scanId = this.scans.find(item => !pinned.has(item.id))?.id ?? scan.id;
      this.notice('Wi-Fi sample pinned.');
      this.changed();
      this.render();
    } catch { this.notice('The sample could not be pinned at this point.', true); }
  }

  async selectSensor(entry) {
    await this.stopRadar();
    this.sensorId = entry;
    this.estimate = null;
    this.point = null;
    this.observed.clear();
    this.render();
  }

  async startRadar() {
    if (this.radar || this.radarOpening || !this.entries.some(e => e.entry_id === this.sensorId)) return;
    const entry = this.sensorId;
    const connection = this.connection;
    const epoch = ++this.radarGeneration;
    this.radarOpening = true;
    this.refreshControls();
    this.$('radar-status').textContent = 'Connecting to radar…';
    try {
      await this.sensorRequest('open', entry, connection);
      if (epoch !== this.radarGeneration) { await this.sensorRequest('close', entry, connection); return; }
      this.radar = {entry, connection};
      const unsubscribe = await connection.subscribeMessage((frame) => {
        if (epoch === this.radarGeneration) this.receiveFrame(frame);
      }, {type: `${API}/subscribe`, entry_id: entry});
      if (epoch !== this.radarGeneration) { await unsubscribe(); return; }
      this.radar.unsubscribe = unsubscribe;
      if (!this.frame) this.$('radar-status').textContent = 'Waiting for radar readings…';
      this.radarTimer = setInterval(() => { this.refreshControls(); this.draw(); }, 500);
    } catch (error) {
      if (epoch === this.radarGeneration) { await this.stopRadar(); this.notice(errorText(error), true); }
    } finally { this.radarOpening = false; this.refreshControls(); }
  }

  async stopRadar() {
    this.radarGeneration++;
    const previous = this.radar;
    this.radar = this.frame = null;
    this.radarSamples = [];
    clearInterval(this.radarTimer);
    this.$('radar-status').textContent = 'Radar is idle.';
    this.refreshControls();
    if (previous) {
      await this.sensorRequest('close', previous.entry, previous.connection).catch(() => {});
      if (previous.unsubscribe) await Promise.resolve(previous.unsubscribe()).catch(() => {});
    }
  }

  receiveFrame(frame) {
    if (frame.error) {
      this.frame = null;
      if (['session_closed', 'session_expired', 'session_required'].includes(frame.error)) void this.stopRadar();
      this.$('radar-status').textContent = errorText(frame.error);
      this.refreshControls(); this.draw(); return;
    }
    const now = performance.now();
    const changed = frame.sequence !== this.frame?.sequence;
    this.frame = {...frame, time: now};
    if (frame.healthy && frame.age_ms !== null && frame.age_ms < 1300 && changed) {
      this.radarSamples.push({time: now, points: frame.points});
      this.radarSamples = this.radarSamples.filter(f => now - f.time < 1900);
      const fit = this.fit;
      if (fit) {
        for (const region of detectionsInRegions(this.current.rooms, frame.points.map(point => planPoint(fit, point)))) this.observed.add(region);
      }
    }
    this.$('radar-status').textContent = frame.healthy ? `${frame.points.length} radar ${frame.points.length === 1 ? 'dot' : 'dots'}` : 'Radar data is unavailable.';
    this.refreshControls();
    this.draw();
  }

  currentDot() {
    const now = performance.now();
    if (!this.frame?.healthy || this.frame.age_ms === null || now - this.frame.time + this.frame.age_ms > 1600 || this.frame.points.length !== 1) return null;
    const samples = this.radarSamples.filter(f => now - f.time < 1750);
    if (samples.length < 2 || samples.some(f => f.points.length !== 1)) return null;
    const centers = [0, 1].map(i => {
      const sorted = samples.map(f => f.points[0][i]).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    });
    return samples.every(f => distance(f.points[0], centers) < 450) ? centers : null;
  }

  captureAnchor() {
    const point = this.currentDot();
    if (!point || !this.point) { this.notice('Choose a map point and wait for a single steady radar dot.', true); return; }
    const entry = this.sensor ?? {entry_id: this.sensorId, anchors: [], mirrored: this.$('mirror').checked};
    entry.anchors.push({radar: point, plan: this.point});
    if (!this.sensor) this.current.sensors.push(entry);
    this.point = null;
    this.observed.clear();
    this.notice(); this.changed(); this.render();
  }

  removeAnchor() {
    const sensor = this.sensor;
    if (!sensor) return;
    sensor.anchors.pop();
    if (!sensor.anchors.length && !sensor.placement) this.current.sensors = this.current.sensors.filter(s => s !== sensor);
    this.observed.clear();
    this.changed();
    this.render();
  }

  removePlacement() {
    const sensor = this.sensor;
    if (!sensor?.placement) return;
    delete sensor.placement;
    if (!sensor.anchors.length) this.current.sensors = this.current.sensors.filter(s => s !== sensor);
    this.observed.clear();
    this.notice('Label placement removed.');
    this.changed(); this.render();
  }

  setMirror(value) {
    if (!this.sensor) return;
    this.sensor.mirrored = value;
    this.observed.clear();
    this.changed();
  }

  async sendProfile() {
    const room = this.room;
    const entryId = this.sensorId;
    if (!room || !this.readyToReview(this.fit)) return;
    try {
      const saved = await this.sensorRequest('profile');
      if (this.sensorId !== entryId || this.room !== room || this.pane !== 'sensors') return;
      const fit = this.fit;
      if (!this.readyToReview(fit)) return;
      const profile = calibrationFromPlan(room, fit, saved.profile);
      if (!profile) { this.notice('This room extends beyond the sensor’s coordinate range.', true); return; }
      await this.stopRadar();
      this.dispatchEvent(new CustomEvent('floorplan-calibration', {bubbles: true, composed: true, detail: {entryId, profile}}));
    } catch (error) { this.notice(errorText(error), true); }
  }

  readyToReview(fit) {
    return fit?.source === 'walked' && fit.rmsMm <= 600 && this.entries.some(e => e.entry_id === this.sensorId);
  }

  coverage(fit) {
    if (!this.estimate) {
      const outline = coverageOutline(this.current.rooms, fit);
      this.estimate = {outline, rooms: visibleRegions(this.current.rooms, outline)};
    }
    return this.estimate;
  }

  refreshControls() {
    const configured = this.entries.some(e => e.entry_id === this.sensorId);
    this.$('new-plan').disabled = !this.loaded || this.saving;
    this.$('save-plan').disabled = !this.dirty || this.saving || !this.current?.name.trim();
    this.$('revert-plan').disabled = !this.dirty || this.saving;
    this.$('radar-start').disabled = Boolean(this.radar || this.radarOpening || !configured);
    this.$('download-label').disabled = !configured || this.labelPending;
    this.$('label-actions').hidden = !this.sensor?.placement;
    this.$('radar-stop').disabled = !this.radar && !this.radarOpening;
    if (this.radar && this.frame?.healthy && (this.frame.age_ms === null || performance.now() - this.frame.time + this.frame.age_ms > 1600)) {
      this.$('radar-status').textContent = 'Live radar readings are stale.';
    }
    const fit = this.fit;
    const dot = this.pane === 'sensors' && this.point ? this.currentDot() : null;
    const anchorReady = Boolean(dot && (this.sensor?.anchors.length ?? 0) < 8);
    this.$('anchor').disabled = !anchorReady;
    this.$('anchor-back').disabled = !this.sensor?.anchors.length;
    this.$('scan-pin').disabled = !this.point || !this.scans.some(s => s.id === this.scanId);
    this.$('map-actions').hidden = this.pane === 'layout';
    this.$('anchor').hidden = this.pane !== 'sensors';
    this.$('scan-pin').hidden = this.pane !== 'wifi';
    const label = this.$('map-action-label');
    if (this.pane === 'wifi') label.textContent = this.scans.find(s => s.id === this.scanId)?.name ?? '';
    else if (dot && fit) label.textContent = `${fit.source === 'label' ? 'Approx. ' : ''}${Math.round(distance(planPoint(fit, dot), this.point))} mm from marked point`;
    else if (dot) label.textContent = 'Ready to capture';
    else label.textContent = this.point ? 'Waiting for a steady dot' : 'Tap a known point to begin';
    this.$('draw-finish').disabled = (this.shape?.points.length ?? 0) < 3;
    this.$('draw-back').disabled = !this.shape?.points.length;
    this.$('send-profile').disabled = !this.room || !this.readyToReview(fit);
    const count = this.sensor?.anchors.length ?? 0;
    this.$('alignment').textContent = fit?.source === 'walked' ?
      `Walked alignment · ${count} anchors · ${Math.round(fit.rmsMm)} mm fit error${fit.rmsMm > 600 ? ' · check anchor placement' : ''}` :
      fit?.source === 'label' ? `QR label estimate · Heading ${headingText(this.sensor.placement.heading_mdeg)} · Two walked anchors needed for calibration` :
        `${count} anchors · two separated points needed`;
    if (this.pane === 'sensors' && this.current && fit) {
      const {rooms} = this.coverage(fit);
      const estimated = new Set(rooms.flatMap(room => [room.id, ...room.features.map(feature => feature.id)]));
      const status = fit.source === 'label' ? ' · detection near QR estimate' : ' · observed';
      this.$('visible').replaceChildren(...rooms.map(room => {
        const item = document.createElement('li');
        item.textContent = room.name + (this.observed.has(room.id) ? status : '');
        if (room.features.length) {
          const list = document.createElement('ul');
          list.append(...room.features.map(feature => {
            const node = document.createElement('li');
            node.textContent = feature.name + (this.observed.has(feature.id) ? status : '');
            return node;
          }));
          item.append(list);
        }
        return item;
      }), ...this.current.rooms.flatMap(room => [room, ...room.features])
        .filter(region => this.observed.has(region.id) && !estimated.has(region.id)).map(region => {
          const item = document.createElement('li');
          item.textContent = `${region.name} · ${fit.source === 'label' ? 'detection outside QR estimate' : 'observed outside estimate'}`;
          return item;
        }));
    } else this.$('visible').replaceChildren();
  }

  sceneBounds() {
    const points = [...(this.current?.rooms ?? []), ...this.importedRooms()].flatMap(room => room.outline);
    if (!points.length) return [-1000, 7000, -1000, 5000];
    const [l, r, b, t] = bounds(points);
    return [l - 600, r + 600, b - 600, t + 600];
  }

  changeZoom(factor) { this.zoom = Math.max(0.55, Math.min(4, this.zoom * factor)); this.draw(); }

  draw() {
    const canvas = this.$('map');
    const {width, height} = canvas.getBoundingClientRect();
    if (!this.current || width < 40 || height < 40) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const [l, r, b, t] = (this.pane === 'layout' && this.shape?.base) || this.sceneBounds();
    const center = [(l + r) / 2, (b + t) / 2];
    const scale = Math.min((width - 35) / (r - l), (height - 34) / (t - b)) * this.zoom;
    const screen = ([x, y]) => [width / 2 + (x - center[0]) * scale, height / 2 - (y - center[1]) * scale];
    this.view = {world: (x, y) => [center[0] + (x - width / 2) / scale, center[1] - (y - height / 2) / scale]};
    const step = Math.max(1000, Math.ceil(20 / (scale * 1000)) * 1000);
    const [gx, gy] = this.view.world(0, height); const [ex, ey] = this.view.world(width, 0);
    ctx.strokeStyle = '#31434c'; ctx.lineWidth = 1; ctx.font = '12px system-ui'; ctx.fillStyle = '#a8bfc8';
    ctx.beginPath();
    for (let x = Math.ceil(gx / step) * step; x <= ex; x += step) { ctx.moveTo(...screen([x, gy])); ctx.lineTo(...screen([x, ey])); }
    for (let y = Math.ceil(gy / step) * step; y <= ey; y += step) { ctx.moveTo(...screen([gx, y])); ctx.lineTo(...screen([ex, y])); }
    ctx.stroke(); ctx.fillText(`${step / 1000} m grid`, 9, height - 10);
    const trace = outline => {
      ctx.moveTo(...screen(outline[0]));
      outline.slice(1).forEach(point => ctx.lineTo(...screen(point)));
      ctx.closePath();
    };
    const polygon = (outline, border, fill, line = 1) => {
      if (!outline.length) return;
      ctx.beginPath(); trace(outline);
      ctx.strokeStyle = border; ctx.fillStyle = fill; ctx.lineWidth = line; ctx.fill(); ctx.stroke();
    };
    const dot = (point, color, radius) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(...screen(point), radius, 0, 2 * Math.PI); ctx.fill(); };
    const label = (point, text, color) => { const [x, y] = screen(point); ctx.fillStyle = color; ctx.fillText(text, x + 5, y - 4); };
    const sensorMarker = (pose, text, color) => {
      const [x, y] = screen(pose.origin);
      ctx.save();
      ctx.translate(x, y);
      ctx.transform(pose.cos, -pose.sin, pose.sin, pose.cos, 0, 0);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(5, -8); ctx.lineTo(1.5, -8);
      ctx.lineTo(1.5, 0); ctx.lineTo(-1.5, 0); ctx.lineTo(-1.5, -8); ctx.lineTo(-5, -8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      dot(pose.origin, color, 4);
      label(pose.origin, text, color);
    };
    for (const room of this.current.rooms) polygon(room.outline, room.id === this.roomId ? '#74c6b6' : '#96aeb7', '#2b404b', room.id === this.roomId ? 2 : 1);
    const wifiLayer = this.pane === 'wifi' || (this.pane === 'sensors' && this.$('also-wifi').checked);
    if (wifiLayer && this.ap) {
      const {outline, predict} = createWifiField(this.current.wifi, this.ap);
      if (outline.length >= 3) {
        ctx.save();
        ctx.beginPath(); trace(outline); ctx.clip();
        ctx.beginPath();
        for (const room of this.current.rooms) {
          trace(ringArea(room.outline) > 0 ? room.outline : room.outline.slice().reverse());
        }
        ctx.clip();
        for (let x = 0; x < width; x += 14) for (let y = 0; y < height; y += 14) {
          const signal = predict(this.view.world(x + 7, y + 7));
          if (signal === null) continue;
          const hue = Math.max(6, Math.min(148, (signal + 95) * 2.7));
          ctx.fillStyle = `hsla(${hue},78%,49%,.52)`; ctx.fillRect(x, y, 14, 14);
        }
        ctx.restore();
      }
    }
    const fit = this.fit;
    if (this.pane === 'sensors' && fit) {
      if (fit.source === 'label') polygon(this.coverage(fit).outline, '#eac484', '#eac48435');
      else polygon(this.coverage(fit).outline, '#81dcc3', '#46c3a443');
    }
    for (const room of this.current.rooms) {
      for (const feature of room.features) {
        const [, color] = FEATURES[feature.kind];
        polygon(feature.outline, color, `${color}33`, this.selectedFeature === feature.id ? 2 : 1);
        const [w, x, y, z] = bounds(feature.outline);
        if ((x - w) * scale > 25 && (z - y) * scale > 18) label(labelPoint(feature.outline), feature.name, color);
      }
      label(labelPoint(room.outline), room.name, '#eef9ff');
    }
    if (this.pane === 'sensors' && fit) {
      sensorMarker(fit, fit.source === 'label' ? 'QR sensor' : 'Sensor', fit.source === 'label' ? '#eac484' : '#8affd9');
      for (const anchor of this.sensor.anchors) dot(anchor.plan, '#efc37f', 4);
      const now = performance.now();
      if (this.frame?.healthy && this.frame.age_ms !== null && now - this.frame.time + this.frame.age_ms < 1800) {
        this.radarSamples.filter(f => now - f.time < 1900).forEach(f => f.points.forEach(point => dot(planPoint(fit, point), '#ffffff6e', 2)));
        this.frame.points.forEach(point => dot(planPoint(fit, point), '#fff', 5));
      }
    }
    for (const room of this.pane === 'layout' ? this.importedRooms() : []) {
      polygon(room.outline, '#c0e5d9', '#b9e6d322', 2);
      room.features.forEach(f => polygon(f.outline, FEATURES[f.kind][1], '#00000000'));
      label(labelPoint(room.outline), room.name, '#cce9e0');
    }
    if (this.pane === 'layout' && this.placement) {
      for (const {marker, title, reason} of this.placementReview()) {
        if (!reason) {
          const pose = fitPlanSensor({anchors: [], mirrored: false, placement: marker});
          sensorMarker(pose, title, this.placement.accepted.has(marker.entry_id) ? '#eac484' : '#b4bacb');
        }
      }
    }
    if (wifiLayer) for (const point of this.current.wifi) {
      const measured = point.signals.find(signal => signal.ap === this.ap);
      dot(point.position, measured ? '#ffdf9a' : '#c7b3e2', 4);
      if (measured) label(point.position, `${measured.rssi} dBm`, '#fff1cd');
    }
    if (this.pane === 'layout' && this.shape) {
      polygon(this.shape.points, '#7bddc8', '#4fbba636', 2);
      this.shape.points.forEach(point => dot(point, '#8cf0d9', 3));
    }
    if (this.point) dot(this.point, '#ffce8d', 6);
    canvas.classList.toggle('active', Boolean(this.shape || this.placement || this.pane !== 'layout'));
  }
}

if (!customElements.get('presence-floorplan-panel')) customElements.define('presence-floorplan-panel', FloorplanPanel);
