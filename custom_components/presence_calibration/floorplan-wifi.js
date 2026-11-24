export const WIFI_SURVEY_SCHEMA = "presenceDaddy.wifi.v1";
export const WIFI_SURVEY_MAX_BYTES = 4 * 1024 * 1024;

const MAX_SCANS = 512;
const MAX_POINTS = 256;
const MAX_SIGNALS = 32;
const AP = /^ap-[0-9a-f]{24}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAC_ADDRESS = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;

function objectFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function arrayLength(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} entries.`);
  }
}

function scanId(value) {
  if (typeof value !== "string" || value.match(ID)?.[0] !== value) throw new Error("Invalid Wi-Fi scan ID.");
  return value;
}

function accessPointId(value) {
  if (typeof value !== "string" || value.length !== 27 || !AP.test(value)) {
    throw new Error("Wi-Fi access points must use survey pseudonyms.");
  }
  return value;
}

function planPosition(position, integer = false) {
  if (!Array.isArray(position) || position.length !== 2 ||
      ![...position].every(value => Number.isFinite(value) && Math.abs(value) <= 1e6 &&
        (!integer || Number.isInteger(value)))) {
    throw new Error(integer ? "A Wi-Fi pin needs integer X and Y coordinates in millimeters." :
      "A Wi-Fi point needs finite plan X and Y coordinates.");
  }
  return [...position];
}

function signals(value) {
  arrayLength(value, 1, MAX_SIGNALS, "Wi-Fi signals");
  const seen = new Set();
  return Array.from(value, signal => {
    objectFields(signal, ["ap", "rssi"], "Wi-Fi signal");
    const ap = accessPointId(signal.ap);
    if (seen.has(ap)) throw new Error("A Wi-Fi sample repeats the same access point.");
    if (!Number.isInteger(signal.rssi) || signal.rssi < -127 || signal.rssi >= 0) {
      throw new Error("Wi-Fi signal strength must be an integer dBm value from -127 to -1.");
    }
    seen.add(ap);
    return {ap, rssi: signal.rssi};
  });
}

function surveyScan(scan) {
  objectFields(scan, ["id", "name", "signals"], "Wi-Fi scan");
  if (typeof scan.name !== "string" || CONTROL_CHARACTERS.test(scan.name) || MAC_ADDRESS.test(scan.name)) {
    throw new Error("Give each Wi-Fi scan a location name without hardware addresses.");
  }
  const name = scan.name.trim();
  if (!name || name.length > 80) throw new Error("Wi-Fi scan names must contain 1 to 80 characters.");
  return {id: scanId(scan.id), name, signals: signals(scan.signals)};
}

function uniqueIds(values) {
  const ids = new Set(values.map(value => value.id));
  if (ids.size !== values.length) throw new Error("Wi-Fi scan IDs must be unique.");
  return values;
}

// Parse a capture file. Names describe manual waypoints and are never used to
// infer or assign plan coordinates.
export function parseWifiSurvey(input) {
  let survey = input;
  if (typeof input === "string") {
    if (input.length > WIFI_SURVEY_MAX_BYTES ||
        new TextEncoder().encode(input).byteLength > WIFI_SURVEY_MAX_BYTES) {
      throw new Error("Wi-Fi survey files must be 4 MiB or smaller.");
    }
    try {
      survey = JSON.parse(input);
    } catch {
      throw new Error("The Wi-Fi survey is not valid JSON.");
    }
  }
  objectFields(survey, ["schema", "scans"], "Wi-Fi survey");
  if (survey.schema !== WIFI_SURVEY_SCHEMA) throw new Error("Unsupported Wi-Fi survey schema.");
  arrayLength(survey.scans, 1, MAX_SCANS, "Wi-Fi survey");
  return uniqueIds(Array.from(survey.scans, surveyScan));
}

// Stored plan positions use integer millimeters and the floor plan origin.
export function validateWifiPoints(value) {
  arrayLength(value, 0, MAX_POINTS, "Wi-Fi points");
  return uniqueIds(Array.from(value, point => {
    objectFields(point, ["id", "position", "signals"], "Pinned Wi-Fi point");
    return {id: scanId(point.id), position: planPosition(point.position, true), signals: signals(point.signals)};
  }));
}

export function pinWifiScan(wifi, scan, position) {
  const {id, signals} = surveyScan(scan);
  const pins = validateWifiPoints(wifi).filter(point => point.id !== id);
  if (pins.length >= MAX_POINTS) throw new Error("A plan can store up to 256 Wi-Fi points.");
  return [...pins, {id, position: planPosition(position, true), signals}];
}

export function wifiAccessPoints(wifi) {
  const summary = new Map();
  for (const sample of wifi) {
    for (const {ap, rssi} of sample.signals) {
      const entry = summary.get(ap) || {ap, samples: 0, minRssi: rssi, maxRssi: rssi};
      entry.samples++;
      entry.minRssi = Math.min(entry.minRssi, rssi);
      entry.maxRssi = Math.max(entry.maxRssi, rssi);
      summary.set(ap, entry);
    }
  }
  return [...summary.values()].sort((a, b) => b.samples - a.samples || a.ap.localeCompare(b.ap));
}

function cross(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function convexHull(points) {
  const halfHull = ordered => {
    const hull = [];
    for (const point of ordered) {
      while (hull.length >= 2 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
      hull.push(point);
    }
    hull.pop();
    return hull;
  };
  const ordered = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  return [...halfHull(ordered), ...halfHull(ordered.reverse())];
}

// Prepare reusable inverse-distance interpolation for one AP. Values are in
// dBm. Three noncollinear locations are needed for an area. The estimate is
// clipped to the AP's measured convex hull, with an optional distance limit
// to the nearest reading in plan units. Coincident samples are averaged.
export function createWifiField(wifi, ap, {maxDistance = Infinity} = {}) {
  accessPointId(ap);
  if (typeof maxDistance !== "number" || !(maxDistance > 0)) {
    throw new Error("The Wi-Fi interpolation distance must be positive.");
  }
  const byLocation = new Map();
  for (const {position: [x, y], signals} of wifi) {
    const signal = signals.find(value => value.ap === ap);
    if (!signal) continue;
    const key = `${x},${y}`;
    const entry = byLocation.get(key) || {x, y, sum: 0, count: 0};
    entry.sum += signal.rssi;
    entry.count++;
    byLocation.set(key, entry);
  }
  const samples = [...byLocation.values()].map(({x, y, sum, count}) => ({x, y, rssi: sum / count}));
  const hull = convexHull(samples);
  const maxDistanceSquared = maxDistance * maxDistance;
  const minRssi = Math.min(...samples.map(sample => sample.rssi));
  const maxRssi = Math.max(...samples.map(sample => sample.rssi));

  const predict = position => {
    const [x, y] = planPosition(position);
    const sample = byLocation.get(`${x},${y}`);
    if (sample) return sample.sum / sample.count;
    const query = {x, y};
    if (hull.length < 3 || hull.some((point, i) => cross(point, hull[(i + 1) % hull.length], query) < 0)) {
      return null;
    }
    let nearest = Infinity;
    let total = 0;
    let weights = 0;
    for (const other of samples) {
      const distance = (x - other.x) ** 2 + (y - other.y) ** 2;
      if (distance < Number.EPSILON) return other.rssi;
      nearest = Math.min(nearest, distance);
      const weight = 1 / distance;
      total += weight * other.rssi;
      weights += weight;
    }
    if (nearest > maxDistanceSquared) return null;
    return Math.max(minRssi, Math.min(maxRssi, total / weights));
  };
  return {outline: hull.map(({x, y}) => [x, y]), predict};
}

export function interpolateWifiRssi(wifi, ap, position, options) {
  return createWifiField(wifi, ap, options).predict(position);
}
