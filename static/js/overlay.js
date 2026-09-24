// Canvas overlay: DPR-aware sizing, per-frame drawing with temporal opacity
// falloff, and pointer dispatch to the input tools (static/js/tools/).

import { state, HIT_RADIUS, alphaForDt, getActiveObject, setActiveObject, boxAt } from './state.js';
import { trajectoryOf } from './spline.js';
import { drawMask } from './sam/client.js';
import { initToolEnv, localPx } from './tools/common.js';
import * as pointTool from './tools/pointTool.js';
import * as boxEdit from './tools/boxEdit.js';
import * as boxDrawTool from './tools/boxDrawTool.js';
import * as samPointsTool from './tools/samPointsTool.js';

const ALPHA_LEVELS = 16; // spline fade quantization — batches segments into few strokes

let video;
let canvas;
let ctx;

export function initOverlay(videoEl, canvasEl) {
  video = videoEl;
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  initToolEnv(video, canvas);

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onHoverMove);
  canvas.addEventListener('contextmenu', onContextMenu);
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
}

// ---------- drawing ----------

export function draw(now) {
  const r = canvas.getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  ctx.clearRect(0, 0, w, h);

  const cur = boxEdit.currentKeyframe();
  if (cur) drawMask(ctx, cur.obj, cur.box, w, h);

  for (const obj of state.objects) {
    if (!obj.visible) continue;
    const isActive = obj.id === state.activeObjectId;
    if (obj.type === 'box') {
      drawBoxObject(obj, isActive, now, w, h);
      continue;
    }
    const { traj, samples } = trajectoryOf(obj);
    if (samples) drawSpline(obj, samples, now, w, h);
    drawPoints(obj, isActive, now, w, h);
    if (traj && now >= traj.t0 && now <= traj.t1 && obj.points.length >= 2) {
      drawCrosshair(obj, traj.evalAt(now), w, h);
    }
  }

  if (cur) {
    samPointsTool.drawPromptMarkers(ctx, w, h);
    boxEdit.draw(ctx, now, w, h);
  }
  boxDrawTool.draw(ctx, now, w, h);
  ctx.globalAlpha = 1;
}

// Per-segment alpha quantized to ALPHA_LEVELS; consecutive same-level samples
// are batched into a single stroke so the fade gradient costs few draw calls.
function drawSpline(obj, samples, now, w, h) {
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  let level = -1;
  let open = false;
  for (let i = 0; i < samples.length - 1; i++) {
    const midT = (samples[i].t + samples[i + 1].t) / 2;
    const l = Math.round(alphaForDt(midT - now) * (ALPHA_LEVELS - 1));
    if (l !== level) {
      if (open) ctx.stroke();
      level = l;
      ctx.globalAlpha = level / (ALPHA_LEVELS - 1);
      ctx.beginPath();
      ctx.moveTo(samples[i].x * w, samples[i].y * h);
      open = true;
    }
    ctx.lineTo(samples[i + 1].x * w, samples[i + 1].y * h);
  }
  if (open) ctx.stroke();
}

function drawPoints(obj, isActive, now, w, h) {
  const radius = isActive ? 6 : 5;
  let nearest = null;
  if (isActive) {
    for (const p of obj.points) {
      if (!nearest || Math.abs(p.t - now) < Math.abs(nearest.t - now)) nearest = p;
    }
  }
  for (const p of obj.points) {
    ctx.globalAlpha = alphaForDt(p.t - now);
    ctx.fillStyle = obj.color;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
    ctx.fill();
    if (p === nearest) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawCrosshair(obj, pos, w, h) {
  const x = pos.x * w;
  const y = pos.y * h;
  const s = 9;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.stroke();
}

// Center path, keyframe rectangles faded by time distance, and the interpolated
// box (dashed) between keyframes.
function drawBoxObject(obj, isActive, now, w, h) {
  const { traj, samples } = trajectoryOf(obj);
  if (samples) drawSpline(obj, samples, now, w, h);

  ctx.strokeStyle = obj.color;
  ctx.lineWidth = isActive ? 2 : 1.5;
  for (const b of obj.boxes) {
    ctx.globalAlpha = alphaForDt(b.t - now);
    ctx.strokeRect(b.x1 * w, b.y1 * h, (b.x2 - b.x1) * w, (b.y2 - b.y1) * h);
  }

  const b = interpolatedBox(obj, traj, now);
  if (b) {
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x1 * w, b.y1 * h, (b.x2 - b.x1) * w, (b.y2 - b.y1) * h);
    ctx.setLineDash([]);
  }
}

function interpolatedBox(obj, traj, now) {
  if (!traj || obj.boxes.length < 2 || now < traj.t0 || now > traj.t1 || boxAt(obj, now)) return null;
  return traj.evalBoxAt(now);
}

// ---------- interaction ----------

function currentTool() {
  if (getActiveObject()?.type !== 'box') return pointTool;
  return state.inputMode === 'sam-points' ? samPointsTool : boxDrawTool;
}

// Another visible box object whose displayed box (keyframe or interpolated) has
// an edge under the pointer — clicking it selects that object.
function otherBoxEdgeAt(e) {
  const { px, py, w, h } = localPx(e);
  const r = HIT_RADIUS;
  for (const obj of state.objects) {
    if (!obj.visible || obj.type !== 'box' || obj.id === state.activeObjectId) continue;
    const now = video.currentTime;
    const b = boxAt(obj, now) ?? interpolatedBox(obj, trajectoryOf(obj).traj, now);
    if (!b) continue;
    const x1 = b.x1 * w, x2 = b.x2 * w, y1 = b.y1 * h, y2 = b.y2 * h;
    if (px < x1 - r || px > x2 + r || py < y1 - r || py > y2 + r) continue;
    if (Math.abs(px - x1) <= r || Math.abs(px - x2) <= r || Math.abs(py - y1) <= r || Math.abs(py - y2) <= r) {
      return obj;
    }
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0 || !state.video.duration) return;
  if (getActiveObject()?.type === 'box' && boxEdit.onPointerDown(e)) return;
  const other = otherBoxEdgeAt(e);
  if (other) {
    setActiveObject(other.id);
    return;
  }
  currentTool().onPointerDown(e);
}

function onHoverMove(e) {
  if (canvas.classList.contains('dragging')) return;
  const cursor = (getActiveObject()?.type === 'box' && boxEdit.onHover(e))
    || (otherBoxEdgeAt(e) && 'pointer')
    || currentTool().onHover(e);
  canvas.style.cursor = cursor || '';
}

function onContextMenu(e) {
  e.preventDefault();
  if (!state.video.duration) return;
  currentTool().onContextMenu(e);
}
