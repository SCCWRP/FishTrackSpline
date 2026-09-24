// Box objects, 'manual-box' / 'sam-box' modes: drag a rectangle. It becomes a
// keyframe of the active object, unless that object already has one on this
// frame — then a new box object is created. sam-box sends the rectangle as a
// SAM box prompt and keeps the mask's bounding box. Right-click: in manual-box
// mode, inside the current keyframe deletes it; in sam-box mode, adds a negative
// point prompt to this frame's box prompt (or removes a clicked marker).

import {
  state, getActiveObject, getObject, boxAt, addObject, addBox, setBoxFromSam, deleteBox,
  beginBatch, endBatch, normalizeRect,
} from '../state.js';
import { env, DRAG_CLICK_PX, clientToNorm, localPx, trackDrag } from './common.js';
import { samPromptKey, enqueue, decode, storeMask } from '../sam/client.js';
import { currentKeyframe } from './boxEdit.js';
import * as samPointsTool from './samPointsTool.js';

let band = null; // rubber-band rect (normalized) while dragging

export function onPointerDown(e) {
  const active = getActiveObject();
  if (!active || active.type !== 'box') return;
  const sam = state.inputMode === 'sam-box';
  const key = sam ? samPromptKey() : null;
  if (sam && !key) return; // not paused / frame not encoded yet (status says which)

  const t = env.video.currentTime;
  const start = clientToNorm(e);
  band = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
  trackDrag(e, {
    onMove(ev) {
      const p = clientToNorm(ev);
      band = { ...band, x2: p.x, y2: p.y };
    },
    onEnd() {
      const rect = normalizeRect(band);
      band = null;
      const { w, h } = localPx(e);
      if ((rect.x2 - rect.x1) * w < DRAG_CLICK_PX || (rect.y2 - rect.y1) * h < DRAG_CLICK_PX) return;
      if (sam) enqueue(() => commitSam(active.id, t, key, rect));
      else addToObjectOrNew(active.id, t, (id) => addBox(id, t, rect));
    },
  });
}

// Apply to objId unless it already has a keyframe at t (or is gone): then create
// a new box object for it. Creation + first keyframe are one undo entry.
function addToObjectOrNew(objId, t, apply) {
  const obj = getObject(objId);
  if (obj && !boxAt(obj, t)) {
    apply(obj.id);
    return obj;
  }
  beginBatch();
  const created = addObject('box');
  apply(created.id);
  endBatch();
  return created;
}

async function commitSam(objId, t, key, rect) {
  const prompts = { points: [], box: rect };
  const res = await decode(key, prompts);
  if (!res) return;
  const obj = addToObjectOrNew(objId, t, (id) => setBoxFromSam(id, t, res.box, 'sam-box', prompts));
  storeMask(obj, boxAt(obj, t), res.mask);
}

export function onContextMenu(e) {
  if (state.inputMode === 'sam-box') {
    samPointsTool.onContextMenu(e);
    return;
  }
  const cur = currentKeyframe();
  if (!cur) return;
  const { x, y } = clientToNorm(e);
  const b = cur.box;
  if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) deleteBox(cur.obj.id, b);
}

export function onHover() {
  return null;
}

export function draw(ctx, _now, w, h) {
  if (!band) return;
  const r = normalizeRect(band);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(r.x1 * w, r.y1 * h, (r.x2 - r.x1) * w, (r.y2 - r.y1) * h);
  ctx.setLineDash([]);
}
