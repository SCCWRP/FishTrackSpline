// Hand-editing the active box object's keyframe on the current frame: drag
// corners/edges to resize, the interior to move (not in SAM-points mode, where
// interior clicks are prompts). Runs before the active box input tool.

import { state, HIT_RADIUS, getActiveObject, boxAt, setBoxRect, beginBatch, endBatch } from '../state.js';
import { env, DRAG_CLICK_PX, clientToNorm, localPx, trackDrag } from './common.js';

const HANDLE_PX = 7;
const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move',
};

// { obj, box } for the active box object's keyframe on the displayed frame, or null.
export function currentKeyframe() {
  const obj = getActiveObject();
  if (!obj || obj.type !== 'box' || !obj.visible) return null;
  const box = boxAt(obj, env.video.currentTime);
  return box ? { obj, box } : null;
}

function hitPart(e, box) {
  const { px, py, w, h } = localPx(e);
  const x1 = box.x1 * w, x2 = box.x2 * w, y1 = box.y1 * h, y2 = box.y2 * h;
  const r = HIT_RADIUS;
  if (px < x1 - r || px > x2 + r || py < y1 - r || py > y2 + r) return null;
  const v = Math.abs(py - y1) <= r ? 'n' : Math.abs(py - y2) <= r ? 's' : '';
  const hz = Math.abs(px - x1) <= r ? 'w' : Math.abs(px - x2) <= r ? 'e' : '';
  if (v || hz) return v + hz;
  if (state.inputMode !== 'sam-points' && px > x1 && px < x2 && py > y1 && py < y2) return 'move';
  return null;
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

function applyDrag(part, o, dx, dy) {
  if (part === 'move') {
    const mx = Math.min(Math.max(dx, -o.x1), 1 - o.x2);
    const my = Math.min(Math.max(dy, -o.y1), 1 - o.y2);
    return { x1: o.x1 + mx, y1: o.y1 + my, x2: o.x2 + mx, y2: o.y2 + my };
  }
  const r = { ...o };
  if (part.includes('n')) r.y1 = clamp01(o.y1 + dy);
  if (part.includes('s')) r.y2 = clamp01(o.y2 + dy);
  if (part.includes('w')) r.x1 = clamp01(o.x1 + dx);
  if (part.includes('e')) r.x2 = clamp01(o.x2 + dx);
  return r; // setBoxRect normalizes x1 < x2, y1 < y2 if an edge was dragged past its opposite
}

// Returns true when the press landed on the current keyframe (and is handled here).
export function onPointerDown(e) {
  const cur = currentKeyframe();
  if (!cur) return false;
  const part = hitPart(e, cur.box);
  if (!part) return false;

  const start = clientToNorm(e);
  const orig = { x1: cur.box.x1, y1: cur.box.y1, x2: cur.box.x2, y2: cur.box.y2 };
  beginBatch(); // the whole drag is one undo entry
  trackDrag(e, {
    onMove(ev, moved) {
      if (moved < DRAG_CLICK_PX) return;
      const p = clientToNorm(ev);
      setBoxRect(cur.obj.id, cur.box, applyDrag(part, orig, p.x - start.x, p.y - start.y));
    },
    onEnd() {
      endBatch();
    },
  });
  return true;
}

export function onHover(e) {
  const cur = currentKeyframe();
  const part = cur && hitPart(e, cur.box);
  return part ? CURSORS[part] : null;
}

export function draw(ctx, _now, w, h) {
  const cur = currentKeyframe();
  if (!cur) return;
  const { x1, y1, x2, y2 } = cur.box;
  const xs = [x1 * w, ((x1 + x2) / 2) * w, x2 * w];
  const ys = [y1 * h, ((y1 + y2) / 2) * h, y2 * h];
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = cur.obj.color;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      const s = HANDLE_PX;
      ctx.fillRect(xs[i] - s / 2, ys[j] - s / 2, s, s);
      ctx.strokeRect(xs[i] - s / 2, ys[j] - s / 2, s, s);
    }
  }
}
