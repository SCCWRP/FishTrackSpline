// Sidebar (objects panel + points table) rendering and transport bar wiring.

import {
  state, FRAME_STEP,
  getActiveObject, addObject, renameObject, deleteObject, setActiveObject,
  toggleVisible, deletePoint, subscribe,
} from './state.js';

let video;
const els = {};
let tableRows = []; // [{ tr, point }] for the active object, sorted by t
let highlightedRow = null;
let scrubbing = false;

export function initUI(videoEl) {
  video = videoEl;
  for (const id of [
    'playBtn', 'stepBack', 'stepFwd', 'scrubber', 'timeReadout', 'rateSelect',
    'addObjectBtn', 'objectList', 'pointsCaption', 'pointsBody', 'stageHint',
  ]) {
    els[id] = document.getElementById(id);
  }

  wireTransport();
  wireKeyboard();
  els.addObjectBtn.addEventListener('click', () => addObject());

  subscribe(renderSidebar);
  renderSidebar();
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
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      const obj = getActiveObject();
      if (!obj || !obj.points.length) return;
      const nearest = obj.points.reduce((a, b) =>
        Math.abs(a.t - video.currentTime) < Math.abs(b.t - video.currentTime) ? a : b);
      if (Math.abs(nearest.t - video.currentTime) < 0.04) {
        e.preventDefault();
        deletePoint(obj.id, nearest);
      }
    }
  });
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
  els.stageHint.classList.toggle(
    'hidden',
    state.objects.some((o) => o.points.length > 0),
  );
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
    count.textContent = `${obj.points.length} pt${obj.points.length === 1 ? '' : 's'}`;

    const eye = iconBtn(obj.visible ? '👁' : '👁', 'Toggle visibility', (e) => {
      e.stopPropagation();
      toggleVisible(obj.id);
    });
    if (!obj.visible) eye.classList.add('off');

    const del = iconBtn('✕', 'Delete object', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${obj.name}" and its ${obj.points.length} points?`)) {
        deleteObject(obj.id);
      }
    });

    li.append(swatch, name, count, eye, del);
    els.objectList.appendChild(li);
  }
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

function renderTable() {
  const obj = getActiveObject();
  els.pointsCaption.textContent = obj
    ? `${obj.points.length} point${obj.points.length === 1 ? '' : 's'} — ${obj.name}`
    : 'Points';
  els.pointsBody.textContent = '';
  tableRows = [];
  highlightedRow = null;

  if (!obj || obj.points.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'points-empty';
    td.textContent = obj ? 'Click the video to add points' : 'Add an object first';
    tr.appendChild(td);
    els.pointsBody.appendChild(tr);
    return;
  }

  for (const p of obj.points) {
    const tr = document.createElement('tr');

    const tdT = document.createElement('td');
    tdT.textContent = p.t.toFixed(2);
    const tdX = document.createElement('td');
    tdX.textContent = p.x.toFixed(3);
    const tdY = document.createElement('td');
    tdY.textContent = p.y.toFixed(3);

    const tdActions = document.createElement('td');
    const seek = document.createElement('button');
    seek.className = 'row-btn';
    seek.textContent = '⌖';
    seek.title = 'Seek to this point';
    seek.addEventListener('click', () => { video.currentTime = p.t; });
    const del = document.createElement('button');
    del.className = 'row-btn';
    del.textContent = '✕';
    del.title = 'Delete point';
    del.addEventListener('click', () => deletePoint(obj.id, p));
    tdActions.append(seek, del);

    tr.append(tdT, tdX, tdY, tdActions);
    els.pointsBody.appendChild(tr);
    tableRows.push({ tr, point: p });
  }
}

// ---------- per-frame updates (called from the rAF loop) ----------

export function tick(now) {
  els.timeReadout.textContent = `${formatTime(now)} / ${formatTime(video.duration)}`;
  if (!scrubbing) els.scrubber.value = now;

  let nearest = null;
  for (const row of tableRows) {
    if (!nearest || Math.abs(row.point.t - now) < Math.abs(nearest.point.t - now)) {
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
