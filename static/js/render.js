// Rendered overlays for box objects: the interpolated box sampled once per
// frame over the object's keyframe span, cached in memory. A render is tied to
// the keyframes it was made from — any box edit makes it stale (hidden in
// viewing mode until rendered again). Pure, no DOM.

import { trajectoryOf } from './spline.js';

export const RENDER_FPS = 60; // samples per second of video
export const RENDER_ALPHA = 0.25; // fill opacity of the rendered boxes

const renders = new Map(); // obj.id -> { sig, t0, count, rects: Float32Array(4 * count) }

// Keyframe geometry signature, memoized on the spline cache (cleared on every box edit).
function signature(obj) {
  const cache = trajectoryOf(obj);
  cache.sig ??= JSON.stringify(obj.boxes.map((b) => [b.t, b.x1, b.y1, b.x2, b.y2]));
  return cache.sig;
}

export function renderObject(obj) {
  const { traj } = trajectoryOf(obj);
  if (obj.type !== 'box' || !traj) return;
  // Last sample lands at or just past t1 (evalBoxAt clamps), so t1 itself is covered.
  const count = Math.ceil((traj.t1 - traj.t0) * RENDER_FPS) + 1;
  const rects = new Float32Array(4 * count);
  for (let i = 0; i < count; i++) {
    const b = traj.evalBoxAt(traj.t0 + i / RENDER_FPS);
    rects.set([b.x1, b.y1, b.x2, b.y2], 4 * i);
  }
  renders.set(obj.id, { sig: signature(obj), t0: traj.t0, count, rects });
}

// 'none' (never rendered) | 'fresh' | 'stale' (keyframes changed since)
export function renderStatus(obj) {
  const r = renders.get(obj.id);
  if (!r) return 'none';
  return r.sig === signature(obj) ? 'fresh' : 'stale';
}

// The rendered box for the frame at t, or null (outside the span, or not fresh).
export function renderedBoxAt(obj, t) {
  const r = renders.get(obj.id);
  if (!r || r.sig !== signature(obj)) return null;
  const i = Math.round((t - r.t0) * RENDER_FPS);
  if (i < 0 || i >= r.count) return null;
  const k = 4 * i;
  return { x1: r.rects[k], y1: r.rects[k + 1], x2: r.rects[k + 2], y2: r.rects[k + 3] };
}
