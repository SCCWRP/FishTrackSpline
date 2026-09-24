// Point objects: click to add a keyframe, drag a point, click a point to seek,
// click another object's point to select it, right-click a point to delete.

import {
  state, HIT_RADIUS,
  getActiveObject, setActiveObject, addPoint, movePoint, deletePoint, beginBatch, endBatch,
} from '../state.js';
import { env, DRAG_CLICK_PX, clientToNorm, localPx, trackDrag } from './common.js';

// Nearest point within HIT_RADIUS; the active object's points win over others'.
function hitTest(e) {
  const { px, py, w, h } = localPx(e);
  let best = null;
  for (const obj of state.objects) {
    if (!obj.visible || obj.type !== 'point') continue;
    const isActive = obj.id === state.activeObjectId;
    for (const p of obj.points) {
      const d = Math.hypot(p.x * w - px, p.y * h - py);
      if (d > HIT_RADIUS) continue;
      if (!best || (isActive && !best.isActive) || (isActive === best.isActive && d < best.d)) {
        best = { obj, p, d, isActive };
      }
    }
  }
  return best;
}

export function onPointerDown(e) {
  const hit = hitTest(e);

  if (!hit) {
    const active = getActiveObject();
    if (!active) return;
    const { x, y } = clientToNorm(e);
    addPoint(active.id, env.video.currentTime, x, y);
    return;
  }

  if (!hit.isActive) {
    setActiveObject(hit.obj.id);
    env.video.currentTime = hit.p.t;
    return;
  }

  startDrag(e, hit.obj, hit.p);
}

function startDrag(e, obj, point) {
  beginBatch(); // the whole drag is one undo entry
  trackDrag(e, {
    onMove(ev, moved) {
      if (moved < DRAG_CLICK_PX) return;
      const { x, y } = clientToNorm(ev);
      movePoint(obj.id, point, x, y);
    },
    onEnd(_ev, moved) {
      endBatch();
      if (moved < DRAG_CLICK_PX) env.video.currentTime = point.t;
    },
  });
}

export function onHover(e) {
  return hitTest(e) ? 'grab' : null;
}

export function onContextMenu(e) {
  const hit = hitTest(e);
  if (hit) deletePoint(hit.obj.id, hit.p);
}

export function draw() {}
