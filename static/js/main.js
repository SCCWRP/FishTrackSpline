// Bootstrap: video source from ?video=, stage sizing, rAF loop, export buttons.

import { state, addObject, resetHistory } from './state.js';
import { initOverlay, draw } from './overlay.js';
import { initUI, tick, applySamAvailability } from './ui.js';
import { saveToOutput, download } from './export.js';
import { initSam } from './sam/client.js';

const DEFAULT_VIDEO = '720p/GOPR7611_trim_720_16s.mp4';

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const stage = document.getElementById('stage');

const videoParam = new URLSearchParams(location.search).get('video') || DEFAULT_VIDEO;
state.video.url = `/videos/${videoParam}`;
video.src = state.video.url;

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
  document.getElementById('stageHint').textContent =
    `Failed to load video "${videoParam}" — check the ?video= path (relative to the videos mount)`;
});

initUI(video);
initOverlay(video, canvas);
addObject(); // start with "fish 1" (a point object) active
resetHistory(); // ...which is not an undoable edit
initSam(video).then(applySamAvailability);

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
    const saved = await saveToOutput();
    exportStatus.textContent = `Saved to _OUTPUT/${saved.dir}/ (JSON, CSVs, CVAT XML, ${saved.labels} YOLO labels)`;
  } catch (err) {
    exportStatus.textContent = String(err);
  }
});

document.getElementById('downloadBtn').addEventListener('click', () => {
  download();
  exportStatus.textContent = 'Downloaded JSON + 2 CSVs';
});
