// Bootstrap: video source from ?video= (a file in _UPLOADS; default: the first
// one), stage sizing, rAF loop, export buttons.

import { state, refresh, subscribe } from './state.js';
import { initLibrary, markSaved, refreshSets, videoIdFromParam, hasUnsavedChanges } from './library.js';
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
initSam(video).then(applySamAvailability);
initLibrary();

// While playing, video.currentTime (the media clock) runs a fraction of a frame
// off the frame actually on screen. Keep drawing from the smooth clock every
// animation frame, minus a running average of that offset, measured on each
// presented frame (requestVideoFrameCallback). Paused/seeking: currentTime as-is.
const OFFSET_SMOOTHING = 0.1; // EMA weight of each new measurement
const MAX_OFFSET = 0.1;       // s — ignore outliers (e.g. right after a seek)
let clockOffset = 0;
// ?sync=raw turns the correction off (for A/B comparison).
const correctClock = new URLSearchParams(location.search).get('sync') !== 'raw';
if (correctClock && 'requestVideoFrameCallback' in video) {
  const onVideoFrame = (_now, meta) => {
    const d = video.currentTime - meta.mediaTime;
    if (!video.paused && Math.abs(d) < MAX_OFFSET) clockOffset += OFFSET_SMOOTHING * (d - clockOffset);
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback(onVideoFrame);
  video.addEventListener('seeking', () => { clockOffset = 0; });
}

function frame() {
  const now = video.paused || video.seeking ? video.currentTime : Math.max(0, video.currentTime - clockOffset);
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

// Download = the saved set's zip, so only while the annotations match a saved set.
const downloadBtn = document.getElementById('downloadBtn');
function updateDownloadBtn() {
  downloadBtn.disabled = !state.loadedSet || hasUnsavedChanges();
}
subscribe(updateDownloadBtn);
updateDownloadBtn();

downloadBtn.addEventListener('click', () => {
  if (downloadBtn.disabled) return;
  download(state.loadedSet);
  exportStatus.textContent = `Downloading ${state.loadedSet.uuid}.zip (v${state.loadedSet.version})`;
});
