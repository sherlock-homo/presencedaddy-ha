const MIN_ANCHOR_SPAN_MM = 750;
const RADAR_RANGE_MM = 6000;
const RADAR_HALF_ANGLE_DEG = 60;
const WALL_MOUNT_CLEARANCE_MM = 120;
const DOOR_EDGE_TOLERANCE_MM = 75;
const EPSILON = 1e-8;

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (p, n) => [p[0] * n, p[1] * n];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mean = points => mul(points.reduce(add, [0, 0]), 1 / points.length);
const rotation = (point, cos, sin) => [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos];

export function bounds(points) {
  if (!points.length) return [0, 0, 0, 0];
  return points.reduce(([left, right, bottom, top], [x, y]) =>
    [Math.min(left, x), Math.max(right, x), Math.min(bottom, y), Math.max(top, y)],
  [Infinity, -Infinity, Infinity, -Infinity]);
}

export function ringArea(points) {
  return points.reduce((sum, point, i) => sum + cross(point, points[(i + 1) % points.length]), 0) / 2;
}

function edges(points) {
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function distanceToSegment(point, a, b) {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  const along = lengthSquared ? Math.max(0, Math.min(1, dot(sub(point, a), ab) / lengthSquared)) : 0;
  return distance(point, add(a, mul(ab, along)));
}

export function pointInPolygon(point, polygon, tolerance = 0) {
  const [x, y] = point;
  let inside = false;
  for (const [a, b] of edges(polygon)) {
    if (distanceToSegment(point, a, b) <= tolerance + EPSILON) return true;
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) {
      inside = !inside;
    }
  }
  return inside;
}

function intersectionAlong(origin, direction, a, b) {
  const edge = sub(b, a);
  const det = cross(direction, edge);
  if (Math.abs(det) < EPSILON) return null;
  const delta = sub(a, origin);
  const t = cross(delta, edge) / det;
  const u = cross(delta, direction) / det;
  return u >= 0 && u <= 1 ? t : null;
}

function segmentsIntersect(a, b, c, d) {
  const t = intersectionAlong(a, sub(b, a), c, d);
  return t !== null && t >= 0 && t <= 1;
}

function ringsOverlap(a, b) {
  const strictlyInside = (point, polygon) => pointInPolygon(point, polygon) &&
    edges(polygon).every(([p, q]) => distanceToSegment(point, p, q) > 0.5);
  return a.some(p => strictlyInside(p, b)) || b.some(p => strictlyInside(p, a)) ||
    edges(a).some(([p, q]) => edges(b).some(([r, s]) => {
      const t = intersectionAlong(p, sub(q, p), r, s);
      const u = intersectionAlong(r, sub(s, r), p, q);
      return t > EPSILON && t < 1 - EPSILON && u > EPSILON && u < 1 - EPSILON;
    }));
}

export function validOutline(points) {
  if (points.length < 3 || Math.abs(ringArea(points)) < 2500) return false;
  if (new Set(points.map(p => p.join(','))).size !== points.length) return false;
  const segments = edges(points);
  return !segments.some(([a, b], i) => segments.some(([c, d], j) =>
    j > i + 1 && !(i === 0 && j === segments.length - 1) && segmentsIntersect(a, b, c, d)));
}

function anchorSpan(points) {
  return Math.max(...points.flatMap(a => points.map(b => distance(a, b))));
}

export function fitSensor(anchors, mirrored = false) {
  if (anchors.length < 2) return null;
  const input = anchors.map(a => [mirrored ? -a.radar[0] : a.radar[0], a.radar[1]]);
  const target = anchors.map(a => a.plan);
  if (Math.min(anchorSpan(input), anchorSpan(target)) < MIN_ANCHOR_SPAN_MM) return null;

  const sourceCenter = mean(input);
  const targetCenter = mean(target);
  let alignment = 0;
  let turn = 0;
  input.forEach((point, index) => {
    const aroundSource = sub(point, sourceCenter);
    const aroundTarget = sub(target[index], targetCenter);
    alignment += dot(aroundSource, aroundTarget);
    turn += cross(aroundSource, aroundTarget);
  });
  if (Math.hypot(alignment, turn) < EPSILON) return null;
  const angle = Math.atan2(turn, alignment);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const origin = sub(targetCenter, rotation(sourceCenter, cos, sin));
  const error = input.reduce((sum, point, i) => sum + distance(add(origin, rotation(point, cos, sin)), target[i]) ** 2, 0);
  return {origin, cos, sin, mirrored, rmsMm: Math.sqrt(error / input.length), anchorCount: input.length};
}

