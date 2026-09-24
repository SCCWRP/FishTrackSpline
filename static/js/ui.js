// Sidebar (objects panel + keyframe table) rendering, transport bar wiring,
// and the box-object toolbar (input mode, SAM decode location, SAM status).

import {
  state, FRAME_STEP,
  getActiveObject, addObject, renameObject, deleteObject, setActiveObject,
  toggleVisible, deletePoint, deleteBox, keysOf, subscribe,
  setInputMode, setSamDecode, setViewMode, setIsolate, undo, redo, canUndo, canRedo, refresh,
} from './state.js';
import { samAvailable, samStatusText } from './sam/client.js';
import { renderObject, renderStatus } from './render.js';
import { convertPointsToBox } from './sam/convert.js';

const SAM_UNAVAILABLE_TIP = 'MobileSAM models not found on the server';

let video;
const els = {};
let tableRows = []; // [{ tr, key }] for the active object, sorted by t
let highlightedRow = null;
let scrubbing = false;
let converting = null; // { objId, done, total } while a point object is converted to boxes

export function initUI(videoEl) {
  video = videoEl;
  for (const id of [
    'playBtn', 'stepBack', 'stepFwd', 'scrubber', 'timeReadout', 'rateSelect',
    'addObjectBtn', 'addObjectMenu', 'objectList', 'pointsCaption', 'pointsHead', 'pointsBody',
    'stageHint', 'undoBtn', 'redoBtn', 'boxToolbar', 'inputMode', 'samDecode', 'isolateBtn', 'samStatus',
    'modeToggle',
  ]) {
    els[id] = document.getElementById(id);
  }

  wireTransport();
  wireKeyboard();
  wireAddMenu();
  wireBoxToolbar();
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  for (const btn of els.modeToggle.querySelectorAll('button')) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  }

  subscribe(renderSidebar);
  renderSidebar();
}

// ---------- add object (type menu) ----------

function wireAddMenu() {
  els.addObjectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.addObjectMenu.classList.toggle('hidden');
  });
  for (const btn of els.addObjectMenu.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      els.addObjectMenu.classList.add('hidden');
      addObject(btn.dataset.type);
    });
  }
  document.addEventListener('click', (e) => {
    if (!els.addObjectMenu.contains(e.target)) els.addObjectMenu.classList.add('hidden');
  });
}

// ---------- box toolbar ----------

function wireBoxToolbar() {
  els.inputMode.addEventListener('change', () => setInputMode(els.inputMode.value));
  els.samDecode.addEventListener('change', () => setSamDecode(els.samDecode.value));
  els.isolateBtn.addEventListener('click', () => setIsolate(!state.isolate));
}

// Called once the /api/sam/status check finishes.
export function applySamAvailability() {
  const ok = samAvailable();
  for (const opt of els.inputMode.options) {
    if (!opt.value.startsWith('sam')) continue;
    opt.disabled = !ok;
    opt.title = ok ? '' : SAM_UNAVAILABLE_TIP;
  }
  els.samDecode.disabled = !ok;
  els.samDecode.title = ok ? '' : SAM_UNAVAILABLE_TIP;
  if (!ok && state.inputMode.startsWith('sam')) setInputMode('manual-box');
  else renderSidebar();
}

// ---------- transport ----------

function wireTransport() {
  els.playBtn.addEventListener('click', togglePlay);
  els.stepBack.addEventListener('click', () => step(-FRAME_STEP));
  els.stepFwd.addEventListener('click', () => step(FRAME_STEP));
  els.rateSelect.addEventListener('change', () => {
    video.playbackRate = parseFloat(els.rateSelect.value);
  });

  els.scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
  els.scrubber.addEventListener('pointerup', () => { scrubbing = false; });
  els.scrubber.addEventListener('input', () => {
    video.currentTime = parseFloat(els.scrubber.value);
  });

  video.addEventListener('play', () => { els.playBtn.textContent = '⏸'; });
  video.addEventListener('pause', () => { els.playBtn.textContent = '▶'; });
  video.addEventListener('loadedmetadata', () => {
    els.scrubber.max = video.duration;
  });
}

function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
}

