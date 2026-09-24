import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrajectory, pointTrajectory, boxTrajectory, trajectoryOf } from '../../static/js/spline.js';

const boxes = [
  { t: 0, x1: 0.10, y1: 0.20, x2: 0.30, y2: 0.35 },
  { t: 1, x1: 0.25, y1: 0.22, x2: 0.50, y2: 0.40 },
  { t: 2.5, x1: 0.40, y1: 0.30, x2: 0.60, y2: 0.55 },
  { t: 3, x1: 0.42, y1: 0.28, x2: 0.70, y2: 0.50 },
];

function close(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

test('box center+size interpolation equals corner interpolation', () => {
  const box = boxTrajectory(boxes);
  const corners = buildTrajectory(boxes.map((b) => b.t), [
    boxes.map((b) => b.x1), boxes.map((b) => b.y1), boxes.map((b) => b.x2), boxes.map((b) => b.y2),
  ]);
  for (let t = 0; t <= 3; t += 0.05) {
    const b = box.evalBoxAt(t);
    const [x1, y1, x2, y2] = corners.evalAt(t);
    close(b.x1, x1); close(b.y1, y1); close(b.x2, x2); close(b.y2, y2);
  }
});

test('box passes through its keyframes and clamps outside [t0, t1]', () => {
  const box = boxTrajectory(boxes);
  for (const k of boxes) {
    const b = box.evalBoxAt(k.t);
    close(b.x1, k.x1); close(b.y1, k.y1); close(b.x2, k.x2); close(b.y2, k.y2);
  }
  assert.deepEqual(box.evalBoxAt(-5), box.evalBoxAt(0));
  assert.deepEqual(box.evalBoxAt(99), box.evalBoxAt(3));
  const c = box.evalAt(1);
  close(c.x, (0.25 + 0.50) / 2); close(c.y, (0.22 + 0.40) / 2);
});

test('box width/height are clamped >= 0 when the spline overshoots', () => {
  // A sharp size step between closely spaced keyframes -> w(t) undershoots below 0.
  const keys = [
    { t: 0, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    { t: 1, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    { t: 1.1, x1: 0.5, y1: 0.5, x2: 0.51, y2: 0.51 },
    { t: 2, x1: 0.5, y1: 0.5, x2: 0.51, y2: 0.51 },
  ];
  const w = buildTrajectory(keys.map((k) => k.t), [keys.map((k) => k.x2 - k.x1)]);
  let sawNegative = false;
  const box = boxTrajectory(keys);
  for (let t = 0; t <= 2; t += 0.005) {
    if (w.evalAt(t)[0] < 0) sawNegative = true;
    const b = box.evalBoxAt(t);
    assert.ok(b.x2 >= b.x1 && b.y2 >= b.y1, `inverted box at t=${t}`);
  }
  assert.ok(sawNegative, 'fixture should overshoot below zero width');
});

test('1 and 2 keyframes: hold and linear', () => {
  const one = boxTrajectory(boxes.slice(0, 1));
  const held = one.evalBoxAt(7);
  close(held.x1, 0.10); close(held.y1, 0.20); close(held.x2, 0.30); close(held.y2, 0.35);
  const two = boxTrajectory(boxes.slice(0, 2));
  const mid = two.evalBoxAt(0.5);
  close(mid.x1, 0.175); close(mid.x2, 0.40);
  assert.equal(boxTrajectory([]), null);
});

test('point trajectory keeps the {x, y} API', () => {
  const traj = pointTrajectory([{ t: 0, x: 0, y: 0 }, { t: 2, x: 1, y: 0.5 }]);
  assert.deepEqual(traj.evalAt(1), { x: 0.5, y: 0.25 });
});

test('trajectoryOf samples box centers and caches', () => {
  const obj = { type: 'box', boxes };
  const { traj, samples } = trajectoryOf(obj);
  assert.ok(traj.evalBoxAt);
  assert.ok(samples.length > 2);
  close(samples[0].x, 0.2); close(samples[0].y, 0.275);
  assert.equal(trajectoryOf(obj), obj._cache);
  assert.equal(trajectoryOf({ type: 'box', boxes: boxes.slice(0, 1) }).samples, null);
});
