const API = "presence_calibration";
const ROOM = [-6000, 6000, 0, 6000];
const EMPTY_CHECK_SECONDS = 30;
const SEAT_CHECK_SECONDS = 60;
const FRESH_MS = 2000;

const REGIONS = [
  {key: "room", label: "Room", color: "#39c5b5"},
  {key: "zones", index: 0, label: "Seating", color: "#cb9afa"},
  {key: "zones", index: 1, label: "Entry", color: "#78adff"},
  {key: "exclusions", index: 0, label: "Ignore area 1", color: "#f5a569"},
  {key: "exclusions", index: 1, label: "Ignore area 2", color: "#f5a569"},
  {key: "exclusions", index: 2, label: "Ignore area 3", color: "#f5a569"},
  {key: "zones", index: 2, label: "Extra zone", color: "#b9c6cf", advanced: true},
];

const STEPS = [
  {name: "Empty room", title: "Check the room while it is empty", detail: "Step outside with your phone. Run the check to see whether the radar detects movement when nobody is inside."},
  {name: "Walk", title: "Walk the area you want to cover", detail: "Walk through the doorway, around the usable edges and past the seat. Each dot is a position the radar detected. Re-aim the sensor and repeat if it misses an important spot."},
  {name: "Draw", title: "Draw the room and optional zones", detail: "Choose an area, then drag between opposite corners on the map. Draw the room first. Add seating, entry or ignore areas inside it."},
  {name: "Test and save", title: "Check the draft against real movement", detail: "Walk in through the doorway, then walk past it from outside. Watch the preview indicators and give occupancy time to clear. For a seating check, stand by your seat before starting the timer, then sit normally."},
];

const ERRORS = {
  busy: "Another calibration session is open for this sensor.",
  session_busy: "Another calibration session is open for this sensor.",
  session_open: "Another calibration session is open for this sensor.",
  conflict: "The saved profile changed. Reopen calibration to load the current profile.",
  revision_conflict: "The saved profile changed. Reopen calibration to load the current profile.",
  no_previous: "The sensor has no previous profile to restore.",
  session_expired: "The calibration session ended. Start a new session to continue.",
  session_closed: "The calibration session ended. Start a new session to continue.",
  session_required: "The calibration session ended. Start a new session to continue.",
  offline: "Home Assistant cannot reach the sensor's calibration service.",
  unavailable: "The calibration service is unavailable. Check the sensor's power and Thread connection.",
  device_unavailable: "Home Assistant lost contact with the sensor. Check its power and Thread connection.",
  no_routed_address: "Home Assistant could not find a reachable Thread IPv6 address for this sensor.",
  certificate_mismatch: "The sensor's identity changed. Check the device and reconfigure this integration.",
  entry_unavailable: "The integration entry is unavailable. Reload it in Home Assistant and try again.",
  unsupported: "This sensor needs calibration firmware and a provisioned setup code.",
  invalid_code: "The stored calibration code was rejected. Reconfigure this integration with the code from the setup card.",
  invalid_request: "The sensor could not read these settings. Reopen calibration and try again.",
  invalid_profile: "The sensor rejected these bounds. Check the room and any areas inside it.",
  unauthorized: "The calibration code was rejected. Check the integration's setup code.",
  connection_lost: "The connection was interrupted. Check the saved profile before retrying a save.",
  request_uncertain: "The response was interrupted. Check the saved profile before retrying a save.",
};

const clone = value => JSON.parse(JSON.stringify(value));
const regionFor = (profile, region) => region.key === "room" ? profile.room : profile[region.key][region.index];

function setRegion(profile, region, rect) {
  if (region.key === "room") profile.room = rect;
  else profile[region.key][region.index] = rect;
}

