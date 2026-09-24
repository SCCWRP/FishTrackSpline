import test from 'node:test';
import assert from 'node:assert/strict';

import { frameIndex, boxTracks, toCvatXml, toYoloLabels } from '../../static/js/formats.js';

const FPS = 60000 / 1001; // 59.94
const video = { fps: FPS, frames: 977 };

function boxObj(name, keys) {
  return { type: 'box', name, boxes: keys.map(([t, x1, y1, x2, y2]) => ({ t, x1, y1, x2, y2 })) };
}

test('frameIndex: the frame on screen at t', () => {
  assert.equal(frameIndex(0, FPS), 0);
  assert.equal(frameIndex(1001 / 60000, FPS), 1, 'exact frame start');
  assert.equal(frameIndex(5, FPS), 299);
  assert.equal(frameIndex(2 * 1001 / 60000 - 1e-4, FPS), 1);
});

test('boxTracks: every frame between keyframes, keyframes flagged, ids in order', () => {
  const objs = [
    { type: 'point', name: 'p', points: [{ t: 1, x: 0.5, y: 0.5 }] },
    boxObj('fish 2', [[1, 0.1, 0.1, 0.2, 0.2], [2, 0.3, 0.1, 0.4, 0.2]]),
    boxObj('empty', []),
    boxObj('fish 4', [[0.5, 0.5, 0.5, 0.6, 0.7]]),
  ];
  const tracks = boxTracks(objs, video);
  assert.deepEqual(tracks.map((t) => [t.id, t.name]), [[0, 'fish 2'], [1, 'fish 4']]);
  const [a, b] = tracks;
  const f0 = frameIndex(1, FPS), f1 = frameIndex(2, FPS);
  assert.equal(a.boxes.length, f1 - f0 + 1);
  assert.deepEqual(a.boxes.filter((x) => x.keyframe).map((x) => x.frame), [f0, f1]);
  assert.deepEqual(a.boxes[0], { frame: f0, keyframe: true, x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 });
  const mid = a.boxes[Math.floor(a.boxes.length / 2)];
  assert.ok(mid.x1 > 0.15 && mid.x1 < 0.25 && !mid.keyframe);
  assert.equal(b.boxes.length, 1);
});

test('two keyframes on the same frame: the first one wins', () => {
  // 0.005 s apart: both inside frame 60 at 59.94 fps
  const tracks = boxTracks([boxObj('f', [[1.002, 0.1, 0.1, 0.2, 0.2], [1.007, 0.5, 0.5, 0.6, 0.6]])], video);
  assert.equal(tracks[0].boxes.length, 1);
  assert.equal(tracks[0].boxes[0].x1, 0.1);
});

test('boxes are clamped to the frame', () => {
  const tracks = boxTracks([boxObj('f', [[0, -0.1, 0.9, 0.2, 1.2]])], video);
  assert.deepEqual(tracks[0].boxes[0], { frame: 0, keyframe: true, x1: 0, y1: 0.9, x2: 0.2, y2: 1 });
});

test('CVAT XML: header, px coords, keyframe flags, outside box ends the track', () => {
  const tracks = boxTracks([boxObj('f', [[0, 0.1, 0.2, 0.3, 0.4], [2 / FPS, 0.2, 0.2, 0.4, 0.4]])], video);
  const xml = toCvatXml(tracks, { name: 'clip & <x>', width: 1280, height: 720, frames: 977 }, 'T');
  assert.match(xml, /<mode>interpolation<\/mode>/);
  assert.match(xml, /<name>clip &amp; &lt;x&gt;<\/name>/);
  assert.match(xml, /<size>977<\/size>/);
  assert.match(xml, /<stop_frame>976<\/stop_frame>/);
  assert.match(xml, /<track id="0" label="fish" source="manual">/);
  assert.match(xml, /<box frame="0" keyframe="1" outside="0" occluded="0" xtl="128.00" ytl="144.00" xbr="384.00" ybr="288.00" z_order="0">/);
  assert.match(xml, /<box frame="1" keyframe="0" outside="0"/);
  assert.match(xml, /<box frame="2" keyframe="1" outside="0"/);
  assert.match(xml, /<box frame="3" keyframe="1" outside="1" occluded="0" xtl="256.00"/);
  assert.equal((xml.match(/<box /g) || []).length, 4);
});

test('CVAT XML: no outside box when the track ends on the last frame', () => {
  const tracks = boxTracks([boxObj('f', [[976 / FPS, 0.1, 0.1, 0.2, 0.2]])], video);
  const xml = toCvatXml(tracks, { name: 'c', width: 10, height: 10, frames: 977 });
  assert.equal((xml.match(/<box /g) || []).length, 1);
  assert.doesNotMatch(xml, /outside="1"/);
});

test('YOLO: one file per frame, 1-based zero-padded names, class = track id, one line per track', () => {
  const objs = [
    boxObj('a', [[0, 0.1, 0.2, 0.3, 0.6]]),
    boxObj('b', [[0, 0.5, 0.5, 0.7, 0.9], [1 / FPS, 0.5, 0.5, 0.7, 0.9]]),
    boxObj('flat', [[0, 0.1, 0.1, 0.1, 0.3]]), // zero width: skipped
  ];
  const files = toYoloLabels(boxTracks(objs, video));
  assert.deepEqual(Object.keys(files), ['0000000001.txt', '0000000002.txt']);
  assert.equal(files['0000000001.txt'], '0 0.200000 0.400000 0.200000 0.400000\n1 0.600000 0.700000 0.200000 0.400000\n');
  assert.equal(files['0000000002.txt'], '1 0.600000 0.700000 0.200000 0.400000\n');
});
