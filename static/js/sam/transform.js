// SAM prompt/mask math shared by the browser decoder. Pure, no DOM.
// Must stay identical to build_prompt / mask_to_box in sam_service.py.

export const TARGET_LENGTH = 1024; // SAM input: longest image side resized to this

// SAM's ResizeLongestSide.get_preprocess_shape: [newH, newW].
export function preprocessShape(h, w) {
  const scale = TARGET_LENGTH / Math.max(h, w);
  return [Math.floor(h * scale + 0.5), Math.floor(w * scale + 0.5)];
}

// prompts: { points: [{x, y, label}], box: {x1, y1, x2, y2} | null } in 0..1.
// Returns decoder point_coords / point_labels data for an h x w frame: pixels,
// scaled per axis into the 1024 frame; no box -> a (0, 0) padding point, label -1.
export function buildPrompt(prompts, h, w) {
  const [newH, newW] = preprocessShape(h, w);
  const sx = newW / w;
  const sy = newH / h;
  const coords = [];
  const labels = [];
  for (const p of prompts.points) {
    coords.push(p.x * w * sx, p.y * h * sy);
    labels.push(p.label);
  }
  if (prompts.box) {
    const b = prompts.box;
    coords.push(b.x1 * w * sx, b.y1 * h * sy, b.x2 * w * sx, b.y2 * h * sy);
    labels.push(2, 3);
  } else {
    coords.push(0, 0);
    labels.push(-1);
  }
  return { coords: new Float32Array(coords), labels: new Float32Array(labels), n: labels.length };
}

// Decoder mask logits -> 0/1 bytes (SAM mask threshold is 0).
export function maskFromLogits(logits) {
  const mask = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) mask[i] = logits[i] > 0 ? 1 : 0;
  return mask;
}

// Tight normalized {x1, y1, x2, y2} of a w x h 0/1 mask; null if empty.
export function maskToBox(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x1: minX / w, y1: minY / h, x2: (maxX + 1) / w, y2: (maxY + 1) / h };
}

// IEEE half-precision bits -> float32 (embeddings are served as float16).
let HALF_TABLE = null;
export function float16ToFloat32(u16) {
  if (!HALF_TABLE) {
    HALF_TABLE = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const sign = h & 0x8000 ? -1 : 1;
      const exp = (h >> 10) & 0x1f;
      const frac = h & 0x3ff;
      HALF_TABLE[h] = exp === 0 ? sign * frac * 2 ** -24
        : exp === 31 ? (frac ? NaN : sign * Infinity)
        : sign * (1 + frac / 1024) * 2 ** (exp - 15);
    }
  }
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = HALF_TABLE[u16[i]];
  return out;
}
