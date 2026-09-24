// Natural cubic spline parameterized by time: x(t) and y(t) interpolated
// independently over an object's sorted keyframe times. Pure math, no DOM.

const SAMPLE_DT = 1 / 30; // s between drawn samples
const MAX_SAMPLES = 400;

// ts strictly increasing (n >= 3). Returns second derivatives M[0..n-1]
// with natural boundary conditions M[0] = M[n-1] = 0 (Thomas algorithm).
export function solveNaturalCubic(ts, vs) {
  const n = ts.length;
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = Math.max(ts[i + 1] - ts[i], 1e-6);

  const diag = new Float64Array(n);
  const rhs = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    diag[i] = 2 * (h[i - 1] + h[i]);
    rhs[i] = 6 * ((vs[i + 1] - vs[i]) / h[i] - (vs[i] - vs[i - 1]) / h[i - 1]);
  }

  // Forward elimination (sub/super diagonals are h[i-1] / h[i]).
  for (let i = 2; i < n - 1; i++) {
    const w = h[i - 1] / diag[i - 1];
    diag[i] -= w * h[i - 1];
    rhs[i] -= w * rhs[i - 1];
  }

  const M = new Float64Array(n);
  for (let i = n - 2; i >= 1; i--) {
    M[i] = (rhs[i] - h[i] * M[i + 1]) / diag[i];
  }
  return M;
}

function evalSegment(ts, vs, M, i, t) {
  const h = Math.max(ts[i + 1] - ts[i], 1e-6);
  const s = t - ts[i];
  const c = M[i] / 2;
  const d = (M[i + 1] - M[i]) / (6 * h);
  const b = (vs[i + 1] - vs[i]) / h - (h * (2 * M[i] + M[i + 1])) / 6;
  return vs[i] + b * s + c * s * s + d * s * s * s;
}

// ts: strictly increasing keyframe times (no duplicates, enforced by the EPS_T
// replace rule); channels: arrays of values, one per ts. Returns
// { t0, t1, evalAt(t) -> number[] } or null when there are no keyframes.
// evalAt clamps t to [t0, t1] — the trajectory is never extrapolated.
export function buildTrajectory(ts, channels) {
  const n = ts.length;
  if (n === 0) return null;
  const t0 = ts[0];
  const t1 = ts[n - 1];

  if (n === 1) {
    const v = channels.map((c) => c[0]);
    return { t0, t1, evalAt: () => v.slice() };
  }

  if (n === 2) {
    return {
      t0,
      t1,
      evalAt(t) {
        const u = (clamp(t, t0, t1) - t0) / Math.max(t1 - t0, 1e-6);
        return channels.map((c) => c[0] + u * (c[1] - c[0]));
      },
    };
  }

  const Ms = channels.map((c) => solveNaturalCubic(ts, c));

  return {
    t0,
    t1,
    evalAt(t) {
      const tc = clamp(t, t0, t1);
      const i = findSegment(ts, tc);
      return channels.map((c, k) => evalSegment(ts, c, Ms[k], i, tc));
    },
  };
}

// Point object: x(t), y(t). evalAt -> {x, y}.
export function pointTrajectory(points) {
  const traj = buildTrajectory(points.map((p) => p.t), [points.map((p) => p.x), points.map((p) => p.y)]);
  if (!traj) return null;
  return {
    t0: traj.t0,
    t1: traj.t1,
    evalAt(t) {
      const [x, y] = traj.evalAt(t);
      return { x, y };
    },
  };
}

// Box object: interpolated as center + size (cx, cy, w, h) — same shape as
// corner interpolation since the spline is linear in its values — with w, h
// clamped >= 0 against overshoot. evalAt -> center {x, y}; evalBoxAt -> corners.
export function boxTrajectory(boxes) {
  const traj = buildTrajectory(boxes.map((b) => b.t), [
    boxes.map((b) => (b.x1 + b.x2) / 2),
    boxes.map((b) => (b.y1 + b.y2) / 2),
    boxes.map((b) => b.x2 - b.x1),
    boxes.map((b) => b.y2 - b.y1),
  ]);
  if (!traj) return null;
  return {
    t0: traj.t0,
    t1: traj.t1,
    evalAt(t) {
      const [x, y] = traj.evalAt(t);
      return { x, y };
    },
    evalBoxAt(t) {
      const [cx, cy, w, h] = traj.evalAt(t);
      const hw = Math.max(w, 0) / 2;
      const hh = Math.max(h, 0) / 2;
      return { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
    },
  };
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// Binary search: largest i with ts[i] <= t, capped at n-2.
function findSegment(ts, t) {
  let lo = 0;
  let hi = ts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function sampleTrajectory(traj) {
  const span = traj.t1 - traj.t0;
  const n = clamp(Math.round(span / SAMPLE_DT), 2, MAX_SAMPLES);
  const samples = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = traj.t0 + (span * i) / n;
    const { x, y } = traj.evalAt(t);
    samples[i] = { t, x, y };
  }
  return samples;
}

// Cached accessor; state.js clears obj._cache on any keyframe mutation.
// samples are {t, x, y} (the center for box objects) for drawing the path.
export function trajectoryOf(obj) {
  if (!obj._cache) {
    const keys = obj.type === 'box' ? obj.boxes : obj.points;
    const traj = obj.type === 'box' ? boxTrajectory(keys) : pointTrajectory(keys);
    obj._cache = { traj, samples: traj && keys.length >= 2 ? sampleTrajectory(traj) : null };
  }
  return obj._cache;
}
