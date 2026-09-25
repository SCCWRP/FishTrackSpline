// Export keyframes as JSON + CSVs (points, boxes), plus box tracks as CVAT for
// video XML and YOLO labels, saved on the server as a new versioned annotation
// set (_OUTPUT/<uuid>/, indexed in _OUTPUT/annotation_sets.json). Download
// fetches a saved set's folder as a zip.

import { state, setLoadedSet } from './state.js';
import { boxTracks, toCvatXml, toYoloLabels } from './formats.js';

function videoBasename() {
  const name = state.video.url.split('/').pop() || 'video';
  return name.replace(/\.[^.]+$/, '');
}

export function toJSON() {
  return JSON.stringify(
    {
      video: { ...state.video },
      exportedAt: new Date().toISOString(),
      objects: state.objects.map((o) => ({
        id: o.id,
        name: o.name,
        color: o.color,
        type: o.type,
        ...(o.type === 'box'
          ? {
            boxes: o.boxes.map((b) => ({
              t: b.t, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
              source: b.source, edited: b.edited, prompts: b.prompts,
            })),
          }
          : { points: o.points.map((p) => ({ t: p.t, x: p.x, y: p.y })) }),
      })),
    },
    null,
    2,
  );
}

function csvQuote(s) {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCSV() {
  const { width, height } = state.video;
  const lines = ['object,time,x_norm,y_norm,x_px,y_px'];
  for (const obj of state.objects) {
    if (obj.type !== 'point') continue;
    for (const p of obj.points) {
      lines.push([
        csvQuote(obj.name),
        p.t.toFixed(3),
        p.x.toFixed(3),
        p.y.toFixed(3),
        (p.x * width).toFixed(1),
        (p.y * height).toFixed(1),
      ].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

export function toBoxesCSV() {
  const { width, height } = state.video;
  const dims = ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'w', 'h'];
  const lines = [[
    'object', 'time', ...dims.map((d) => `${d}_norm`), ...dims.map((d) => `${d}_px`), 'source', 'edited',
  ].join(',')];
  for (const obj of state.objects) {
    if (obj.type !== 'box') continue;
    for (const b of obj.boxes) {
      const v = [b.x1, b.y1, b.x2, b.y2, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, b.x2 - b.x1, b.y2 - b.y1];
      const scale = [width, height, width, height, width, height, width, height];
      lines.push([
        csvQuote(obj.name),
        b.t.toFixed(3),
        ...v.map((x) => x.toFixed(3)),
        ...v.map((x, i) => (x * scale[i]).toFixed(1)),
        b.source,
        b.edited,
      ].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

// fps / frame count come from the server (read from the video file), once.
async function ensureVideoInfo() {
  if (state.video.fps) return;
  const res = await fetch(`/api/video/info?video=${encodeURIComponent(state.video.id)}`);
  if (!res.ok) throw new Error(`video info failed: ${res.status}`);
  const info = await res.json();
  state.video.fps = info.fps;
  state.video.frames = info.frames;
}

// Writes a new _OUTPUT/<uuid>/{annotation_set.json, CSVs, ground_truth/annotations.xml,
// yolo-labels/*.txt}; the server assigns the uuid and the video's next version.
// Resolves with the set's index entry.
export async function saveToOutput() {
  await ensureVideoInfo();
  const stem = videoBasename();
  const { width, height, fps, frames } = state.video;
  const tracks = boxTracks(state.objects, { fps, frames });
  const files = {
    'annotation_set.json': toJSON(),
    [`${stem}_points.csv`]: toCSV(),
    [`${stem}_boxes.csv`]: toBoxesCSV(),
    'ground_truth/annotations.xml': toCvatXml(tracks, { name: stem, width, height, frames }),
  };
  for (const [name, content] of Object.entries(toYoloLabels(tracks))) files[`yolo-labels/${name}`] = content;

  const res = await fetch('/api/annotation-sets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: state.video.id, files, based_on: state.loadedSet?.uuid ?? null }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  const set = await res.json();
  setLoadedSet(set);
  return { set, labels: Object.keys(files).length - 4 };
}

// The whole _OUTPUT/<uuid>/ folder as <uuid>.zip (also kept on the server).
export function download(set) {
  const a = document.createElement('a');
  a.href = `/api/annotation-sets/${encodeURIComponent(set.uuid)}/download`;
  a.download = `${set.uuid}.zip`;
  a.click();
}
