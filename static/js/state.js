// Store + mutations. x,y are normalized 0..1 video coordinates; points sorted by t.

export const EPS_T = 0.02;      // s — a click within this of an existing point's t replaces it
export const T_FULL = 0.5;      // s — full opacity within ±T_FULL of currentTime
export const T_FAR = 5.0;       // s — falloff reaches ALPHA_MIN at ±T_FAR
export const ALPHA_MIN = 0.15;
export const HIT_RADIUS = 10;   // CSS px for point hit-testing
export const FRAME_STEP = 1 / 30; // s for step buttons / arrow keys

export const PALETTE = [
  '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
];

export const state = {
  video: { url: '', width: 0, height: 0, duration: 0 },
  objects: [], // [{ id, name, color, visible, points: [{t, x, y}] }]
  activeObjectId: null,
  nextObjectNum: 1,
  nextObjectId: 1,
};

const listeners = [];

export function subscribe(fn) {
  listeners.push(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

export function getObject(id) {
  return state.objects.find((o) => o.id === id) ?? null;
}

export function getActiveObject() {
  return getObject(state.activeObjectId);
}

export function addObject(name) {
  const obj = {
    id: state.nextObjectId++,
    name: name ?? `fish ${state.nextObjectNum}`,
    color: PALETTE[(state.nextObjectNum - 1) % PALETTE.length],
    visible: true,
    points: [],
  };
  state.nextObjectNum++;
  state.objects.push(obj);
  state.activeObjectId = obj.id;
  notify();
  return obj;
}

export function renameObject(id, name) {
  const obj = getObject(id);
  if (obj && name.trim()) obj.name = name.trim();
  notify();
}

export function deleteObject(id) {
  state.objects = state.objects.filter((o) => o.id !== id);
  if (state.activeObjectId === id) {
    state.activeObjectId = state.objects[0]?.id ?? null;
  }
  notify();
}

export function setActiveObject(id) {
  state.activeObjectId = id;
  notify();
}

export function toggleVisible(id) {
  const obj = getObject(id);
  if (obj) obj.visible = !obj.visible;
  notify();
}

export function addPoint(objId, t, x, y) {
  const obj = getObject(objId);
  if (!obj) return;
  const existing = obj.points.find((p) => Math.abs(p.t - t) < EPS_T);
  if (existing) {
    existing.x = x;
    existing.y = y;
  } else {
    const idx = obj.points.findIndex((p) => p.t > t);
    const point = { t, x, y };
    if (idx === -1) obj.points.push(point);
    else obj.points.splice(idx, 0, point);
  }
  invalidate(obj);
  notify();
}

export function movePoint(objId, point, x, y) {
  const obj = getObject(objId);
  if (!obj || !obj.points.includes(point)) return;
  point.x = x;
  point.y = y;
  invalidate(obj);
  notify();
}

export function deletePoint(objId, point) {
  const obj = getObject(objId);
  if (!obj) return;
  const idx = obj.points.indexOf(point);
  if (idx !== -1) obj.points.splice(idx, 1);
  invalidate(obj);
  notify();
}

function invalidate(obj) {
  obj._cache = null; // trajectory/samples cache owned by spline.js
}

// 1 within ±T_FULL of the playhead, linear falloff to ALPHA_MIN at ±T_FAR.
export function alphaForDt(dt) {
  const adt = Math.abs(dt);
  if (adt <= T_FULL) return 1;
  if (adt >= T_FAR) return ALPHA_MIN;
  return 1 - (1 - ALPHA_MIN) * ((adt - T_FULL) / (T_FAR - T_FULL));
}
