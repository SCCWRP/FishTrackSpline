// Frame-based exports of box tracks: CVAT for video 1.1 XML and YOLO labels.
// Pure, no DOM. Frame indices are 0-based internally (CVAT); YOLO label files
// are named by 1-based frame number.

import { trajectoryOf } from './spline.js';

export const DEFAULT_LABEL = 'fish'; // CVAT label for every box track

// The frame on screen at time t (frame i spans [i / fps, (i + 1) / fps)).
export function frameIndex(t, fps) {
  return Math.floor(t * fps + 1e-6);
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

// One track per box object with keyframes, id = its order among them (also the
// YOLO class id). A box on every frame from the first to the last keyframe:
// the keyframe's own box on keyframe frames (the first one if two land on the
// same frame), the spline-interpolated box elsewhere.
export function boxTracks(objects, { fps, frames }) {
  const tracks = [];
  for (const obj of objects) {
    if (obj.type !== 'box' || obj.boxes.length === 0) continue;
    const { traj } = trajectoryOf(obj);
    const keyed = new Map(); // frame -> keyframe box
    for (const b of obj.boxes) {
      const f = Math.min(Math.max(frameIndex(b.t, fps), 0), frames - 1);
      if (!keyed.has(f)) keyed.set(f, b);
    }
    const kfFrames = [...keyed.keys()];
    const first = Math.min(...kfFrames);
    const last = Math.max(...kfFrames);
    const boxes = [];
    for (let f = first; f <= last; f++) {
      const k = keyed.get(f);
      const b = k ?? traj.evalBoxAt(f / fps);
      boxes.push({ frame: f, keyframe: !!k, x1: clamp01(b.x1), y1: clamp01(b.y1), x2: clamp01(b.x2), y2: clamp01(b.y2) });
    }
    tracks.push({ id: tracks.length, name: obj.name, boxes });
  }
  return tracks;
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

// CVAT for video 1.1 (annotations.xml). Each track ends with an outside="1" box
// on the frame after its last keyframe (when the video has one).
export function toCvatXml(tracks, { name, width, height, frames }, dumped = new Date().toISOString()) {
  const px = (v, s) => (v * s).toFixed(2);
  const box = (b, outside) =>
    `    <box frame="${b.frame}" keyframe="${b.keyframe || outside ? 1 : 0}" outside="${outside ? 1 : 0}" occluded="0" `
    + `xtl="${px(b.x1, width)}" ytl="${px(b.y1, height)}" xbr="${px(b.x2, width)}" ybr="${px(b.y2, height)}" z_order="0">\n    </box>`;

  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<annotations>',
    '  <version>1.1</version>',
    '  <meta>',
    '    <task>',
    `      <name>${xmlEscape(name)}</name>`,
    `      <size>${frames}</size>`,
    '      <mode>interpolation</mode>',
    '      <overlap>0</overlap>',
    '      <start_frame>0</start_frame>',
    `      <stop_frame>${frames - 1}</stop_frame>`,
    '      <labels>',
    `        <label>\n          <name>${xmlEscape(DEFAULT_LABEL)}</name>\n          <type>rectangle</type>\n          <attributes>\n          </attributes>\n        </label>`,
    '      </labels>',
    `      <original_size>\n        <width>${width}</width>\n        <height>${height}</height>\n      </original_size>`,
    '    </task>',
    `    <dumped>${dumped}</dumped>`,
    '  </meta>',
  ];
  for (const t of tracks) {
    lines.push(`  <track id="${t.id}" label="${xmlEscape(DEFAULT_LABEL)}" source="manual">`);
    for (const b of t.boxes) lines.push(box(b, false));
    const end = t.boxes[t.boxes.length - 1];
    if (end.frame + 1 < frames) lines.push(box({ ...end, frame: end.frame + 1 }, true));
    lines.push('  </track>');
  }
  lines.push('</annotations>', '');
  return lines.join('\n');
}

// YOLO labels: { "NNNNNNNNNN.txt": "class cx cy w h\n..." } — one file per frame
// that has a box (1-based frame number, zero-padded to 10), one line per track,
// class id = track id. Zero-area boxes are skipped.
export function toYoloLabels(tracks) {
  const byFrame = new Map();
  for (const t of tracks) {
    for (const b of t.boxes) {
      const w = b.x2 - b.x1;
      const h = b.y2 - b.y1;
      if (w <= 0 || h <= 0) continue;
      const line = [t.id, (b.x1 + w / 2).toFixed(6), (b.y1 + h / 2).toFixed(6), w.toFixed(6), h.toFixed(6)].join(' ');
      if (!byFrame.has(b.frame)) byFrame.set(b.frame, []);
      byFrame.get(b.frame).push(line);
    }
  }
  const files = {};
  for (const f of [...byFrame.keys()].sort((a, b) => a - b)) {
    files[`${String(f + 1).padStart(10, '0')}.txt`] = byFrame.get(f).join('\n') + '\n';
  }
  return files;
}
