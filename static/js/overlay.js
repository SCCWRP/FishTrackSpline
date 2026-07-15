// Canvas overlay: DPR-aware sizing, normalized-coordinate mapping, per-frame
// drawing with temporal opacity falloff, and all pointer interactions.

import {
  state, HIT_RADIUS, alphaForDt,
  getActiveObject, setActiveObject, addPoint, movePoint, deletePoint,
} from './state.js';
import { trajectoryOf } from './spline.js';

const ALPHA_LEVELS = 16; // spline fade quantization — batches segments into few strokes
const DRAG_CLICK_PX = 3; // release under this total movement = click (seek), not drag

let video;
let canvas;
let ctx;

export function initOverlay(videoEl, canvasEl) {
  video = videoEl;
  canvas = canvasEl;
  ctx = canvas.getContext('2d');

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

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

function clientToNorm(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}

// ---------- drawing ----------

export function draw(now) {
  const r = canvas.getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  ctx.clearRect(0, 0, w, h);

  for (const obj of state.objects) {
    if (!obj.visible) continue;
    const { traj, samples } = trajectoryOf(obj);
    const isActive = obj.id === state.activeObjectId;

    if (samples) drawSpline(obj, samples, now, w, h);
    drawPoints(obj, isActive, now, w, h);
    if (traj && now >= traj.t0 && now <= traj.t1 && obj.points.length >= 2) {
      drawCrosshair(obj, traj.evalAt(now), w, h);
    }
  }
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

// ---------- interaction ----------

// Nearest point within HIT_RADIUS; the active object's points win over others'.
function hitTest(e) {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;

  let best = null;
  for (const obj of state.objects) {
    if (!obj.visible) continue;
    const isActive = obj.id === state.activeObjectId;
    for (const p of obj.points) {
      const d = Math.hypot(p.x * r.width - px, p.y * r.height - py);
      if (d > HIT_RADIUS) continue;
      if (!best || (isActive && !best.isActive) || (isActive === best.isActive && d < best.d)) {
        best = { obj, p, d, isActive };
      }
    }
  }
  return best;
}

function onPointerDown(e) {
  if (e.button !== 0 || !state.video.duration) return;
  const hit = hitTest(e);

  if (!hit) {
    const active = getActiveObject();
    if (!active) return;
    const { x, y } = clientToNorm(e);
    addPoint(active.id, video.currentTime, x, y);
    return;
  }

  if (!hit.isActive) {
    setActiveObject(hit.obj.id);
    video.currentTime = hit.p.t;
    return;
  }

  startDrag(e, hit.obj, hit.p);
}

function startDrag(e, obj, point) {
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  let moved = 0;
  let lastX = e.clientX;
  let lastY = e.clientY;

  const onMove = (ev) => {
    moved += Math.hypot(ev.clientX - lastX, ev.clientY - lastY);
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (moved >= DRAG_CLICK_PX) {
      const { x, y } = clientToNorm(ev);
      movePoint(obj.id, point, x, y);
    }
  };

  const onUp = () => {
    canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove('dragging');
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    if (moved < DRAG_CLICK_PX) video.currentTime = point.t;
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
}

function onHoverMove(e) {
  canvas.classList.toggle('over-point', !canvas.classList.contains('dragging') && !!hitTest(e));
}

function onContextMenu(e) {
  e.preventDefault();
  const hit = hitTest(e);
  if (hit) deletePoint(hit.obj.id, hit.p);
}
