// Parity values shared with tests/test_sam_service.py (Python build_prompt / mask_to_box).
import test from 'node:test';
import assert from 'node:assert/strict';

import { preprocessShape, buildPrompt, maskToBox, maskFromLogits, float16ToFloat32 } from '../../static/js/sam/transform.js';

function allClose(actual, expected, eps = 1e-4) {
  assert.equal(actual.length, expected.length);
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < eps, `[${i}] ${actual[i]} != ${v}`));
}

test('preprocessShape matches Python', () => {
  assert.deepEqual(preprocessShape(720, 1280), [576, 1024]);
  assert.deepEqual(preprocessShape(1080, 1917), [577, 1024]);
  assert.deepEqual(preprocessShape(1280, 720), [1024, 576]);
});

test('points get a padding point, per-axis scaling', () => {
  const { coords, labels, n } = buildPrompt(
    { points: [{ x: 0.5, y: 0.5, label: 1 }, { x: 0.25, y: 0.75, label: 0 }], box: null }, 1080, 1917);
  assert.equal(n, 3);
  allClose(coords, [512.0, 288.5, 256.0, 432.75, 0, 0]);
  assert.deepEqual([...labels], [1, 0, -1]);
});

test('box prompt: labels 2/3, no padding', () => {
  const { coords, labels, n } = buildPrompt(
    { points: [], box: { x1: 0.25, y1: 0.25, x2: 0.75, y2: 0.75 } }, 1080, 1917);
  assert.equal(n, 2);
  allClose(coords, [256.0, 144.25, 768.0, 432.75]);
  assert.deepEqual([...labels], [2, 3]);
});

test('maskToBox matches Python', () => {
  const w = 20, h = 10;
  const logits = new Float32Array(w * h).fill(-1);
  assert.equal(maskToBox(maskFromLogits(logits), w, h), null);
  for (let y = 2; y < 5; y++) for (let x = 4; x < 10; x++) logits[y * w + x] = 3;
  assert.deepEqual(maskToBox(maskFromLogits(logits), w, h), { x1: 4 / 20, y1: 2 / 10, x2: 10 / 20, y2: 5 / 10 });
});

test('float16 decoding', () => {
  const out = float16ToFloat32(new Uint16Array([0x3c00, 0xc000, 0x3555, 0x0000, 0x0001, 0x7c00]));
  assert.equal(out[0], 1);
  assert.equal(out[1], -2);
  assert.ok(Math.abs(out[2] - 0.33325) < 1e-5);
  assert.equal(out[3], 0);
  assert.equal(out[4], 2 ** -24);
  assert.equal(out[5], Infinity);
});
