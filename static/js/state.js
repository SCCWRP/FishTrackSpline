// Store + mutations. x,y are normalized 0..1 video coordinates; keyframes sorted by t.

import { createHistory } from './history.js';

export const EPS_T = 0.02;      // s — a keyframe within this of an existing one's t replaces it
export const T_FULL = 0.5;      // s — full opacity within ±T_FULL of currentTime
export const T_FAR = 5.0;       // s — falloff reaches ALPHA_MIN at ±T_FAR
export const ALPHA_MIN = 0.15;
export const HIT_RADIUS = 10;   // CSS px for point hit-testing
export const FRAME_STEP = 1 / 30; // s for step buttons / arrow keys

export const PALETTE = [
  '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
];

const SAM_DECODE_KEY = 'fishtrackspline.samDecode';

export const state = {
  video: { url: '', width: 0, height: 0, duration: 0 },
  // point: { id, name, color, visible, type: 'point', points: [{t, x, y}] }
  // box:   { id, name, color, visible, type: 'box',
  //          boxes: [{t, x1, y1, x2, y2, source, edited, prompts: {points: [{x, y, label}], box}}] }
  //          source: 'manual' | 'sam-box' | 'sam-points'; prompts.box: {x1, y1, x2, y2} | null
  objects: [],
  activeObjectId: null,
  nextObjectNum: 1,
  nextObjectId: 1,
  inputMode: 'manual-box', // box objects: 'manual-box' | 'sam-box' | 'sam-points'
  samDecode: loadSamDecode(), // 'server' | 'browser'
  viewMode: 'edit', // 'edit' (annotate) | 'view' (crosshairs + rendered box overlays only)
  isolate: false, // box objects: draw only the active object's keyframe on the current frame
};

const listeners = [];