function step(dt) {
  video.pause();
  video.currentTime = Math.min(Math.max(video.currentTime + dt, 0), video.duration || 0);
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      step(-FRAME_STEP);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      step(FRAME_STEP);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.viewMode === 'edit') {
      const obj = getActiveObject();
      if (!obj || !keysOf(obj).length) return;
      const nearest = keysOf(obj).reduce((a, b) =>
        Math.abs(a.t - video.currentTime) < Math.abs(b.t - video.currentTime) ? a : b);
      if (Math.abs(nearest.t - video.currentTime) < 0.04) {
        e.preventDefault();
        deleteKey(obj, nearest);
      }
    }
  });
}

function deleteKey(obj, key) {
  if (obj.type === 'box') deleteBox(obj.id, key);
  else deletePoint(obj.id, key);
}

function keyNoun(obj, n) {
  const noun = obj.type === 'box' ? 'box' : 'point';
  return `${n} ${noun}${n === 1 ? '' : obj.type === 'box' ? 'es' : 's'}`;
}

function formatTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

// ---------- sidebar ----------

function renderSidebar() {
  renderObjects();
  renderTable();
  renderToolbar();
  const editing = state.viewMode === 'edit';
  for (const btn of els.modeToggle.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.mode === state.viewMode);
  }
  els.undoBtn.disabled = !editing || !canUndo();
  els.redoBtn.disabled = !editing || !canRedo();
  els.stageHint.textContent = hintText();
  els.stageHint.classList.toggle(
    'hidden',
    !editing || state.objects.some((o) => keysOf(o).length > 0),
  );
}

function hintText() {
  const obj = getActiveObject();
  if (obj?.type !== 'box') return 'Click on the video to add a point for the active object';
  if (state.inputMode === 'sam-points') return 'Pause, then click the fish to prompt SAM (right-click = negative point)';
  if (state.inputMode === 'sam-box') return 'Pause, then drag a box around the fish (right-click = negative point)';
  return 'Drag on the video to draw a box for the active object';
}

function renderToolbar() {
  els.boxToolbar.classList.toggle('hidden', state.viewMode !== 'edit' || getActiveObject()?.type !== 'box');
  els.inputMode.value = state.inputMode;
  els.samDecode.value = state.samDecode;
  els.isolateBtn.classList.toggle('active', state.isolate);
  els.isolateBtn.setAttribute('aria-pressed', String(state.isolate));
}

function renderObjects() {
  els.objectList.textContent = '';
  for (const obj of state.objects) {
    const li = document.createElement('li');
    li.className = 'object-row' + (obj.id === state.activeObjectId ? ' active' : '');
    li.addEventListener('click', () => setActiveObject(obj.id));

    const swatch = document.createElement('span');
    swatch.className = 'object-swatch';
    swatch.style.background = obj.color;

    const badge = document.createElement('span');
    badge.className = 'object-type';
    badge.textContent = obj.type === 'box' ? 'box' : 'pt';

    const name = document.createElement('span');
    name.className = 'object-name';
    name.textContent = obj.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(name, obj);
    });

    const count = document.createElement('span');
    count.className = 'object-count';
    count.textContent = obj.type === 'box'
      ? `${obj.boxes.length} box${obj.boxes.length === 1 ? '' : 'es'}`
      : `${obj.points.length} pt${obj.points.length === 1 ? '' : 's'}`;

    const eye = iconBtn(obj.visible ? '👁' : '👁', 'Toggle visibility', (e) => {
      e.stopPropagation();
      toggleVisible(obj.id);
    });
    if (!obj.visible) eye.classList.add('off');

    const del = iconBtn('✕', 'Delete object', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${obj.name}" and its ${keyNoun(obj, keysOf(obj).length)}?`)) {
        deleteObject(obj.id);
      }
    });

    li.append(swatch, badge, name, count);
    if (obj.type === 'box') li.append(...renderControls(obj));
    else li.append(convertButton(obj));
    li.append(eye, del);
    els.objectList.appendChild(li);
  }
}

// Render button + status for a box object's cached overlay (see render.js).
function renderControls(obj) {
  const status = renderStatus(obj);
  const btn = document.createElement('button');
  btn.className = 'render-btn';
  btn.textContent = 'Render';
  btn.disabled = obj.boxes.length === 0;
  btn.title = status === 'stale' ? 'Keyframes changed since the last render — render again'
    : status === 'fresh' ? 'Rendered — click to render again' : 'Render the overlay for viewing mode';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderObject(obj);
    refresh();
  });
  const mark = document.createElement('span');
  mark.className = `render-status ${status}`;
  mark.textContent = status === 'fresh' ? '✓' : status === 'stale' ? 'stale' : '';
  return [btn, mark];
}

