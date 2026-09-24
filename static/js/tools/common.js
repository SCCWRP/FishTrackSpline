// Shared plumbing for the input tools: the video/canvas, coordinate mapping,
// and pointer-capture drags. Every tool module exports
// { onPointerDown(e), onContextMenu(e), onHover(e) -> cursor | null, draw(ctx, now, w, h) }.

export const DRAG_CLICK_PX = 3; // release under this total movement = click, not drag

export const env = { video: null, canvas: null };

export function initToolEnv(video, canvas) {
  env.video = video;
  env.canvas = canvas;
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

export function clientToNorm(e) {
  const r = env.canvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}

// Pointer position in CSS px relative to the canvas, plus the canvas size.
export function localPx(e) {
  const r = env.canvas.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height };
}

// Capture the pointer until release. onMove(ev, moved) / onEnd(ev, moved), where
// moved is the total pointer travel in CSS px.
export function trackDrag(e, { onMove, onEnd }) {
  const { canvas } = env;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  if (canvas.style.cursor === 'grab') canvas.style.cursor = 'grabbing';
  let moved = 0;
  let lastX = e.clientX;
  let lastY = e.clientY;

  const move = (ev) => {
    moved += Math.hypot(ev.clientX - lastX, ev.clientY - lastY);
    lastX = ev.clientX;
    lastY = ev.clientY;
    onMove?.(ev, moved);
  };

  const end = (ev) => {
    canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove('dragging');
    if (canvas.style.cursor === 'grabbing') canvas.style.cursor = 'grab';
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', end);
    canvas.removeEventListener('pointercancel', end);
    onEnd?.(ev, moved);
  };

  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