export function subscribe(fn) {
  listeners.push(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

// ---------- undo / redo ----------

// Keys starting with "_" (trajectory caches) are derived data, never snapshotted.
function capture() {
  return {
    objects: JSON.parse(JSON.stringify(state.objects, (k, v) => (k.startsWith('_') ? undefined : v))),
    activeObjectId: state.activeObjectId,
    nextObjectNum: state.nextObjectNum,
    nextObjectId: state.nextObjectId,
  };
}

// Visibility is view state: keep the current eye toggle for objects that still exist.
function restore(snap) {
  const visible = new Map(state.objects.map((o) => [o.id, o.visible]));
  state.objects = snap.objects;
  for (const o of state.objects) if (visible.has(o.id)) o.visible = visible.get(o.id);
  state.nextObjectNum = snap.nextObjectNum;
  state.nextObjectId = snap.nextObjectId;
  state.activeObjectId = getObject(snap.activeObjectId) ? snap.activeObjectId : state.objects[0]?.id ?? null;
}

const history = createHistory({ capture, restore });

export const beginBatch = history.beginBatch;
export const endBatch = history.endBatch;
export const canUndo = history.canUndo;
export const canRedo = history.canRedo;
export const resetHistory = history.clear;

export function undo() {
  if (history.undo()) notify();
}

export function redo() {
  if (history.redo()) notify();
}

// ---------- objects ----------

export function getObject(id) {
  return state.objects.find((o) => o.id === id) ?? null;
}

export function getActiveObject() {
  return getObject(state.activeObjectId);
}

export function keysOf(obj) {
  return obj.type === 'box' ? obj.boxes : obj.points;
}

export function addObject(type = 'point', name) {
  history.checkpoint();
  const obj = {
    id: state.nextObjectId++,
    name: name ?? `fish ${state.nextObjectNum}`,
    color: PALETTE[(state.nextObjectNum - 1) % PALETTE.length],
    visible: true,
    type,
  };
  if (type === 'box') obj.boxes = [];
  else obj.points = [];
  state.nextObjectNum++;
  state.objects.push(obj);
  state.activeObjectId = obj.id;
  notify();
  return obj;
}

export function renameObject(id, name) {
  const obj = getObject(id);
  if (obj && name.trim() && name.trim() !== obj.name) {
    history.checkpoint();
    obj.name = name.trim();
  }
  notify();
}

export function deleteObject(id) {
  history.checkpoint();
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

// ---------- point keyframes ----------

export function addPoint(objId, t, x, y) {
  const obj = getObject(objId);
  if (!obj) return;
  history.checkpoint();
  const existing = obj.points.find((p) => Math.abs(p.t - t) < EPS_T);
  if (existing) {
    existing.x = x;
    existing.y = y;
  } else {
    insertSorted(obj.points, { t, x, y });
  }
  invalidate(obj);
  notify();
}

export function movePoint(objId, point, x, y) {
  const obj = getObject(objId);
  if (!obj || !obj.points.includes(point)) return;
  history.checkpoint();
  point.x = x;
  point.y = y;
  invalidate(obj);
  notify();
}

export function deletePoint(objId, point) {
  const obj = getObject(objId);
  if (!obj) return;
  const idx = obj.points.indexOf(point);
  if (idx === -1) return;
  history.checkpoint();
  obj.points.splice(idx, 1);
  invalidate(obj);
  notify();
}

// ---------- box keyframes ----------

export function emptyPrompts() {
  return { points: [], box: null };
}

export function normalizeRect({ x1, y1, x2, y2 }) {
  return {
    x1: Math.min(x1, x2), y1: Math.min(y1, y2),
    x2: Math.max(x1, x2), y2: Math.max(y1, y2),
  };
}

// The object's keyframe on the frame at t (within EPS_T), or null.
export function boxAt(obj, t) {
  return obj.boxes.find((b) => Math.abs(b.t - t) < EPS_T) ?? null;
}

// Create or replace the keyframe at t; a fresh (non-edited) box either way.
function upsertBox(obj, t, rect, source, prompts) {
  const fields = { ...normalizeRect(rect), source, edited: false, prompts };
  const existing = boxAt(obj, t);
  if (existing) Object.assign(existing, fields);
  else insertSorted(obj.boxes, { t, ...fields });
  invalidate(obj);
}

export function addBox(objId, t, rect) {
  const obj = getObject(objId);
  if (!obj) return;
  history.checkpoint();
  upsertBox(obj, t, rect, 'manual', emptyPrompts());
  notify();
}

export function setBoxFromSam(objId, t, rect, source, prompts) {
  const obj = getObject(objId);
  if (!obj) return;
  history.checkpoint();
  upsertBox(obj, t, rect, source, prompts);
  notify();
}

// Prompt change without a new SAM result (e.g. the last positive point removed).
export function setBoxPrompts(objId, box, prompts) {
  const obj = getObject(objId);
  if (!obj || !obj.boxes.includes(box)) return;
  history.checkpoint();
  box.prompts = prompts;
  notify();
}

// Hand edit (handle drag / move).
export function setBoxRect(objId, box, rect) {
  const obj = getObject(objId);
  if (!obj || !obj.boxes.includes(box)) return;
  history.checkpoint();
  Object.assign(box, normalizeRect(rect), { edited: true });
  invalidate(obj);
  notify();
}

export function deleteBox(objId, box) {
  const obj = getObject(objId);
  if (!obj) return;
  const idx = obj.boxes.indexOf(box);
  if (idx === -1) return;
  history.checkpoint();
  obj.boxes.splice(idx, 1);
  invalidate(obj);
  notify();
}

// ---------- input settings (not undoable) ----------

export function setInputMode(mode) {
  state.inputMode = mode;
  notify();
}

export function setIsolate(on) {
  state.isolate = on;
  notify();
}

export function setViewMode(mode) {
  state.viewMode = mode;
  notify();
}

// Re-render listeners without a state change (e.g. a box overlay was rendered).
export function refresh() {
  notify();
}

export function setSamDecode(mode) {
  state.samDecode = mode;
  try {
    localStorage.setItem(SAM_DECODE_KEY, mode);
  } catch { /* storage unavailable: setting lasts this session only */ }
  notify();
}

function loadSamDecode() {
  try {
    return localStorage.getItem(SAM_DECODE_KEY) === 'browser' ? 'browser' : 'server';
  } catch {
    return 'server';
  }
}

// ---------- helpers ----------

function insertSorted(keys, key) {
  const idx = keys.findIndex((k) => k.t > key.t);
  if (idx === -1) keys.push(key);
  else keys.splice(idx, 0, key);
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
