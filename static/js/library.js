// Top-bar video library: pick a video (everything in _UPLOADS), upload one,
// and load a saved annotation set (version) for the current video.

import { state, loadAnnotations, contentSignature, subscribe, refresh } from './state.js';
import { clearRenders } from './render.js';

const els = {};
let sets = [];         // index entries for the current video, newest version first
let savedSig = null;   // contentSignature() as of the last load/save (or startup)

export async function initLibrary() {
  for (const id of ['videoSelect', 'uploadBtn', 'uploadInput', 'setSelect', 'libraryStatus']) {
    els[id] = document.getElementById(id);
  }
  markSaved();
  els.videoSelect.addEventListener('change', onVideoChange);
  els.uploadBtn.addEventListener('click', () => els.uploadInput.click());
  els.uploadInput.addEventListener('change', onUploadChosen);
  els.setSelect.addEventListener('change', onSetChange);
  subscribe(renderSetSelect);
  await Promise.all([refreshVideos(), refreshSets()]);
}

// Current annotations == what was last loaded/saved.
export function markSaved() {
  savedSig = contentSignature();
  refresh();
}

export function hasUnsavedChanges() {
  return contentSignature() !== savedSig;
}

function status(text) {
  els.libraryStatus.textContent = text;
}

// ---------- videos ----------

// ?video= is the path under _UPLOADS (the "uploads/" prefix is optional).
export function videoParam(id) {
  return id.replace(/^uploads\//, '');
}

export function videoIdFromParam(param) {
  return param.startsWith('uploads/') ? param : `uploads/${param}`;
}

async function refreshVideos() {
  const res = await fetch('/api/videos');
  const videos = res.ok ? await res.json() : [];
  els.videoSelect.textContent = '';
  for (const v of videos) els.videoSelect.append(new Option(v.name, v.id));
  if (!state.video.id) {
    els.videoSelect.prepend(new Option(videos.length ? 'Choose a video…' : 'No videos — upload one', ''));
  } else if (!videos.some((v) => v.id === state.video.id)) {
    els.videoSelect.prepend(new Option(videoParam(state.video.id), state.video.id));
  }
  els.videoSelect.value = state.video.id;
  els.videoSelect.disabled = videos.length === 0;
}

function switchToVideo(id) {
  location.search = `?video=${encodeURIComponent(videoParam(id))}`;
}

function onVideoChange() {
  const id = els.videoSelect.value;
  if (id === state.video.id) return;
  if (hasUnsavedChanges() && !confirm('Switch video? Unsaved annotation changes will be lost.')) {
    els.videoSelect.value = state.video.id;
    return;
  }
  switchToVideo(id);
}

function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/videos/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) status(`Uploading ${file.name} — ${Math.round((100 * e.loaded) / e.total)}%`);
    };
    xhr.onload = () => (xhr.status === 200
      ? resolve(JSON.parse(xhr.responseText))
      : reject(new Error(JSON.parse(xhr.responseText || '{}').detail ?? `upload failed: ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('upload failed: network error'));
    xhr.send(file);
  });
}

async function onUploadChosen() {
  const file = els.uploadInput.files[0];
  els.uploadInput.value = '';
  if (!file) return;
  els.uploadBtn.disabled = true;
  try {
    const video = await upload(file);
    await refreshVideos();
    status(`Uploaded ${video.name}`);
    if (!hasUnsavedChanges() || confirm(`Open ${video.name} now? Unsaved annotation changes will be lost.`)) {
      switchToVideo(video.id);
    }
  } catch (err) {
    status(String(err.message ?? err));
  } finally {
    els.uploadBtn.disabled = false;
  }
}

// ---------- annotation sets ----------

function setLabel(s) {
  const when = new Date(s.saved_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return `v${s.version} · ${when} · ${s.uuid.slice(0, 8)}`;
}

export async function refreshSets() {
  const res = state.video.id && (await fetch(`/api/annotation-sets?video=${encodeURIComponent(state.video.id)}`));
  sets = res?.ok ? await res.json() : [];
  renderSetSelect();
}

function renderSetSelect() {
  const sel = els.setSelect;
  const want = state.loadedSet?.uuid ?? '';
  if (sel.dataset.rendered === JSON.stringify([want, sets.map((s) => s.uuid)])) return;
  sel.textContent = '';
  sel.append(new Option(sets.length ? 'Load saved set…' : 'No saved sets', ''));
  for (const s of sets) sel.append(new Option(setLabel(s), s.uuid));
  sel.value = want;
  sel.disabled = sets.length === 0;
  sel.dataset.rendered = JSON.stringify([want, sets.map((s) => s.uuid)]);
}

async function onSetChange() {
  const uuid = els.setSelect.value;
  const entry = sets.find((s) => s.uuid === uuid);
  if (!entry) return;
  if (hasUnsavedChanges() && !confirm(`Replace the current annotations with v${entry.version}? Unsaved changes will be lost.`)) {
    delete els.setSelect.dataset.rendered;
    renderSetSelect();
    return;
  }
  try {
    const res = await fetch(`/api/annotation-sets/${encodeURIComponent(uuid)}`);
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const { set, annotations } = await res.json();
    if (set.video_path !== state.video.id) throw new Error(`set ${set.uuid} belongs to ${set.video_path}`);
    clearRenders();
    loadAnnotations(annotations.objects ?? [], set);
    markSaved();
    status(`Loaded v${set.version}`);
  } catch (err) {
    status(String(err.message ?? err));
    delete els.setSelect.dataset.rendered;
    renderSetSelect();
  }
}