export function validSensorPlacement(placement) {
  return Array.isArray(placement?.origin) && placement.origin.length === 2 &&
    [...placement.origin].every(value => Number.isInteger(value) && Math.abs(value) <= 1_000_000) &&
    Number.isInteger(placement.heading_mdeg) &&
    placement.heading_mdeg >= -180_000 && placement.heading_mdeg < 180_000;
}

export function fitPlanSensor(sensor) {
  if (!sensor) return null;
  const walked = fitSensor(sensor.anchors, sensor.mirrored);
  if (walked) return {...walked, source: 'walked'};
  if (!validSensorPlacement(sensor.placement)) return null;
  const {origin, heading_mdeg: heading} = sensor.placement;
  const angle = heading * Math.PI / 180_000;
  return {origin, cos: Math.cos(angle), sin: Math.sin(angle), mirrored: sensor.mirrored, source: 'label'};
}

export function planPoint(fit, point) {
  return add(fit.origin, rotation([fit.mirrored ? -point[0] : point[0], point[1]], fit.cos, fit.sin));
}

export function radarPoint(fit, point) {
  const [x, y] = rotation(sub(point, fit.origin), fit.cos, -fit.sin);
  return [fit.mirrored ? -x : x, y];
}

function occupiedRayIntervals({outline, segments}, origin, direction) {
  const distances = [0];
  for (const [a, b] of segments) {
    const hit = intersectionAlong(origin, direction, a, b);
    if (hit !== null && hit > 0) distances.push(hit);
  }
  distances.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < distances.length; i++) {
    const near = distances[i - 1];
    const far = distances[i];
    if (far - near > EPSILON && pointInPolygon(add(origin, mul(direction, (near + far) / 2)), outline)) {
      intervals.push([near, far]);
    }
  }
  return intervals;
}

function aperture(outline) {
  const segments = edges(outline);
  const [a, b] = segments.reduce((longest, edge) => distance(...edge) > distance(...longest) ? edge : longest);
  const widthAxis = mul(sub(b, a), 1 / distance(a, b));
  const widths = outline.map(point => dot(point, widthAxis));
  return {outline, segments, widthAxis, left: Math.min(...widths), right: Math.max(...widths)};
}

function passesAperture({intervals, widthAxis, left, right}, near, far, origin, direction) {
  if (!intervals.some(([start, end]) => Math.min(far, end) - Math.max(near, start) > EPSILON)) return false;
  // Extend the opening through only the wall interval it intersects. The
  // ray must still fit between the jambs at both faces of that interval.
  return [near, far].every(hit => {
    const width = dot(add(origin, mul(direction, hit)), widthAxis);
    return width >= left - DOOR_EDGE_TOLERANCE_MM && width <= right + DOOR_EDGE_TOLERANCE_MM;
  });
}

