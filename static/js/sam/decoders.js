// Two implementations of one interface, both running the same decoder .onnx:
//   decode(key, prompts, frameSize) -> { box: {x1, y1, x2, y2} | null, score, mask: {width, height, data} | null }
// prompts: { points: [{x, y, label}], box } normalized; mask.data is 0/1 bytes.

import { buildPrompt, maskFromLogits, maskToBox, float16ToFloat32 } from './transform.js';

const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const EMBED_DIMS = [1, 256, 64, 64];
const EMBED_CACHE_SIZE = 4;

// The browser runtime/model could not be loaded (as opposed to one decode failing).
export class DecoderLoadError extends Error {}

function keyParam(key) {
  return `key=${encodeURIComponent(key)}`;
}

// ---------- server: POST prompts, the server decodes its cached embedding ----------

async function maskFromDataUrl(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const data = new Uint8Array(c.width * c.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] > 127 ? 1 : 0;
  return { width: c.width, height: c.height, data };
}

export const serverDecoder = {
  async decode(key, prompts) {
    const res = await fetch('/api/sam/decode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        points: prompts.points.map((p) => [p.x, p.y]),
        labels: prompts.points.map((p) => p.label),
        box: prompts.box ? [prompts.box.x1, prompts.box.y1, prompts.box.x2, prompts.box.y2] : null,
      }),
    });
    if (!res.ok) throw new Error(`decode failed: ${res.status}`);
    const out = await res.json();
    const [x1, y1, x2, y2] = out.box ?? [];
    return {
      box: out.box ? { x1, y1, x2, y2 } : null,
      score: out.score,
      mask: out.mask ? await maskFromDataUrl(out.mask) : null,
    };
  },
};

// ---------- browser: fetch the embedding once, run onnxruntime-web locally ----------

let runtime = null; // Promise<{ ort, session }>
const embeddings = new Map(); // key -> Float32Array (small LRU)

function loadRuntime() {
  runtime ??= (async () => {
    const ort = await import(`${ORT_DIST}ort.wasm.bundle.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_DIST;
    ort.env.wasm.numThreads = 1; // no COOP/COEP headers -> no SharedArrayBuffer threads
    const session = await ort.InferenceSession.create('/models/decoder.onnx', { executionProviders: ['wasm'] });
    return { ort, session };
  })().catch((err) => {
    runtime = null;
    throw new DecoderLoadError(String(err?.message ?? err));
  });
  return runtime;
}

async function embeddingFor(key) {
  if (embeddings.has(key)) {
    const emb = embeddings.get(key);
    embeddings.delete(key);
    embeddings.set(key, emb);
    return emb;
  }
  const res = await fetch(`/api/sam/embedding?${keyParam(key)}`);
  if (!res.ok) throw new Error(`embedding fetch failed: ${res.status}`);
  const emb = float16ToFloat32(new Uint16Array(await res.arrayBuffer()));
  embeddings.set(key, emb);
  if (embeddings.size > EMBED_CACHE_SIZE) embeddings.delete(embeddings.keys().next().value);
  return emb;
}

export const browserDecoder = {
  async decode(key, prompts, { width, height }) {
    const { ort, session } = await loadRuntime();
    const emb = await embeddingFor(key);
    const { coords, labels, n } = buildPrompt(prompts, height, width);
    const out = await session.run({
      image_embeddings: new ort.Tensor('float32', emb, EMBED_DIMS),
      point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
      point_labels: new ort.Tensor('float32', labels, [1, n]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
      orig_im_size: new ort.Tensor('float32', new Float32Array([height, width]), [2]),
    });
    const [, , mh, mw] = out.masks.dims;
    const data = maskFromLogits(out.masks.data);
    const box = maskToBox(data, mw, mh);
    return {
      box,
      score: out.iou_predictions.data[0],
      mask: box ? { width: mw, height: mh, data } : null,
    };
  },
};
