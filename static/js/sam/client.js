// MobileSAM client: server availability, per-frame embedding requests (encoded
// on the server, prefetched when playback pauses), decode dispatch with
// browser -> server fallback, a serialized op queue, and in-memory masks.

import { state, getActiveObject, setSamDecode } from '../state.js';
import { captureFrame } from './frame.js';
import { serverDecoder, browserDecoder, DecoderLoadError } from './decoders.js';

const PREFETCH_DEBOUNCE_MS = 250;
const MASK_CACHE_SIZE = 16;
const MASK_ALPHA = 0.35;

let video;
let available = false;
const ready = new Set(); // frame keys the server has embeddings for
let inflight = null;     // frame key being encoded (one at a time)
let wanted = null;       // latest frame key requested while busy (latest wins)
let message = null;      // { key, text } transient status for one frame
let prefetchTimer = null;
let queue = Promise.resolve();

export async function initSam(videoEl) {
  video = videoEl;
  video.addEventListener('pause', schedulePrefetch);
  video.addEventListener('seeked', schedulePrefetch);
  try {
    const res = await fetch('/api/sam/status');
    available = res.ok && (await res.json()).available === true;
  } catch {
    available = false;
  }
  return available;
}

export function samAvailable() {
  return available;
}

// Identifies the displayed frame: video path + time in ms.
export function frameKey() {
  return `${state.video.url.replace(/^\/videos\//, '')}@${Math.round(video.currentTime * 1000)}`;
}

function onStillFrame() {
  return video.paused && !video.seeking;
}

// ---------- status ----------

export function samStatusText() {
  if (!available) return 'SAM unavailable';
  if (!onStillFrame()) return 'Pause to prompt';
  const key = frameKey();
  if (message?.key === key) return message.text;
  if (ready.has(key)) return 'Ready';
  if (inflight === key || wanted === key) return 'Encoding…';
  return 'Not encoded';
}

function say(key, text) {
  message = text ? { key, text } : null;
}

// ---------- embeddings ----------

function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const active = getActiveObject();
    if (available && onStillFrame() && active?.type === 'box' && state.inputMode.startsWith('sam')) {
      requestEmbedding(frameKey());
    }
  }, PREFETCH_DEBOUNCE_MS);
}

function requestEmbedding(key) {
  if (ready.has(key)) return;
  wanted = key;
  pump();
}

async function pump() {
  if (inflight || !wanted) return;
  const key = wanted;
  wanted = null;
  if (key !== frameKey() || !onStillFrame()) return pump(); // stale: the video moved on
  inflight = key;
  const url = `/api/sam/embed?key=${encodeURIComponent(key)}`;
  try {
    if ((await fetch(url, { method: 'HEAD' })).ok) {
      ready.add(key);
    } else if (key === frameKey() && onStillFrame()) {
      const res = await fetch(url, { method: 'POST', body: await captureFrame(video), headers: { 'Content-Type': 'image/png' } });
      if (res.ok) ready.add(key);
      else say(key, 'Encoding failed');
    }
  } catch (err) {
    console.error(err);
    say(key, 'Encoding failed');
  } finally {
    inflight = null;
    pump();
  }
}

// The current frame's key when a SAM prompt can run now (paused + embedded);
// otherwise null, after starting the encode if needed (status explains why).
export function samPromptKey() {
  if (!available || !onStillFrame()) return null;
  const key = frameKey();
  if (ready.has(key)) return key;
  requestEmbedding(key);
  return null;
}

// ---------- decode ----------

// SAM ops run one at a time so each sees the previous op's prompts.
export function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error(err));
  return queue;
}

// Returns the decode result with a box, or null (status says why).
export async function decode(key, prompts) {
  const size = { width: state.video.width, height: state.video.height };
  say(key, 'Decoding…');
  let res;
  try {
    const decoder = state.samDecode === 'browser' ? browserDecoder : serverDecoder;
    res = await decoder.decode(key, prompts, size);
  } catch (err) {
    if (!(err instanceof DecoderLoadError)) {
      console.error(err);
      say(key, 'Decode failed');
      return null;
    }
    console.warn('browser decoder unavailable, using server:', err.message);
    setSamDecode('server');
    try {
      res = await serverDecoder.decode(key, prompts, size);
    } catch (err2) {
      console.error(err2);
      say(key, 'Decode failed');
      return null;
    }
    say(key, 'Browser decoder failed to load — using server');
    return res.box ? res : (say(key, 'No object found'), null);
  }
  if (!res.box) {
    say(key, 'No object found');
    return null;
  }
  say(key, null);
  return res;
}

// ---------- masks (memory only; keyed by the prompts that produced them) ----------

const masks = new Map(); // `${objId}|${t}|${prompts}` -> canvas

function maskKey(objId, box) {
  return `${objId}|${box.t}|${JSON.stringify(box.prompts)}`;
}

export function storeMask(obj, box, mask) {
  const c = document.createElement('canvas');
  c.width = mask.width;
  c.height = mask.height;
  const g = c.getContext('2d');
  const img = g.createImageData(mask.width, mask.height);
  const r = parseInt(obj.color.slice(1, 3), 16);
  const gr = parseInt(obj.color.slice(3, 5), 16);
  const b = parseInt(obj.color.slice(5, 7), 16);
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue;
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gr;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  masks.set(maskKey(obj.id, box), c);
  if (masks.size > MASK_CACHE_SIZE) masks.delete(masks.keys().next().value);
}

export function drawMask(ctx, obj, box, w, h) {
  const c = masks.get(maskKey(obj.id, box));
  if (!c) return;
  ctx.globalAlpha = MASK_ALPHA;
  ctx.drawImage(c, 0, 0, w, h);
}
