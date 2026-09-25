// Rendered overlays for box objects: the interpolated box sampled once per
// frame over the object's keyframe span, cached in memory. A render is tied to
// the keyframes it was made from — any box edit makes it stale (hidden in
// viewing mode until rendered again). Pure, no DOM.

import { trajectoryOf } from './spline.js';
import { frameIndex } from './formats.js';

export const RENDER_FPS = 60; // fallback frame rate when the video's is unknown
export const RENDER_ALPHA = 0.25; // fill opacity of the rendered boxes

const renders = new Map(); // obj.id -> { sig, fps, first (frame index), count, rects: Float32Array(4 * count) }

// Keyframe geometry signature, memoized on the spline cache (cleared on every box edit).
function signature(obj) {
  const cache = trajectoryOf(obj);
  cache.sig ??= JSON.stringify(obj.boxes.map((b) => [b.t, b.x1, b.y1, b.x2, b.y2]));
  return cache.sig;
}

// One box per video frame (frame i shown during [i / fps, (i + 1) / fps)),
// sampled at the frame's start time, over the frames the keyframes span.
export function renderObject(obj, fps = RENDER_FPS) {
  const { traj } = trajectoryOf(obj);
  if (obj.type !== 'box' || !traj) return;
  const first = frameIndex(traj.t0, fps);
  const count = frameIndex(traj.t1, fps) - first + 1;
  const rects = new Float32Array(4 * count);
  for (let i = 0; i < count; i++) {
    const b = traj.evalBoxAt((first + i) / fps);
    rects.set([b.x1, b.y1, b.x2, b.y2], 4 * i);
  }
  renders.set(obj.id, { sig: signature(obj), fps, first, count, rects });
}

// Forget every render (e.g. when a saved annotation set replaces the objects).
export function clearRenders() {
  renders.clear();
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
  const i = frameIndex(t, r.fps) - r.first;
  if (i < 0 || i >= r.count) return null;
  const k = 4 * i;
  return { x1: r.rects[k], y1: r.rects[k + 1], x2: r.rects[k + 2], y2: r.rects[k + 3] };
}