// "→ Box": MobileSAM on each point keyframe -> a new box object (sam/convert.js).
function convertButton(obj) {
  const btn = document.createElement('button');
  btn.className = 'render-btn';
  const busy = converting?.objId === obj.id;
  btn.textContent = busy ? `${converting.done}/${converting.total}` : '→ Box';
  btn.disabled = !!converting || !samAvailable() || state.viewMode !== 'edit' || obj.points.length === 0;
  btn.title = !samAvailable() ? SAM_UNAVAILABLE_TIP
    : 'Run MobileSAM on each point and add the surrounding boxes as a new box object';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    converting = { objId: obj.id, done: 0, total: obj.points.length };
    renderSidebar();
    try {
      await convertPointsToBox(video, obj, (done, total) => {
        converting = { objId: obj.id, done, total };
        renderSidebar();
      });
    } finally {
      converting = null;
      renderSidebar();
    }
  });
  return btn;
}

function iconBtn(text, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function startRename(nameEl, obj) {
  const input = document.createElement('input');
  input.value = obj.name;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  const commit = () => renameObject(obj.id, input.value);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      renderSidebar();
    }
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

const COLUMNS = {
  point: ['time (s)', 'x', 'y'],
  box: ['time (s)', 'cx', 'cy', 'w', 'h', 'source'],
};

function renderTable() {
  const obj = getActiveObject();
  const keys = obj ? keysOf(obj) : [];
  els.pointsCaption.textContent = obj ? `${keyNoun(obj, keys.length)} — ${obj.name}` : 'Points';
  const cols = COLUMNS[obj?.type === 'box' ? 'box' : 'point'];
  els.pointsHead.innerHTML = `<tr>${[...cols, ''].map((c) => `<th>${c}</th>`).join('')}</tr>`;
  els.pointsHead.parentElement.classList.toggle('boxes', obj?.type === 'box');
  els.pointsBody.textContent = '';
  tableRows = [];
  highlightedRow = null;

  if (!obj || keys.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = cols.length + 1;
    td.className = 'points-empty';
    td.textContent = !obj ? 'Add an object first'
      : obj.type === 'box' ? 'Draw a box on the video' : 'Click the video to add points';
    tr.appendChild(td);
    els.pointsBody.appendChild(tr);
    return;
  }

  for (const k of keys) {
    const tr = document.createElement('tr');
    const values = obj.type === 'box'
      ? [
        k.t.toFixed(2),
        ((k.x1 + k.x2) / 2).toFixed(3),
        ((k.y1 + k.y2) / 2).toFixed(3),
        (k.x2 - k.x1).toFixed(3),
        (k.y2 - k.y1).toFixed(3),
        k.source + (k.edited ? ' ✎' : ''),
      ]
      : [k.t.toFixed(2), k.x.toFixed(3), k.y.toFixed(3)];
    for (const v of values) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }

    const tdActions = document.createElement('td');
    const seek = document.createElement('button');
    seek.className = 'row-btn';
    seek.textContent = '⌖';
    seek.title = 'Seek to this keyframe';
    seek.addEventListener('click', () => { video.currentTime = k.t; });
    const del = document.createElement('button');
    del.className = 'row-btn';
    del.textContent = '✕';
    del.title = 'Delete keyframe';
    del.addEventListener('click', () => deleteKey(obj, k));
    tdActions.append(seek, del);

    tr.appendChild(tdActions);
    els.pointsBody.appendChild(tr);
    tableRows.push({ tr, key: k });
  }
}

// ---------- per-frame updates (called from the rAF loop) ----------

export function tick(now) {
  els.timeReadout.textContent = `${formatTime(now)} / ${formatTime(video.duration)}`;
  if (!scrubbing) els.scrubber.value = now;

  if (!els.boxToolbar.classList.contains('hidden')) {
    const status = samStatusText();
    if (els.samStatus.textContent !== status) els.samStatus.textContent = status;
  }

  let nearest = null;
  for (const row of tableRows) {
    if (!nearest || Math.abs(row.key.t - now) < Math.abs(nearest.key.t - now)) {
      nearest = row;
    }
  }
  if (nearest !== highlightedRow) {
    highlightedRow?.tr.classList.remove('current');
    nearest?.tr.classList.add('current');
    nearest?.tr.scrollIntoView({ block: 'nearest' });
    highlightedRow = nearest;
  }
}
