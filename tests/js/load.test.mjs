import test from 'node:test';
import assert from 'node:assert/strict';

import {
  state, addObject, addBox, loadAnnotations, contentSignature, canUndo, toggleVisible, resetHistory,
} from '../../static/js/state.js';

function reset() {
  state.objects = [];
  state.nextObjectNum = 1;
  state.nextObjectId = 1;
  resetHistory();
}

test('loadAnnotations restores an exported set and resets history/counters', () => {
  reset();
  addObject('point'); // something to replace, with undo history
  assert.ok(canUndo());
  const exported = {
    objects: [
      { id: 3, name: 'fish 3', color: '#E15759', type: 'box',
        boxes: [{ t: 1, x1: 0.5, y1: 0.5, x2: 0.2, y2: 0.1, source: 'sam-box', edited: true,
          prompts: { points: [{ x: 0.3, y: 0.3, label: 0 }], box: { x1: 0.1, y1: 0.1, x2: 0.6, y2: 0.6 } } }] },
      { id: 7, name: 'fish 7', color: '#4E79A7', type: 'point', points: [{ t: 2, x: 0.1, y: 0.2 }] },
    ],
  };
  const set = { uuid: 'u1', version: 2 };
  loadAnnotations(exported.objects, set);

  assert.equal(state.objects.length, 2);
  const [box, pt] = state.objects;
  assert.deepEqual([box.type, box.visible, pt.type], ['box', true, 'point']);
  assert.deepEqual([box.boxes[0].x1, box.boxes[0].x2, box.boxes[0].source, box.boxes[0].edited], [0.2, 0.5, 'sam-box', true]);
  assert.equal(box.boxes[0].prompts.points[0].label, 0);
  assert.equal(state.activeObjectId, 3);
  assert.equal(state.loadedSet, set);
  assert.equal(canUndo(), false, 'fresh history');
  assert.equal(state.nextObjectId, 8);

  const next = addObject('box');
  assert.equal(next.name, 'fish 8', 'numbering continues after the highest fish N');
});

test('older exports without a type load as point objects; missing box fields get defaults', () => {
  reset();
  loadAnnotations([
    { id: 1, name: 'a', color: '#000000', points: [{ t: 0, x: 0.5, y: 0.5 }] },
    { id: 2, name: 'b', color: '#111111', type: 'box', boxes: [{ t: 0, x1: 0, y1: 0, x2: 0.1, y2: 0.1 }] },
  ], null);
  assert.equal(state.objects[0].type, 'point');
  assert.deepEqual(state.objects[1].boxes[0].prompts, { points: [], box: null });
  assert.equal(state.objects[1].boxes[0].source, 'manual');
  assert.equal(state.nextObjectNum, 3);
});

test('contentSignature tracks annotation edits but not visibility', () => {
  reset();
  const obj = addObject('box');
  const sig = contentSignature();
  toggleVisible(obj.id);
  assert.equal(contentSignature(), sig);
  addBox(obj.id, 1, { x1: 0, y1: 0, x2: 0.2, y2: 0.2 });
  assert.notEqual(contentSignature(), sig);
});
