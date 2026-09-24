// Box objects, 'sam-points' mode: left-click adds a positive point, right-click a
// negative one, right-clicking an existing marker removes it — all on the active
// object's keyframe for this frame (created if missing). Every change re-decodes
// all of the frame's prompts and overwrites the box (undo reverts it).

import {
  HIT_RADIUS, getActiveObject, getObject, boxAt, emptyPrompts, setBoxFromSam, setBoxPrompts,
} from '../state.js';
import { env, clientToNorm, localPx } from './common.js';
import { samPromptKey, enqueue, decode, storeMask } from '../sam/client.js';
import { currentKeyframe } from './boxEdit.js';

const MARKER_PX = 6;

export function onPointerDown(e) {
  if (e.ctrlKey) return; // macOS ctrl-click is a right-click: contextmenu handles it
  prompt(e, (prompts, pt) => prompts.points.push({ x: pt.x, y: pt.y, label: 1 }));
}

export function onContextMenu(e) {
  const marker = hitMarker(e);
  prompt(e, (prompts, pt) => {
    if (!marker) {
      prompts.points.push({ x: pt.x, y: pt.y, label: 0 });
      return;
    }
    const i = prompts.points.findIndex((p) => p.x === marker.x && p.y === marker.y && p.label === marker.label);
    if (i !== -1) prompts.points.splice(i, 1);
  });
}

function prompt(e, edit) {
  const active = getActiveObject();
  if (!active || active.type !== 'box') return;
  const key = samPromptKey();
  if (!key) return; // not paused / frame not encoded yet (status says which)
  const t = env.video.currentTime;
  const pt = clientToNorm(e);
  enqueue(() => applyPrompt(active.id, t, key, (prompts) => edit(prompts, pt)));
}

async function applyPrompt(objId, t, key, edit) {
  const obj = getObject(objId);
  if (!obj) return;
  const kf = boxAt(obj, t);
  const prompts = structuredClone(kf?.prompts ?? emptyPrompts());
  edit(prompts);

  // Nothing to segment without a positive point or a box prompt: keep the box.
  if (!prompts.box && !prompts.points.some((p) => p.label === 1)) {
    if (kf) setBoxPrompts(objId, kf, prompts);
    return;
  }
  const res = await decode(key, prompts);
  if (!res) return;
  setBoxFromSam(objId, t, res.box, 'sam-points', prompts);
  const cur = getObject(objId);
  if (cur) storeMask(cur, boxAt(cur, t), res.mask);
}

function hitMarker(e) {
  const cur = currentKeyframe();
  if (!cur) return null;
  const { px, py, w, h } = localPx(e);
  let best = null;
  let bestD = HIT_RADIUS;
  for (const p of cur.box.prompts.points) {
    const d = Math.hypot(p.x * w - px, p.y * h - py);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export function onHover() {
  return null;
}

// Prompt markers on the current keyframe (drawn in every box mode).
export function drawPromptMarkers(ctx, w, h) {
  const cur = currentKeyframe();
  if (!cur) return;
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5;
  for (const p of cur.box.prompts.points) {
    const x = p.x * w;
    const y = p.y * h;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.arc(x, y, MARKER_PX + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.label === 1 ? '#4ade80' : '#f87171';
    ctx.beginPath();
    ctx.moveTo(x - MARKER_PX, y);
    ctx.lineTo(x + MARKER_PX, y);
    if (p.label === 1) {
      ctx.moveTo(x, y - MARKER_PX);
      ctx.lineTo(x, y + MARKER_PX);
    }
    ctx.stroke();
  }
}

export function draw() {}
