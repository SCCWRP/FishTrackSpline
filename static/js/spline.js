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

// points: sorted by t, no duplicate times (enforced by addPoint's EPS_T replace).
// Returns { t0, t1, evalAt(t) -> {x, y} } or null when there are no points.
// evalAt clamps t to [t0, t1] — the trajectory is never extrapolated.
export function buildTrajectory(points) {
  const n = points.length;
  if (n === 0) return null;
  const t0 = points[0].t;
  const t1 = points[n - 1].t;

  if (n === 1) {
    const { x, y } = points[0];
    return { t0, t1, evalAt: () => ({ x, y }) };
  }

  const ts = points.map((p) => p.t);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  if (n === 2) {
    return {
      t0,
      t1,
      evalAt(t) {
        const u = (clamp(t, t0, t1) - t0) / Math.max(t1 - t0, 1e-6);
        return { x: xs[0] + u * (xs[1] - xs[0]), y: ys[0] + u * (ys[1] - ys[0]) };
      },
    };
  }

  const Mx = solveNaturalCubic(ts, xs);
  const My = solveNaturalCubic(ts, ys);

  return {
    t0,
    t1,
    evalAt(t) {
      const tc = clamp(t, t0, t1);
      const i = findSegment(ts, tc);
      return { x: evalSegment(ts, xs, Mx, i, tc), y: evalSegment(ts, ys, My, i, tc) };
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

// Cached accessor; state.js clears obj._cache on any point mutation.
export function trajectoryOf(obj) {
  if (!obj._cache) {
    const traj = buildTrajectory(obj.points);
    obj._cache = { traj, samples: traj && obj.points.length >= 2 ? sampleTrajectory(traj) : null };
  }
  return obj._cache;
}
