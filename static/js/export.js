// Export points as JSON + CSV: POST to the server (_OUTPUT/) or browser download.

import { state } from './state.js';

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
        points: o.points.map((p) => ({ t: p.t, x: p.x, y: p.y })),
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

async function postExport(filename, content) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content }),
  });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  return (await res.json()).saved;
}

export async function saveToOutput() {
  const base = videoBasename();
  const savedJson = await postExport(`${base}_points.json`, toJSON());
  const savedCsv = await postExport(`${base}_points.csv`, toCSV());
  return [savedJson, savedCsv];
}

function downloadBlob(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function download() {
  const base = videoBasename();
  downloadBlob(`${base}_points.json`, 'application/json', toJSON());
  downloadBlob(`${base}_points.csv`, 'text/csv', toCSV());
}
