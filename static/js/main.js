// Bootstrap: video source from ?video= (a file in _UPLOADS; default: the first
// one), stage sizing, rAF loop, export buttons.

import { state, addObject, resetHistory, refresh } from './state.js';
import { initLibrary, markSaved, refreshSets, videoIdFromParam } from './library.js';
import { initOverlay, draw } from './overlay.js';
import { initUI, tick, applySamAvailability } from './ui.js';
import { saveToOutput, download } from './export.js';
import { initSam } from './sam/client.js';

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const stage = document.getElementById('stage');

async function firstVideo() {
  try {
    const res = await fetch('/api/videos');
    return res.ok ? (await res.json())[0]?.id ?? '' : '';
  } catch {
    return '';
  }
}

// ?video=<file in _UPLOADS> (or uploads/<file>); without it, the first video there.
const videoParam = new URLSearchParams(location.search).get('video');
state.video.id = videoParam ? videoIdFromParam(videoParam) : await firstVideo();
if (state.video.id) {
  state.video.url = `/${state.video.id}`;
  video.src = state.video.url;
} else {
  state.video.notice = 'No videos yet — use Upload… in the top bar to add one';
}

video.addEventListener('loadedmetadata', () => {
  state.video.width = video.videoWidth;
  state.video.height = video.videoHeight;
  state.video.duration = video.duration;
  // Match the stage to the video's aspect so the canvas rect == displayed video
  // rect (no letterboxing) and normalized-coordinate mapping stays exact.
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  stage.style.setProperty('--video-aspect', video.videoWidth / video.videoHeight);
});

video.addEventListener('error', () => {
  if (!state.video.id) return;
  state.video.notice = `Failed to load video "${state.video.id}" — is it in _UPLOADS/, in a format this browser plays?`;
  refresh();
});

initUI(video);
initOverlay(video, canvas);
addObject(); // start with "fish 1" (a point object) active
resetHistory(); // ...which is not an undoable edit
initSam(video).then(applySamAvailability);
initLibrary();

function frame() {
  const now = video.currentTime;
  draw(now);
  tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- export ----------

const exportStatus = document.getElementById('exportStatus');

document.getElementById('saveOutputBtn').addEventListener('click', async () => {
  try {
    const { set, labels } = await saveToOutput();
    markSaved();
    await refreshSets();
    exportStatus.textContent = `Saved v${set.version} to _OUTPUT/${set.uuid}/ (JSON, CSVs, CVAT XML, ${labels} YOLO labels)`;
  } catch (err) {
    exportStatus.textContent = String(err);
  }
});

document.getElementById('downloadBtn').addEventListener('click', () => {
  download();
  exportStatus.textContent = 'Downloaded JSON + 2 CSVs';
});
