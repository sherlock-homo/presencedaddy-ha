const API = 'presence_calibration';
const DISPLAY_FIELDS = ['show_occupancy', 'show_clock', 'show_sensor', 'log_enabled'];
const DISPLAY_PREFERENCES = {orientation:['horizontal', 'vertical'], mode:['eyes', 'dashboard']};
const ERRORS = {
  unsupported_feature: 'This firmware does not offer this feature.',
  entry_unavailable: 'The sensor integration is unavailable.',
  device_unavailable: 'Home Assistant could not reach the sensor.',
  training_busy: 'Another training session is open.',
  training_not_owned: 'This training session has ended.',
  invalid_training: 'Confirm consent and select a training type.',
  invalid_person: 'Enter a name of 1 to 32 characters.',
  person_not_enrolled: 'Enroll this person on this sensor first.',
  separate_validation_day: 'Use a day with no enrollment for validation, and vice versa.',
  insufficient_movement: 'There was no continuous, fresh single-person movement to save.',
  no_ambiguous_track: 'This session did not contain an overlapping or ambiguous radar track.',
  training_overlap: 'More than one track appeared. Repeat this session with one person in view.',
  training_restarted: 'The sensor rebooted during this session. Discard and try again.',
  training_track_changed: 'The radar lost the original track. Discard and record a new session.',
  training_duplicate: 'A saved session already uses this part of the recording.',
  invalid_sd_clip: 'The selected SD recording clip could not be read.',
  ambiguous_sd_clip: 'Choose a segment with the same person alone throughout the clip.',
  sd_clip_date: 'Validation needs a trusted clock time on one day. For an enrollment clip without a clock, enter its date.',
  validation_required: 'This sensor still needs to pass held-out validation.',
  invalid_entities: 'Choose up to four distinct Home Assistant entities.',
  invalid_display: 'Choose valid LCD settings and try again.',
  invalid_link: 'Choose a different sensor that covers the same doorway.',
  feature_storage_failed: 'Home Assistant could not save this change.',
  request_uncertain: 'The connection dropped. Refresh the settings before retrying.',
};

