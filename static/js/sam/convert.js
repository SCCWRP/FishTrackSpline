// Point object -> new box object: for each point keyframe, seek to its frame,
// encode it, and decode the point as a positive SAM prompt; the mask's
// bounding box becomes a box keyframe at the same time. The point object is
// left unchanged; the new object (+ all its boxes) is one undo entry.

import { addObject, setBoxFromSam, boxAt, getObject, beginBatch, endBatch } from '../state.js';
import { enqueue, embedCurrentFrame, decode, storeMask, samNotice } from './client.js';

function seek(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-6 && !video.seeking) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = t;
  });
}

// onProgress(done, total). Resolves { made, skipped, obj } (obj: the new box object or null).
export function convertPointsToBox(video, pointObj, onProgress) {
  return enqueue(async () => {
    const startTime = video.currentTime;
    video.pause();
    const points = pointObj.points.map((p) => ({ ...p }));
    const results = [];
    for (const [i, p] of points.entries()) {
      await seek(video, p.t);
      const key = await embedCurrentFrame();
      const prompts = { points: [{ x: p.x, y: p.y, label: 1 }], box: null };
      const res = key && (await decode(key, prompts));
      if (res) results.push({ t: p.t, prompts, res });
      onProgress?.(i + 1, points.length);
    }
    await seek(video, startTime);

    let obj = null;
    if (results.length) {
      beginBatch();
      obj = addObject('box', `${pointObj.name} box`);
      for (const r of results) setBoxFromSam(obj.id, r.t, r.res.box, 'sam-points', r.prompts);
      endBatch();
      obj = getObject(obj.id);
      for (const r of results) storeMask(obj, boxAt(obj, r.t), r.res.mask);
    }
    const skipped = points.length - results.length;
    samNotice(`Converted ${results.length}/${points.length} points` + (skipped ? ` (${skipped} without an object)` : ''));
    return { made: results.length, skipped, obj };
  });
}
