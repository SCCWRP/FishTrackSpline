import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../../static/js/history.js';
import {
  state, addObject, addPoint, movePoint, addBox, setBoxRect, setBoxFromSam, deleteBox,
  renameObject, toggleVisible, undo, redo, canUndo, canRedo, beginBatch, endBatch,
  resetHistory, boxAt,
} from '../../static/js/state.js';
import { trajectoryOf } from '../../static/js/spline.js';

function reset() {
  state.objects = [];
  state.activeObjectId = null;
  state.nextObjectNum = 1;
  state.nextObjectId = 1;
  resetHistory();
}

test('createHistory: undo/redo, batching, limit', () => {
  let value = 0;
  const h = createHistory({ capture: () => value, restore: (v) => { value = v; }, limit: 3 });
  h.checkpoint(); value = 1;
  h.checkpoint(); value = 2;
  assert.ok(h.undo()); assert.equal(value, 1);
  assert.ok(h.redo()); assert.equal(value, 2);

  h.beginBatch();
  h.checkpoint(); value = 3;
  h.checkpoint(); value = 4; // same batch: no new entry
  h.endBatch();
  h.undo(); assert.equal(value, 2);
  h.redo(); assert.equal(value, 4);

  h.checkpoint(); value = 5;
  assert.equal(h.canRedo(), false, 'a new edit clears redo');
  for (let i = 0; i < 10; i++) { h.checkpoint(); value = 6 + i; }
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, 3, 'capped at limit');
});

test('state: every keyframe edit is undoable, drag batches are one entry', () => {
  reset();
  const fish = addObject('point');
  resetHistory(); // mirrors main.js: the startup object is not undoable
  assert.equal(canUndo(), false);

  addPoint(fish.id, 1, 0.1, 0.2);
  beginBatch();
  for (let i = 1; i <= 5; i++) movePoint(fish.id, fish.points[0], 0.1 + i * 0.01, 0.2);
  endBatch();
  assert.equal(state.objects[0].points[0].x.toFixed(2), '0.15');

  undo(); // the whole drag
  assert.equal(state.objects[0].points[0].x, 0.1);
  undo(); // the add
  assert.equal(state.objects[0].points.length, 0);
  assert.equal(canUndo(), false);
  redo(); redo();
  assert.equal(state.objects[0].points[0].x.toFixed(2), '0.15');
});

test('state: box keyframes, SAM overwrite of a hand edit can be undone', () => {
  reset();
  const box = addObject('box');
  assert.equal(box.type, 'box');
  addBox(box.id, 2, { x1: 0.5, y1: 0.5, x2: 0.2, y2: 0.1 }); // normalized on store
  const k = boxAt(box, 2.01);
  assert.deepEqual([k.x1, k.y1, k.x2, k.y2, k.source, k.edited], [0.2, 0.1, 0.5, 0.5, 'manual', false]);

  setBoxRect(box.id, k, { x1: 0.2, y1: 0.1, x2: 0.6, y2: 0.5 });
  assert.equal(boxAt(state.objects[0], 2).edited, true);

  const prompts = { points: [{ x: 0.4, y: 0.3, label: 1 }], box: null };
  setBoxFromSam(box.id, 2, { x1: 0.3, y1: 0.2, x2: 0.45, y2: 0.4 }, 'sam-points', prompts);
  let cur = boxAt(state.objects[0], 2);
  assert.deepEqual([cur.x2, cur.source, cur.edited], [0.45, 'sam-points', false]);
  assert.equal(state.objects[0].boxes.length, 1, 'same frame replaces');

  undo(); // back to the hand edit
  cur = boxAt(state.objects[0], 2);
  assert.deepEqual([cur.x2, cur.source, cur.edited], [0.6, 'manual', true]);
  assert.deepEqual(cur.prompts, { points: [], box: null });

  redo();
  deleteBox(box.id, boxAt(state.objects[0], 2));
  assert.equal(state.objects[0].boxes.length, 0);
  undo();
  assert.equal(state.objects[0].boxes.length, 1);
});

test('state: snapshots drop caches; visibility and no-op renames are not history', () => {
  reset();
  const a = addObject('box');
  addBox(a.id, 0, { x1: 0, y1: 0, x2: 0.1, y2: 0.1 });
  addBox(a.id, 1, { x1: 0.2, y1: 0, x2: 0.3, y2: 0.1 });
  trajectoryOf(state.objects[0]); // populate _cache (holds functions)
  addBox(a.id, 2, { x1: 0.4, y1: 0, x2: 0.5, y2: 0.1 });

  toggleVisible(a.id); // hide after the edit
  undo();
  assert.equal(state.objects[0].boxes.length, 2);
  assert.equal(state.objects[0].visible, false, 'eye toggle survives undo');
  assert.equal(state.objects[0]._cache, undefined);

  const before = canRedo();
  renameObject(a.id, state.objects[0].name); // unchanged name: no entry
  assert.equal(canRedo(), before);
});

test('state: batch groups object creation with its first box', () => {
  reset();
  const first = addObject('box');
  resetHistory();
  beginBatch();
  const obj = addObject('box');
  addBox(obj.id, 0, { x1: 0, y1: 0, x2: 0.2, y2: 0.2 });
  endBatch();
  assert.equal(state.objects.length, 2);
  assert.equal(state.activeObjectId, obj.id);
  undo();
  assert.equal(state.objects.length, 1);
  assert.equal(state.activeObjectId, first.id);
  assert.equal(canUndo(), false);
});