export function normalizeRectangle(a, b) {
  return [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
}

export function profileError(profile) {
  const valid = r => Array.isArray(r) && r.length === 4 &&
    r.every(n => Number.isInteger(n) && n >= -32768 && n <= 32767) && r[0] < r[1] && r[2] < r[3];
  if (!valid(profile.room)) return "Draw a room with a positive width and depth.";
  const [left, right, near, far] = profile.room;
  for (const region of REGIONS.slice(1)) {
    const r = regionFor(profile, region);
    if (r === null) continue;
    if (!valid(r) || r[0] < left || r[1] > right || r[2] < near || r[3] > far) {
      return `${region.label} must fit inside the room. Redraw or clear it.`;
    }
  }
  return "";
}

export function mapTransform(width, height, bounds) {
  const [left, right, near, far] = bounds;
  const scale = Math.min((width - 28) / (right - left), (height - 36) / (far - near));
  const x0 = (width - (right - left) * scale) / 2;
  const y0 = (height - (far - near) * scale) / 2;
  return {
    pixel(x, y) { return [x0 + (x - left) * scale, y0 + (far - y) * scale]; },
    position(x, y) {
      const snap = n => Math.round(n / 50) * 50;
      const clamp = (n, min, max) => Math.max(min, Math.min(max, snap(n)));
      return [clamp(left + (x - x0) / scale, left, right), clamp(far - (y - y0) / scale, near, far)];
    },
  };
}

function labelForError(error) {
  const code = typeof error === "string" ? error : error?.code;
  return ERRORS[code] || "Calibration could not continue. Check the sensor and try again.";
}

const template = `
<style>
  :host {
    display: block;
    min-height: 100%;
    background: var(--primary-background-color, #f1f4f5);
    color: var(--primary-text-color, #202d32);
    font: 400 15px/1.5 var(--primary-font-family, system-ui, sans-serif);
    --panel-border: var(--divider-color, #d8e1e4);
    --panel-card: var(--card-background-color, #fff);
    --panel-muted: var(--secondary-text-color, #50646b);
    --panel-accent: #116a60;
  }
  * { box-sizing: border-box; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: var(--app-header-background-color, var(--panel-card)); border-bottom: 1px solid var(--panel-border); }
  header h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.015em; }
  ha-menu-button { flex: none; }
  main { max-width: 1120px; margin: auto; padding: 24px 20px 42px; }
  h2 { font-size: 23px; letter-spacing: -.025em; line-height: 1.2; margin: 0 0 10px; }
  h3 { font-size: 15px; margin: 0; }
  p { margin: 0 0 12px; }
  p:last-child { margin-bottom: 0; }
  .muted { color: var(--panel-muted); }
  .card { padding: 20px; border: 1px solid var(--panel-border); border-radius: 14px; background: var(--panel-card); }
  .connect { max-width: 560px; }
  label { display: block; margin-bottom: 5px; font-weight: 550; }
  select, input { min-height: 42px; padding: 7px 10px; font: inherit; color: inherit; background: var(--panel-card); border: 1px solid var(--panel-border); border-radius: 7px; }
  select { width: 100%; }
  button, a.action { min-height: 42px; padding: 7px 14px; font: inherit; font-weight: 600; border: 1px solid var(--panel-border); border-radius: 8px; background: var(--panel-card); color: inherit; cursor: pointer; }
  a.action { display: inline-flex; align-items: center; text-decoration: none; }
  button:disabled { cursor: default; opacity: .48; }
  button.primary { background: var(--panel-accent); border-color: var(--panel-accent); color: #fff; }
  button:focus-visible, a:focus-visible, canvas:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid #4398d3; outline-offset: 2px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .controls { display: flex; justify-content: space-between; gap: 12px; margin-top: 16px; }
  .connect .row { margin-top: 12px; }
  .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
  .steps button { font-size: 14px; padding: 6px; font-weight: 550; }
  .steps [aria-current="step"] { background: var(--panel-accent); border-color: var(--panel-accent); color: #fff; }
  .session-header { display: flex; gap: 12px; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .session-header h2 { margin: 0; }
  .layout { display: grid; grid-template-columns: minmax(0, 1.48fr) minmax(275px, 1fr); gap: 16px; align-items: start; }
  .map-card { padding: 0; overflow: hidden; }
  .map-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; }
  .health { color: var(--panel-muted); font-size: 13px; }
  .health.good { color: var(--success-color, #17775d); }
  .health.bad { color: var(--error-color, #bb4437); }
  canvas { display: block; width: 100%; height: clamp(245px, 39vw, 430px); background: #13262c; }
  canvas.drawing { touch-action: none; cursor: crosshair; }
  .readings { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 12px 16px; gap: 8px; }
  .readings div { min-width: 0; }
  .readings span { display: block; font-size: 12px; color: var(--panel-muted); }
  .readings strong { font-weight: 650; font-size: 14px; overflow-wrap: break-word; }
  .notice { margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid var(--panel-accent); background: var(--panel-card); border-radius: 5px; }
  .notice.error { border-left-color: var(--error-color, #bb4437); }
  .region-fields, .test-fields { margin-top: 12px; }
  .region-fields .row, .test-fields .row { margin-top: 8px; }
  .result { margin-top: 10px; }
  details { margin-top: 12px; }
  summary { cursor: pointer; color: var(--panel-muted); }
  .coordinates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .coordinates label { font-size: 13px; }
  .coordinates input { width: 100%; }
  small { display: block; color: var(--panel-muted); margin-top: 6px; }
  [hidden] { display: none !important; }
  @media (max-width: 720px) {
    main { padding: 14px 12px 24px; }
    .card { padding: 15px; }
    .layout { grid-template-columns: 1fr; gap: 10px; }
    .map-card { padding: 0; }
    .map-header { padding: 10px 12px; }
    .readings { padding: 8px 12px; }
    .steps button { font-size: 13px; }
  }
</style>
<header><ha-menu-button></ha-menu-button><h1>Presence Calibration</h1></header>
<main>
  <p id="notice" class="notice" role="status" hidden></p>
  <section id="connect" class="card connect">
    <h2>Choose your sensor</h2>
    <p class="muted">Calibrate a commissioned sensor from your phone.</p>
    <div id="choose" hidden>
      <label for="device">Presence sensor</label><select id="device"></select>
      <div class="row"><button id="open" class="primary">Start calibration</button></div>
    </div>
    <div id="install" hidden>
      <p>Add the Presence Calibration integration, select your Matter sensor and enter the calibration code from its setup card.</p>
      <a class="action" href="/config/integrations">Open integrations</a>
    </div>
    <p id="loading" class="muted">Looking for sensors…</p>
  </section>
  <section id="session" hidden>
    <div class="session-header"><h2 id="sensor-title"></h2><button id="close">Exit</button></div>
    <nav class="steps" aria-label="Calibration steps"></nav>
    <div class="layout">
      <section class="card map-card" aria-labelledby="map-heading">
        <div class="map-header"><h3 id="map-heading">Radar view</h3><span id="health" class="health" role="status">Waiting for radar</span></div>
        <canvas id="map" aria-label="Top-down radar view. Use precise bounds below as an alternative to drawing."></canvas>
        <div class="readings" aria-label="Draft occupancy preview">
          <div><span>Room</span><strong id="room-state">—</strong></div>
          <div><span>Motion</span><strong id="motion-state">—</strong></div>
          <div><span>Seating</span><strong id="seat-state">—</strong></div>
          <div><span>Entry</span><strong id="entry-state">—</strong></div>
        </div>
      </section>
      <section class="card step-card" aria-labelledby="step-title">
        <h2 id="step-title"></h2><p id="step-detail" class="muted"></p>
        <div id="empty-fields" hidden>
          <button id="empty-check">Start 30-second check</button>
          <p id="empty-result" class="result" role="status"></p>
        </div>
        <div id="walk-fields" hidden><button id="reset-walk">Clear walk trace</button></div>
        <div id="region-fields" class="region-fields" hidden>
          <label for="region">Area to draw</label><select id="region"></select>
          <div class="row"><button id="clear-region">Clear area</button><button id="reset-draft">Reset draft</button></div>
          <details>
            <summary>Precise bounds</summary>
            <div class="coordinates">
              <label>Left edge (m)<input type="number" step="0.05" data-bound="0"></label>
              <label>Right edge (m)<input type="number" step="0.05" data-bound="1"></label>
              <label>Near edge (m)<input type="number" step="0.05" data-bound="2"></label>
              <label>Far edge (m)<input type="number" step="0.05" data-bound="3"></label>
            </div>
            <button id="apply-bounds">Use these bounds</button>
          </details>
          <p id="bounds-error" class="result" role="status"></p>
        </div>
        <div id="test-fields" class="test-fields" hidden>
          <div class="row"><button id="seat-check">Start 1-minute seated check</button></div>
          <p id="seat-result" class="result" role="status"></p>
          <p id="test-summary" class="result" role="status"></p>
          <div class="row"><button id="save" class="primary">Save to sensor</button><button id="undo" hidden>Undo</button></div>
        </div>
        <div class="controls"><button id="back">Back</button><button id="next" class="primary">Next</button></div>
      </section>
    </div>
  </section>
</main>`;

class PresenceCalibrationPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: "open"}).innerHTML = template;
    this.$ = id => this.shadowRoot.getElementById(id);
    this.entries = [];
    this.step = 0;
    this.regionIndex = 0;
    this.generation = 0;
    this.trail = [];
    this.walkTrace = new Map();
    this.draftQueue = Promise.resolve();
    this.resize = new ResizeObserver(() => this.draw());
    STEPS.forEach((step, index) => {
      const button = document.createElement("button");
      button.textContent = step.name;
      button.onclick = () => this.setStep(index);
      this.shadowRoot.querySelector("nav").append(button);
    });
    REGIONS.forEach((region, index) => {
      this.$("region").add(new Option(region.label, String(index)));
    });
    const handlers = {
      open: () => this.open(), close: () => this.close(),
      "empty-check": () => this.startCheck("empty", EMPTY_CHECK_SECONDS),
      "seat-check": () => this.startCheck("seat", SEAT_CHECK_SECONDS),
      "reset-walk": () => { this.walkTrace.clear(); this.trail = []; this.draw(); },
      "clear-region": () => this.changeRegion(null),
      "reset-draft": () => this.setDraft(clone(this.saved.profile)),
      "apply-bounds": () => this.applyBounds(),
      save: () => this.commit("save"), undo: () => this.commit("undo"),
      back: () => this.setStep(this.step - 1), next: () => this.setStep(this.step + 1),
    };
    for (const [id, handler] of Object.entries(handlers)) this.$(id).onclick = handler;
    this.$("region").onchange = () => {
      this.regionIndex = Number(this.$("region").value);
      this.updateRegion();
      this.draw();
    };
    const map = this.$("map");
    map.onpointerdown = event => this.beginDraw(event);
    map.onpointermove = event => this.moveDraw(event);
    map.onpointerup = event => this.endDraw(event);
    map.onpointercancel = () => { this.drag = null; this.draw(); };
  }

  set hass(value) {
    this._hass = value;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    menu.hass = value;
    if (this.isConnected && value?.connection !== this.connection) {
      this.close({quiet: true});
      this.connection = value?.connection;
      if (this.connection) this.loadEntries();
    }
  }

  set narrow(value) { this.shadowRoot.querySelector("ha-menu-button").narrow = value; }

  connectedCallback() {
    this.resize.observe(this.$("map"));
    if (this._hass?.connection) {
      this.connection = this._hass.connection;
      this.loadEntries();
    }
  }

  disconnectedCallback() {
    this.resize.disconnect();
    this.close({quiet: true});
  }

  notice(text = "", isError = false, source = "action") {
    const notice = this.$("notice");
    this.noticeSource = text ? source : null;
    notice.textContent = text;
    notice.hidden = !text;
    notice.classList.toggle("error", isError);
  }

  async loadEntries() {
    const connection = this.connection;
    const generation = this.generation;
    this.$("loading").hidden = false;
    this.$("choose").hidden = this.$("install").hidden = true;
    try {
      const {entries} = await connection.sendMessagePromise({type: `${API}/status`});
      if (!this.isConnected || this.connection !== connection || generation !== this.generation) return;
      this.entries = entries;
      this.$("device").replaceChildren(...entries.map(entry => new Option(entry.title, entry.entry_id)));
      this.$("choose").hidden = !entries.length;
      this.$("install").hidden = Boolean(entries.length);
    } catch (error) {
      if (this.connection === connection) this.notice(labelForError(error), true);
    } finally {
      if (this.connection === connection) this.$("loading").hidden = true;
    }
  }

  request(action, payload, entry = this.entry, connection = this.connection) {
    const command = {type: `${API}/request`, entry_id: entry.entry_id, action};
    if (payload !== undefined) command.payload = payload;
    return connection.sendMessagePromise(command);
  }

  async open() {
    const entry = this.entries.find(item => item.entry_id === this.$("device").value);
    if (!entry || this.opening || this.closing) return;
    const connection = this.connection;
    const generation = ++this.generation;
    this.opening = true;
    this.$("open").disabled = true;
    this.notice("Connecting to the sensor…");
    try {
      const saved = await this.request("open", undefined, entry, connection);
      if (generation !== this.generation) {
        await this.request("close", undefined, entry, connection).catch(() => {});
        return;
      }
      this.entry = entry;
      this.saved = saved;
      this.draft = clone(saved.profile);
      this.lastDraft = JSON.stringify(this.draft);
      this.regionIndex = 0;
      this.$("region").value = "0";
      this.preview = null;
      this.trail = [];
      this.walkTrace.clear();
      this.$("seat-result").textContent = this.$("empty-result").textContent = "";
      this.$("sensor-title").textContent = entry.title;
      const unsubscribe = await connection.subscribeMessage(frame => {
        if (generation === this.generation) this.receive(frame);
      }, {type: `${API}/subscribe`, entry_id: entry.entry_id});
      if (generation !== this.generation) {
        await unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
      this.$("connect").hidden = true;
      this.$("session").hidden = false;
      this.notice();
      this.setStep(0);
      this.tick = setInterval(() => this.refresh(), 500);
    } catch (error) {
      if (generation === this.generation) {
        await this.close({quiet: true});
        this.notice(labelForError(error), true);
      }
    } finally {
      this.opening = false;
      this.$("open").disabled = false;
    }
  }

  async close({quiet = false} = {}) {
    this.generation++;
    const entry = this.entry;
    const connection = this.connection;
    const unsubscribe = this.unsubscribe;
    this.entry = this.unsubscribe = this.preview = this.drag = this.check = null;
    this.walkTrace.clear();
    this.trail = [];
    clearInterval(this.tick);
    this.$("session").hidden = true;
    this.$("connect").hidden = false;
    if (!quiet) this.notice();
    if (!entry && !unsubscribe) return;
    this.closing = true;
    this.$("open").disabled = true;
    try {
      if (entry) await this.request("close", undefined, entry, connection).catch(() => {});
      if (unsubscribe) await Promise.resolve(unsubscribe()).catch(() => {});
    } finally {
      this.closing = false;
      this.$("open").disabled = this.opening;
    }
  }

  setStep(index) {
    if (!this.entry || index < 0 || index >= STEPS.length) return;
    this.step = index;
    this.drag = null;
    if (this.check && ((this.check.kind === "empty" && index !== 0) || (this.check.kind === "seat" && index !== 3))) {
      this.$(`${this.check.kind}-result`).textContent = "Check stopped. You can run it again.";
      this.check = null;
    }
    this.$("step-title").textContent = STEPS[index].title;
    this.$("step-detail").textContent = STEPS[index].detail;
    Array.from(this.shadowRoot.querySelector("nav").children).forEach((button, i) => {
      if (i === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    this.$("empty-fields").hidden = index !== 0;
    this.$("walk-fields").hidden = index !== 1;
    this.$("region-fields").hidden = index !== 2;
    this.$("test-fields").hidden = index !== 3;
    this.$("map").classList.toggle("drawing", index === 2);
    this.$("back").disabled = index === 0;
    this.$("next").hidden = index === 3;
    this.updateRegion();
    this.refresh();
  }

  updateRegion() {
    if (!this.draft) return;
    const region = REGIONS[this.regionIndex];
    const current = regionFor(this.draft, region);
    REGIONS.forEach((item, index) => {
      if (item.advanced) this.$("region").options[index].hidden = !regionFor(this.draft, item) && this.regionIndex !== index;
    });
    this.$("clear-region").disabled = region.key === "room" || !current;
    this.shadowRoot.querySelectorAll("[data-bound]").forEach((input, i) => {
      input.value = current ? current[i] / 1000 : "";
    });
    this.$("bounds-error").textContent = profileError(this.draft);
  }

  applyBounds() {
    const inputs = Array.from(this.shadowRoot.querySelectorAll("[data-bound]"));
    if (inputs.some(input => !input.value || !Number.isFinite(input.valueAsNumber))) {
      this.$("bounds-error").textContent = "Enter all four bounds in meters.";
      return;
    }
    this.changeRegion(inputs.map(input => Math.round(input.valueAsNumber * 1000)));
  }

  changeRegion(rect) {
    if (rect && (rect[0] >= rect[1] || rect[2] >= rect[3])) {
      this.$("bounds-error").textContent = "Drag between two opposite corners.";
      return;
    }
    const update = clone(this.draft);
    setRegion(update, REGIONS[this.regionIndex], rect);
    this.setDraft(update);
  }

  setDraft(profile) {
    this.draft = profile;
    this.updateRegion();
    this.refresh();
    if (profileError(profile)) return;
    const generation = this.generation;
    const serialized = JSON.stringify(profile);
    this.draftQueue = this.draftQueue.catch(() => {}).then(async () => {
      if (generation !== this.generation || this.lastDraft === serialized || serialized !== JSON.stringify(this.draft)) return;
      try {
        await this.request("draft", {profile});
        if (generation === this.generation) {
          this.preview = null;
          this.lastDraft = serialized;
          this.notice();
        }
      } catch (error) {
        if (generation === this.generation) this.notice(labelForError(error), true);
      }
    }).finally(() => { if (generation === this.generation) this.refresh(); });
  }

  async commit(action) {
    if (!this.entry || this.committing || (action === "save" && profileError(this.draft))) return;
    this.committing = true;
    this.refresh();
    const generation = this.generation;
    const expected = this.saved.revision;
    const requested = clone(this.draft);
    const payload = {expected_revision: expected};
    if (action === "save") payload.profile = requested;
    try {
      await this.draftQueue;
      if (generation !== this.generation) return;
      this.applySaved(await this.request(action, payload), action, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      try {
        const actual = await this.request("profile");
        if (generation !== this.generation) return;
        if (actual.revision !== expected) {
          this.applySaved(actual, null, generation);
          this.lastDraft = null;
          this.setDraft(clone(actual.profile));
          this.notice("The saved profile changed. The panel reloaded the profile from the sensor.");
          return;
        }
      } catch {
        if (generation === this.generation) this.notice("The response was lost. Reopen calibration to check the saved profile.", true);
        return;
      }
      this.notice(labelForError(error), true);
    } finally {
      this.committing = false;
      if (generation === this.generation) this.refresh();
    }
  }

  applySaved(envelope, action, generation) {
    if (generation !== this.generation) return;
    this.saved = envelope;
    this.draft = clone(envelope.profile);
    this.lastDraft = JSON.stringify(this.draft);
    this.preview = null;
    this.updateRegion();
    if (action) this.notice(action === "save" ? "Calibration saved to the sensor." : "Previous calibration restored.");
    this.refresh();
  }

  receive(frame) {
    if (frame.error) {
      this.preview = null;
      this.notice(labelForError(frame.error), true, "preview");
      this.refresh();
      return;
    }
    const changed = this.preview?.sequence !== frame.sequence;
    frame.receivedAt = performance.now();
    this.preview = frame;
    if (this.noticeSource === "preview" && this.fresh()) this.notice();
    if (this.fresh() && changed) {
      for (const point of frame.points) this.trail.push({point, time: frame.receivedAt});
      if (this.step === 1) {
        for (const point of frame.points) {
          const cell = point.map(coordinate => Math.round(coordinate / 150)).join(",");
          if (!this.walkTrace.has(cell) && this.walkTrace.size >= 300) {
            this.walkTrace.delete(this.walkTrace.keys().next().value);
          }
          this.walkTrace.set(cell, point);
        }
      }
      if (this.check) {
        this.check.samples++;
        this.check.lastSample = frame.receivedAt;
        if (this.check.kind === "empty" && frame.points.length) this.check.positive++;
        if (this.check.kind === "seat" && !(frame.occupied && frame.zones[0])) this.check.positive++;
      }
    }
    this.refresh();
  }

  fresh() {
    const frame = this.preview;
    return Boolean(frame?.healthy && frame.age_ms !== null &&
      frame.age_ms + performance.now() - frame.receivedAt < FRESH_MS);
  }

  startCheck(kind, seconds) {
    if (!this.fresh() || this.check) return;
    if (kind === "seat" && (!this.draft.zones[0] || !this.preview.zones[0])) {
      this.$("seat-result").textContent = "Stand in the seating zone until its preview is occupied, then start the check.";
      return;
    }
    this.check = {kind, seconds, start: performance.now(), lastSample: performance.now(), samples: 0, positive: 0};
    this.refresh();
  }

  updateCheck() {
    if (!this.check) return;
    const {kind, seconds, start, lastSample, samples, positive} = this.check;
    const result = this.$(`${kind}-result`);
    const now = performance.now();
    const left = Math.max(0, Math.ceil(seconds - (now - start) / 1000));
    if (!this.fresh() || now - lastSample > FRESH_MS) {
      result.textContent = "The live view was interrupted. Repeat this check when the radar is available.";
    } else if (left) {
      result.textContent = `${left} seconds remaining`;
      return;
    } else if (!samples) {
      result.textContent = "No fresh sample arrived. Repeat this check.";
    } else if (kind === "empty") {
      result.textContent = positive ? "The radar saw movement. Use the map to see where it came from." : "No movement detected during the check.";
    } else {
      result.textContent = positive ? "Seated presence unverified. Re-aim and retry, or clear Seating." : "Seating stayed occupied for one minute.";
    }
    this.check = null;
  }

  refresh() {
    if (!this.entry) return;
    this.updateCheck();
    const fresh = this.fresh();
    const health = this.$("health");
    const text = fresh ? "Radar live" : this.preview && !this.preview.healthy ? "Radar stopped reporting" : "Waiting for live radar";
    if (health.textContent !== text) health.textContent = text;
    health.className = `health ${fresh ? "good" : this.preview ? "bad" : ""}`;
    const matching = fresh && this.lastDraft === JSON.stringify(this.draft);
    const validation = profileError(this.draft);
    const active = (value, yes, no) => matching ? (value ? yes : no) : "—";
    this.$("room-state").textContent = active(this.preview?.occupied, "Occupied", "Clear");
    this.$("motion-state").textContent = active(this.preview?.motion, "Moving", "Still");
    this.$("seat-state").textContent = this.draft.zones[0] ? active(this.preview?.zones[0], "Occupied", "Clear") : "Off";
    this.$("entry-state").textContent = this.draft.zones[1] ? active(this.preview?.zones[1], "Occupied", "Clear") : "Off";
    this.$("empty-check").disabled = !fresh || Boolean(this.check);
    this.$("seat-check").disabled = !matching || !this.draft.zones[0] || Boolean(this.check);
    this.$("test-summary").textContent = validation || (matching ? "" : "Waiting for the current draft preview.");
    this.$("save").disabled = this.committing || Boolean(validation) || !matching || JSON.stringify(this.saved.profile) === this.lastDraft;
    this.$("undo").hidden = !this.saved.can_undo;
    this.$("undo").disabled = this.committing || !fresh;
    this.draw();
  }

  bounds() {
    const [left, right, near, far] = this.draft?.room ?? ROOM;
    return [Math.min(left, ROOM[0]), Math.max(right, ROOM[1]), Math.min(near, ROOM[2]), Math.max(far, ROOM[3])];
  }

  draw() {
    const canvas = this.$("map");
    const {width, height} = canvas.getBoundingClientRect();
    if (width < 40 || height < 40) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const bounds = this.drag?.bounds ?? this.bounds();
    const m = mapTransform(width, height, bounds);
    const [left, right, near, far] = bounds;
    const grid = Math.max(1000, Math.ceil((right - left) / 16000) * 1000);
    ctx.font = "11px system-ui";
    ctx.strokeStyle = "#385158";
    ctx.fillStyle = "#b9d0d4";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(left / grid) * grid; x <= right; x += grid) {
      ctx.moveTo(...m.pixel(x, near)); ctx.lineTo(...m.pixel(x, far));
    }
    for (let y = Math.ceil(near / grid) * grid; y <= far; y += grid) {
      const [x0, y0] = m.pixel(left, y);
      ctx.moveTo(x0, y0); ctx.lineTo(...m.pixel(right, y));
      if (y > near) ctx.fillText(`${y / 1000} m`, x0 + 4, y0 - 3);
    }
    ctx.stroke();
    const rect = (r, color, label, selected, dashed) => {
      const [x0, y0] = m.pixel(r[0], r[3]);
      const [x1, y1] = m.pixel(r[1], r[2]);
      ctx.fillStyle = `${color}${selected ? "32" : "1a"}`;
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      if (x1 - x0 > 44 && y1 - y0 > 18) {
        ctx.fillStyle = color;
        ctx.fillText(label, x0 + 6, y0 + 14, x1 - x0 - 10);
      }
    };
    if (this.draft) REGIONS.forEach((region, i) => {
      const r = regionFor(this.draft, region);
      if (r) rect(r, region.color, region.label, this.step === 2 && this.regionIndex === i, region.key === "exclusions");
    });
    if (this.drag?.end) {
      const region = REGIONS[this.regionIndex];
      rect(normalizeRectangle(this.drag.start, this.drag.end), region.color, region.label, true, true);
    }
    if (this.step === 1 || this.step === 2) {
      ctx.fillStyle = "#688f93";
      for (const point of this.walkTrace.values()) {
        const [x, y] = m.pixel(...point);
        ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.fill();
      }
    }
    this.trail = this.trail.filter(sample => performance.now() - sample.time < 4500);
    if (this.fresh()) {
      for (const sample of this.trail) {
        const [x, y] = m.pixel(...sample.point);
        ctx.fillStyle = "#e3f5f7";
        ctx.globalAlpha = 0.15 + 0.55 * (1 - (performance.now() - sample.time) / 4800);
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const point of this.preview.points) {
        const [x, y] = m.pixel(...point);
        ctx.fillStyle = "#f5fffc";
        ctx.strokeStyle = "#5dd7bf";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
    }
    const [sx, sy] = m.pixel(0, 0);
    ctx.fillStyle = "#d4f6ed";
    ctx.beginPath(); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx - 6, sy + 3); ctx.lineTo(sx + 6, sy + 3); ctx.fill();
    ctx.fillText("Sensor", sx + 10, sy + 5);
  }

  eventPosition(event, bounds) {
    const area = this.$("map").getBoundingClientRect();
    return mapTransform(area.width, area.height, bounds).position(event.clientX - area.left, event.clientY - area.top);
  }

  beginDraw(event) {
    if (this.step !== 2 || this.committing || (event.pointerType === "mouse" && event.button !== 0)) return;
    const bounds = this.bounds();
    this.drag = {bounds, start: this.eventPosition(event, bounds), end: null, pointer: event.pointerId};
    this.$("map").setPointerCapture(event.pointerId);
  }

  moveDraw(event) {
    if (this.drag?.pointer !== event.pointerId) return;
    this.drag.end = this.eventPosition(event, this.drag.bounds);
    this.draw();
  }

  endDraw(event) {
    if (this.drag?.pointer !== event.pointerId) return;
    const {start, bounds} = this.drag;
    this.drag = null;
    this.changeRegion(normalizeRectangle(start, this.eventPosition(event, bounds)));
    this.draw();
  }
}

if (!customElements.get("presence-calibration-panel")) customElements.define("presence-calibration-panel", PresenceCalibrationPanel);