const template = `
<style>
  :host { display:block; color:var(--primary-text-color,#202d32); }
  * { box-sizing:border-box; }
  main { max-width:1120px; margin:auto; padding:24px 20px 42px; }
  h2,h3,p { margin:0 0 10px; }
  h2 { font-size:23px; }
  h3 { font-size:18px; }
  .muted,small { color:var(--secondary-text-color,#50646b); }
  .layout { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:start; }
  section { background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#d8e1e4); border-radius:14px; padding:18px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0 12px; }
  label { display:block; font-weight:550; margin:7px 0; }
  label.check { display:flex; align-items:center; gap:8px; }
  input[type=checkbox] { accent-color:#116a60; width:18px; height:18px; }
  input:not([type=checkbox]), select, button { background:var(--card-background-color,#fff); color:inherit; border:1px solid var(--divider-color,#d8e1e4); border-radius:8px; padding:8px; font:inherit; min-height:42px; }
  input:not([type=checkbox]), select { width:100%; }
  #device { max-width:480px; margin-bottom:15px; }
  button { cursor:pointer; font-weight:650; }
  button.primary { background:#116a60; color:white; }
  button:disabled { opacity:.45; cursor:default; }
  :focus-visible { outline:3px solid #4398d3; outline-offset:2px; }
  details { margin-top:16px; }
  summary { cursor:pointer; font-weight:600; }
  output { display:block; min-height:24px; margin:6px 0; }
  .error { color:var(--error-color,#bb4437); }
  .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:12px 0; }
  .metrics div { background:var(--secondary-background-color,#eef3f4); padding:8px; border-radius:8px; }
  .metrics span { display:block; color:var(--secondary-text-color,#50646b); font-size:13px; }
  [hidden] { display:none !important; }
  @media (max-width:720px) { main { padding:14px 12px 24px; } .layout { grid-template-columns:1fr; } section { padding:14px; } }
</style>
<main>
  <h2>Device tools</h2>
  <label for="device">Presence sensor</label><select id="device"></select>
  <div class="row" id="recalibrate-row" hidden><button id="recalibrate">Recalibrate sensor</button></div>
  <p id="empty" class="muted" hidden>Add your sensor in the Presence Calibration integration first.</p>
  <output id="notice" role="status"></output>
  <div class="layout" id="tools" hidden>
    <section aria-labelledby="lcd-heading">
      <h3 id="lcd-heading">LCD</h3>
      <p id="display-health" class="muted">Reading LCD settings…</p>
      <div id="display-settings" hidden>
        <div id="display-preferences" hidden>
          <label for="orientation">LCD orientation</label>
          <select id="orientation"><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option></select>
          <label for="mode">Display mode</label>
          <select id="mode"><option value="eyes">Eyes</option><option value="dashboard">Dashboard</option></select>
        </div>
        <label class="check"><input type="checkbox" id="show_occupancy">Room occupancy</label>
        <label class="check"><input type="checkbox" id="show_clock">Date and time</label>
        <label class="check"><input type="checkbox" id="show_sensor">Selected entity values</label>
        <label class="check"><input type="checkbox" id="log_enabled">Record radar tracks to the sensor's SD card</label>
        <div class="row"><button id="save-display" class="primary">Save LCD settings</button><button id="close-eyes">Close eyes</button></div>
        <div id="setup-controls" hidden>
          <p id="setup-status" class="muted"></p>
          <div class="row"><button id="complete-setup">Mark setup complete</button></div>
        </div>
        <label for="entities">Entities to cycle on the LCD</label>
        <select id="entities" multiple size="5"></select>
        <small>Choose up to four entities. Temperature and humidity values include their units. You can send the clock without selecting an entity.</small>
        <label class="check"><input type="checkbox" id="feed-enabled">Send date, time and selected values from Home Assistant</label>
        <div class="row"><button id="save-feed">Save Home Assistant feed</button><button id="refresh-display">Refresh status</button></div>
        <output id="feed-status"></output>
      </div>
    </section>
    <section aria-labelledby="training-heading">
      <h3 id="training-heading">Household training</h3>
      <p class="muted">The radar sees coarse movement tracks. Different people can move alike, so unverified tracks stay unknown.</p>
      <div class="metrics" aria-label="Held-out validation">
        <div><span>Named precision</span><strong id="precision">—</strong></div>
        <div><span>Moving-track coverage</span><strong id="coverage">—</strong></div>
        <div><span>Guest challenges</span><strong id="guest">0 / 50</strong></div>
        <div><span>Ambiguous challenges</span><strong id="ambiguous">0 / 50</strong></div>
      </div>
      <p id="assessment" class="muted"></p>
      <label for="kind">Session type</label><select id="kind">
        <option value="enroll">Enroll a resident</option><option value="resident">Validate an enrolled resident</option>
        <option value="guest">Validate an unenrolled guest</option><option value="ambiguous">Validate overlapping tracks</option>
      </select>
      <label id="person-label" for="person">Name or household label</label><input id="person" type="text" maxlength="32" list="enrolled" autocomplete="off"><datalist id="enrolled"></datalist>
      <label class="check"><input id="consent" type="checkbox">Everyone taking part has agreed to this session</label>
      <div class="row"><button id="start" class="primary">Start training</button><button id="end" disabled>End and save</button><button id="cancel" disabled>Discard</button></div>
      <output id="capture" role="status"></output>
      <div class="row"><button id="enable" disabled>Enable named automation events</button></div>
      <details><summary>Import an SD recording</summary>
        <p class="muted">Use the session type and consent controls above, then pick the segment you observed.</p>
        <label for="sd-file">TRACK recording (up to 8 MB)</label><input id="sd-file" type="file" accept=".jsl,.jsonl,.txt">
        <label for="sd-boot">Sensor boot</label><select id="sd-boot"></select>
        <label for="sd-start">Start seconds after boot</label><input id="sd-start" type="number" min="0" step="0.001">
        <label for="sd-end">End seconds after boot</label><input id="sd-end" type="number" min="0" step="0.001">
        <label id="sd-day-label" for="sd-day">Enrollment date if the recording has no clock time</label><input id="sd-day" type="date">
        <div class="row"><button id="sd-import" disabled>Import selected segment</button></div>
        <output id="sd-result" role="status"></output>
      </details>
      <details><summary>Link a shared doorway</summary>
        <p class="muted">Set an Entry zone on both sensors around the same doorway. A link lets Home Assistant watch for a single clear exit and arrival.</p>
        <label for="other">Adjacent sensor</label><select id="other"></select>
        <div class="row"><button id="link">Link doorway</button><button id="unlink">Remove link</button></div>
        <p id="links"></p>
      </details>
      <details><summary>Delete training data</summary>
        <label for="forget-person">Resident label (optional)</label><input id="forget-person" type="text" maxlength="32" list="enrolled" autocomplete="off">
        <label class="check"><input id="confirm-delete" type="checkbox">Delete local samples for this sensor</label>
        <button id="forget" disabled>Delete selected data</button>
        <small>Leave the label empty to delete every sample for this sensor.</small>
      </details>
    </section>
  </div>
</main>`;