export function coverageOutline(rooms, fit) {
  const boundaries = rooms.flatMap(room => edges(room.outline));
  const features = rooms.flatMap(room => room.features);
  const walls = features.filter(f => f.kind === 'wall').map(({outline}) => ({outline, segments: edges(outline)}));
  const openings = features.filter(f => f.kind === 'door' || f.kind === 'opening').map(f => aperture(f.outline));
  const outline = [fit.origin];
  for (let degrees = -RADAR_HALF_ANGLE_DEG; degrees <= RADAR_HALF_ANGLE_DEG; degrees += 2) {
    const angle = degrees * Math.PI / 180;
    const direction = sub(planPoint(fit, [Math.sin(angle), Math.cos(angle)]), fit.origin);
    let range = RADAR_RANGE_MM;
    for (const [a, b] of boundaries) {
      const hit = intersectionAlong(fit.origin, direction, a, b);
      if (hit === null || hit < WALL_MOUNT_CLEARANCE_MM || hit >= range) continue;
      const at = add(fit.origin, mul(direction, hit));
      if (!openings.some(opening => pointInPolygon(at, opening.outline, DOOR_EDGE_TOLERANCE_MM))) range = hit - 1;
    }
    if (walls.length) {
      const apertures = openings.map(opening => ({
        ...opening, intervals: occupiedRayIntervals(opening, fit.origin, direction),
      }));
      for (const wall of walls) {
        for (const [near, far] of occupiedRayIntervals(wall, fit.origin, direction)) {
          const hit = near < WALL_MOUNT_CLEARANCE_MM ? far : near;
          if (hit < WALL_MOUNT_CLEARANCE_MM || hit >= range) continue;
          if (!apertures.some(opening => passesAperture(opening, near, far, fit.origin, direction))) range = hit - 1;
        }
      }
    }
    outline.push(add(fit.origin, mul(direction, range)));
  }
  return outline;
}

export function visibleRegions(rooms, outline) {
  return rooms.filter(room => ringsOverlap(outline, room.outline)).map(room => ({
    id: room.id,
    name: room.name,
    features: room.features.filter(f => f.kind !== 'wall' && ringsOverlap(outline, f.outline)),
  }));
}

export function detectionsInRegions(rooms, detections) {
  return rooms.flatMap(room => [room, ...room.features.filter(f => !['wall', 'window', 'object'].includes(f.kind))])
    .filter(region => detections.some(point => pointInPolygon(point, region.outline))).map(region => region.id);
}

function planTransform(pivot, offset, degrees) {
  const angle = (degrees % 360) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const center = add(pivot, offset);
  return point => add(center, rotation(sub(point, pivot), cos, sin)).map(Math.round);
}

export function transformRooms(rooms, pivot, offset, degrees) {
  const transform = planTransform(pivot, offset, degrees);
  const outline = points => points.map(transform);
  return rooms.map(room => ({...room, outline: outline(room.outline),
    features: room.features.map(feature => ({...feature, outline: outline(feature.outline)}))}));
}

export function transformPlacements(placements, pivot, offset, degrees) {
  const transform = planTransform(pivot, offset, degrees);
  const rotate = Math.round((degrees % 360) * 1000);
  return placements.map(placement => {
    const heading = placement.heading_mdeg + rotate;
    const heading_mdeg = ((heading + 180_000) % 360_000 + 360_000) % 360_000 - 180_000;
    return {...placement, origin: transform(placement.origin), heading_mdeg};
  });
}

export function calibrationFromPlan(room, fit, original) {
  if (fit.source === 'label') return null;
  const rect = points => {
    const [a, b, c, d] = bounds(points.map(point => radarPoint(fit, point)));
    return [Math.floor(a), Math.ceil(b), Math.floor(c), Math.ceil(d)];
  };
  const roomRect = rect(room.outline);
  const included = candidate => candidate && candidate[0] >= roomRect[0] && candidate[1] <= roomRect[1] &&
    candidate[2] >= roomRect[2] && candidate[3] <= roomRect[3];
  if (roomRect.some(n => n < -32768 || n > 32767)) return null;
  function zone(kind, fallback) {
    const feature = room.features.find(f => f.kind === kind);
    const shape = feature ? rect(feature.outline) : fallback;
    return included(shape) ? shape : null;
  }
  const drawnExclusions = room.features.filter(f => f.kind === 'ignore').map(f => rect(f.outline)).filter(included);
  const excluded = drawnExclusions.length ? drawnExclusions : original.exclusions.filter(included);
  return {
    room: roomRect,
    zones: [zone('seating', original.zones[0]), zone('entry', original.zones[1]), zone('area', original.zones[2])],
    exclusions: [excluded[0] ?? null, excluded[1] ?? null, excluded[2] ?? null],
  };
}
