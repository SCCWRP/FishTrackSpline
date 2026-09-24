import test from 'node:test';
import assert from 'node:assert/strict';

import { renderObject, renderStatus, renderedBoxAt, RENDER_FPS } from '../../static/js/render.js';
import { trajectoryOf } from '../../static/js/spline.js';
import { state, addObject, addBox, setBoxRect, setBoxPrompts, undo, resetHistory } from '../../static/js/state.js';

function freshBoxObject() {
  state.objects = [];
  resetHistory();
  const obj = addObject('box');
  addBox(obj.id, 1, { x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3 });
  addBox(obj.id, 2, { x1: 0.5, y1: 0.4, x2: 0.7, y2: 0.8 });
  addBox(obj.id, 3.5, { x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.5 });
  return obj;
}

test('render samples the interpolated box once per frame over the keyframe span', () => {
  const obj = freshBoxObject();
  assert.equal(renderStatus(obj), 'none');
  assert.equal(renderedBoxAt(obj, 2), null, 'nothing before rendering');

  renderObject(obj);
  assert.equal(renderStatus(obj), 'fresh');
  const { traj } = trajectoryOf(obj);
  for (const t of [1, 1 + 7 / RENDER_FPS, 2, 3.5]) {
    const r = renderedBoxAt(obj, t);
    const e = traj.evalBoxAt(t);
    for (const k of ['x1', 'y1', 'x2', 'y2']) assert.ok(Math.abs(r[k] - e[k]) < 1e-6, `${k} at ${t}`);
  }
  assert.equal(renderedBoxAt(obj, 0.9), null, 'before first keyframe');
  assert.equal(renderedBoxAt(obj, 3.6), null, 'after last keyframe');
});

test('box edits make the render stale (hidden); undo back makes it fresh again', () => {
  const obj = freshBoxObject();
  renderObject(obj);
  setBoxPrompts(obj.id, obj.boxes[0], { points: [{ x: 0.2, y: 0.2, label: 1 }], box: null });
  assert.equal(renderStatus(state.objects[0]), 'fresh', 'prompt-only change keeps geometry');

  setBoxRect(obj.id, state.objects[0].boxes[1], { x1: 0.5, y1: 0.4, x2: 0.75, y2: 0.8 });
  assert.equal(renderStatus(state.objects[0]), 'stale');
  assert.equal(renderedBoxAt(state.objects[0], 2), null);

  undo();
  assert.equal(renderStatus(state.objects[0]), 'fresh');
  assert.ok(renderedBoxAt(state.objects[0], 2));
});

test('single keyframe renders one frame', () => {
  state.objects = [];
  const obj = addObject('box');
  addBox(obj.id, 4, { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 });
  renderObject(obj);
  assert.deepEqual(Object.values(renderedBoxAt(obj, 4)).map((v) => +v.toFixed(3)), [0.1, 0.1, 0.2, 0.2]);
  assert.equal(renderedBoxAt(obj, 4 + 1 / RENDER_FPS), null);
});