class PresenceDeviceControls extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'}).innerHTML = template;
    this.$ = id => this.shadowRoot.getElementById(id);
    this.entries = [];
    this.state = null;
    this.active = false;
    this.pending = false;
    this.sdRows = new Map();
    const actions = {
      'save-display': () => this.display('set', this.displaySettings()),
      'save-feed': () => this.display('feed', {enabled:this.$('feed-enabled').checked, entities:[...this.$('entities').selectedOptions].map(option => option.value)}),
      'refresh-display': () => this.display('status'),
      'close-eyes': () => this.display('close_eyes'),
      'complete-setup': () => this.display('complete_setup'),
      start: () => this.training('start', {kind:this.$('kind').value, person:this.$('person').value, consent:this.$('consent').checked}),
      end: () => this.training('end'), cancel: () => this.training('cancel'),
      enable: () => this.training('enable', {enabled:!this.state?.enabled}),
      forget: () => this.training('forget', {person:this.$('forget-person').value.trim() || null}),
      link: () => this.training('link', {other_entry_id:this.$('other').value}),
      unlink: () => this.training('unlink', {other_entry_id:this.$('other').value}),
      'sd-import': () => this.importSD(),
    };
    for (const [id, action] of Object.entries(actions)) this.$(id).onclick = () => this.run(action);
    this.$('device').onchange = () => this.loadDevice();
    this.$('recalibrate').onclick = () => {
      if (this.pending || this.state?.capture) return;
      this.dispatchEvent(new CustomEvent('device-recalibrate', {detail: this.$('device').value}));
    };
    this.$('kind').onchange = () => this.controls();
    this.$('consent').onchange = () => this.controls();
    this.$('other').onchange = () => this.controls();
    this.$('confirm-delete').onchange = () => this.controls();
    this.$('sd-file').onchange = () => this.readSD();
    this.$('sd-boot').onchange = () => this.chooseClip();
  }

  set hass(hass) { this._hass = hass; }
  disconnectedCallback() { void this.setActive(false); }

  request(section, action, payload = {}, entry_id = this.$('device').value) {
    return this._hass.connection.sendMessagePromise({type:`${API}/${section}`, entry_id, action, payload});
  }

  async setActive(active) {
    if (active === this.active) return;
    this.active = active;
    clearInterval(this.timer);
    if (!active) {
      if (this.state?.capture) {
        try { await this.request('training', 'cancel'); } catch { /* Disconnect also releases the capture. */ }
      }
      this.state = null;
      this.clearSD();
      return;
    }
    try {
      const {entries} = await this._hass.connection.sendMessagePromise({type:`${API}/status`});
      if (!this.active) return;
      this.entries = entries;
      const selected = this.$('device').value;
      this.$('device').replaceChildren(...entries.map(entry => new Option(entry.title, entry.entry_id)));
      if (entries.some(entry => entry.entry_id === selected)) this.$('device').value = selected;
      this.$('tools').hidden = !entries.length;
      this.$('recalibrate-row').hidden = !entries.length;
      this.$('empty').hidden = Boolean(entries.length);
      if (entries.length) await this.loadDevice();
    } catch (error) { this.notice(ERRORS[error?.code] || 'Home Assistant could not load the sensor list.', true); }
    if (this.active) this.timer = setInterval(() => {
      if (this.state?.capture && !this.pending) void this.training('status', {}, true).catch(() => {});
    }, 1200);
  }

  async run(action) {
    if (this.pending) return;
    this.pending = true;
    this.notice('');
    this.controls();
    try { await action(); }
    catch (error) {
      this.notice(ERRORS[error?.code] || 'Home Assistant could not complete this operation.', true);
      try { await this.training('status', {}, true); } catch { /* Keep the original error. */ }
    }
    finally { this.pending = false; this.controls(); }
  }

  async loadDevice() {
    if (this.pending) return;
    this.state = null;
    this.$('display-settings').hidden = true;
    this.$('display-health').textContent = 'Reading LCD settings…';
    this.notice('');
    this.clearSD();
    this.$('other').replaceChildren(new Option('Choose adjacent sensor', ''), ...this.entries.filter(entry => entry.entry_id !== this.$('device').value).map(entry => new Option(entry.title, entry.entry_id)));
    this.$('consent').checked = this.$('confirm-delete').checked = false;
    try { await this.training('status', {}, true); }
    catch (error) { this.notice(ERRORS[error?.code] || 'Training controls are unavailable.', true); }
    try { await this.display('status'); }
    catch (error) { this.$('display-health').textContent = ERRORS[error?.code] || 'LCD settings are unavailable.'; }
    this.controls();
  }

  displaySettings() {
    const settings = Object.fromEntries(DISPLAY_FIELDS.map(key => [key, this.$(key).checked]));
    if (!this.$('display-preferences').hidden) {
      for (const key of Object.keys(DISPLAY_PREFERENCES)) settings[key] = this.$(key).value;
    }
    return settings;
  }

  async display(action, payload) {
    const entry = this.$('device').value;
    const result = await this.request('display', action, payload, entry);
    if (!this.active || this.$('device').value !== entry) return;
    const {display, entities, feed_enabled, feed_error} = result;
    for (const key of DISPLAY_FIELDS) this.$(key).checked = display[key] === true;
    const hasPreferences = Object.entries(DISPLAY_PREFERENCES).every(([key, options]) => options.includes(display[key]));
    this.$('display-preferences').hidden = !hasPreferences;
    if (hasPreferences) for (const key of Object.keys(DISPLAY_PREFERENCES)) this.$(key).value = display[key];
    this.$('setup-controls').hidden = typeof display.setup_complete !== 'boolean';
    this.$('setup-status').textContent = display.setup_complete ? 'Setup complete.' : 'Setup in progress.';
    this.$('complete-setup').hidden = display.setup_complete === true;
    this.$('feed-enabled').checked = feed_enabled;
    const kind = ['sensor.', 'binary_sensor.', 'input_number.', 'number.', 'weather.', 'climate.'];
    const states = Object.values(this._hass.states || {}).filter(state => kind.some(prefix => state.entity_id.startsWith(prefix)) || entities.includes(state.entity_id));
    const choices = states.map(state => [state.entity_id, state.attributes.friendly_name || state.entity_id]);
    for (const id of entities) if (!choices.some(row => row[0] === id)) choices.push([id, id]);
    this.$('entities').replaceChildren(...choices.sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => new Option(`${name} (${id})`, id, false, entities.includes(id))));
    this.$('display-health').textContent = [display.lcd_ready ? 'LCD ready' : 'LCD unavailable', display.sd_ready ? 'SD ready' : 'SD unavailable', display.logging ? 'Logging' : '', display.dropped_log_samples ? `${display.dropped_log_samples} skipped samples` : ''].filter(Boolean).join(' · ');
    this.$('display-settings').hidden = false;
    this.$('close-eyes').hidden = hasPreferences;
    this.$('close-eyes').disabled = !display.eyes_active;
    this.$('feed-status').textContent = feed_error ? ERRORS[feed_error] || 'The current feed could not reach the LCD.' : feed_enabled ? 'Home Assistant feed enabled.' : 'Home Assistant feed is off.';
    if (action === 'complete_setup') this.notice('Setup marked complete.');
    else if (action !== 'status') this.notice('LCD settings updated.');
  }

  async training(action, payload, quiet = false) {
    const entry = this.$('device').value;
    const state = await this.request('training', action, payload, entry);
    if (!this.active || this.$('device').value !== entry) {
      if (action === 'start') await this.request('training', 'cancel', {}, entry);
      return;
    }
    this.state = state;
    if (action === 'start' || action === 'sd_import') this.$('consent').checked = false;
    this.controls();
    if (!quiet) this.notice(action === 'end' ? 'Training session saved.' : 'Training settings updated.');
  }

  clearSD() {
    this.sdRows.clear();
    this.$('sd-file').value = '';
    this.$('sd-boot').replaceChildren();
    for (const id of ['sd-start','sd-end','sd-day']) this.$(id).value = '';
    this.$('sd-result').textContent = '';
  }

  async readSD() {
    const input = this.$('sd-file');
    const file = input.files[0];
    this.sdRows.clear();
    this.$('sd-boot').replaceChildren();
    this.$('sd-result').textContent = '';
    this.controls();
    if (!file) return;
    try {
      if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('Choose a recording of 8 MB or less.');
      const text = await file.text();
      if (!this.active || input.files[0] !== file) return;
      const lines = text.split(/\r?\n/);
      const rows = new Map();
      for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); }
        catch {
          if (index === lines.length - 1) continue;
          throw new Error(`The recording has an invalid line at ${index + 1}.`);
        }
        if (row?.v !== 1 || !Number.isSafeInteger(row.boot_id) || row.boot_id <= 0 || row.boot_id > 0xffffffff || !Number.isSafeInteger(row.uptime_ms) || row.uptime_ms < 0) {
          throw new Error(`The recording has an invalid frame at line ${index + 1}.`);
        }
        if (!rows.has(row.boot_id)) rows.set(row.boot_id, []);
        rows.get(row.boot_id).push([row.uptime_ms, line]);
      }
      if (!rows.size) throw new Error('No complete radar frames were found.');
      this.sdRows = rows;
      const boots = [...rows.keys()];
      this.$('sd-boot').replaceChildren(...boots.map(boot => new Option(String(boot), String(boot))));
      this.$('sd-boot').value = String(boots.at(-1));
      this.chooseClip();
    } catch (error) { this.$('sd-result').textContent = error.message; }
    this.controls();
  }

  chooseClip() {
    const rows = this.sdRows.get(Number(this.$('sd-boot').value));
    if (!rows?.length) return;
    let first = Number.POSITIVE_INFINITY, last = 0;
    for (const [ms] of rows) { first = Math.min(first, ms); last = Math.max(last, ms); }
    this.$('sd-start').value = (Math.max(first, last - 30000) / 1000).toFixed(3);
    this.$('sd-end').value = (last / 1000).toFixed(3);
    this.$('sd-result').textContent = `Available: ${(first/1000).toFixed(1)}–${(last/1000).toFixed(1)} s after boot.`;
  }

  async importSD() {
    const rows = this.sdRows.get(Number(this.$('sd-boot').value)) || [];
    const start = this.$('sd-start').valueAsNumber;
    const end = this.$('sd-end').valueAsNumber;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end - start > 45) {
      this.$('sd-result').textContent = 'Choose a segment of 45 seconds or less.';
      return;
    }
    const clip = rows.filter(([ms]) => Math.round(start * 1000) <= ms && ms <= Math.round(end * 1000)).map(([, line]) => line).join('\n');
    if (!clip || new TextEncoder().encode(clip).length > 96 * 1024) {
      this.$('sd-result').textContent = 'No complete frames were selected, or the segment is too large.';
      return;
    }
    try {
      await this.training('sd_import', {clip, kind:this.$('kind').value, person:this.$('person').value,
        consent:this.$('consent').checked, day:this.$('kind').value === 'enroll' ? this.$('sd-day').value || null : null}, true);
      this.$('sd-result').textContent = 'Saved the derived training session.';
    } catch (error) { this.$('sd-result').textContent = ERRORS[error?.code] || 'This segment could not be imported.'; }
  }

  controls() {
    const state = this.state;
    const capture = state?.capture;
    const metrics = state?.assessment;
    const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;
    this.$('precision').textContent = percent(metrics?.precision);
    this.$('coverage').textContent = percent(metrics?.coverage);
    this.$('guest').textContent = `${metrics?.guest || 0} / 50`;
    this.$('ambiguous').textContent = `${metrics?.ambiguous || 0} / 50`;
    this.$('assessment').textContent = metrics?.passed ? 'Held-out validation passed.' : `${state?.samples || 0} saved sessions. Named events require 95% precision, 70% coverage, separate days and no named challenge results.`;
    this.$('enrolled').replaceChildren(...(metrics?.enrolled || []).map(name => new Option(name)));
    this.$('capture').textContent = capture ? ERRORS[capture.error] || `${capture.seconds_remaining ? `${capture.seconds_remaining}s remaining` : 'Time is up'} · ${capture.windows} usable windows${capture.ambiguous ? ' · overlap observed' : ''}` : state?.busy ? 'Another session is running.' : state?.error ? ERRORS[state.error] || 'Radar data unavailable.' : '';
    const label = ['enroll','resident'].includes(this.$('kind').value);
    this.$('person').hidden = this.$('person-label').hidden = !label;
    const locked = this.pending || Boolean(capture);
    for (const id of ['device','kind','person','consent']) this.$(id).disabled = locked;
    this.$('start').disabled = locked || !state || state.busy || !this.$('consent').checked;
    this.$('end').disabled = this.pending || !capture || Boolean(capture.error) || !(capture.kind === 'ambiguous' ? capture.ambiguous : capture.windows > 0 && !capture.ambiguous);
    this.$('cancel').disabled = this.pending || !capture;
    this.$('enable').disabled = locked || !(state?.enabled || metrics?.passed);
    this.$('enable').textContent = state?.enabled ? 'Disable named automation events' : 'Enable named automation events';
    this.$('forget').disabled = locked || !state?.samples || !this.$('confirm-delete').checked;
    this.$('sd-import').disabled = locked || !this.sdRows.size || !this.$('consent').checked;
    this.$('sd-day').hidden = this.$('sd-day-label').hidden = this.$('kind').value !== 'enroll';
    const linked = state?.links || [];
    const other = this.$('other').value;
    this.$('link').disabled = locked || !other || linked.includes(other);
    this.$('unlink').disabled = locked || !other || !linked.includes(other);
    this.$('links').textContent = linked.map(id => this.entries.find(entry => entry.entry_id === id)?.title).filter(Boolean).join(' · ');
  }

  notice(message, error = false) {
    this.$('notice').textContent = message;
    this.$('notice').classList.toggle('error', error);
  }
}

customElements.define('presence-device-controls', PresenceDeviceControls);
