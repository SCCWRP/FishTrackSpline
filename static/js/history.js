// Snapshot-based undo/redo. Pure (no DOM): the owner supplies capture/restore.
// checkpoint() is called before a mutation; inside a batch only the first
// checkpoint counts, so a drag or a multi-step edit is a single undo entry.

export function createHistory({ capture, restore, limit = 100 }) {
  const undoStack = [];
  const redoStack = [];
  let batchDepth = 0;
  let batchCaptured = false;

  return {
    checkpoint() {
      if (batchDepth > 0) {
        if (batchCaptured) return;
        batchCaptured = true;
      }
      undoStack.push(capture());
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
    },
    beginBatch() {
      if (batchDepth++ === 0) batchCaptured = false;
    },
    endBatch() {
      batchDepth = Math.max(0, batchDepth - 1);
    },
    undo() {
      if (!undoStack.length) return false;
      redoStack.push(capture());
      restore(undoStack.pop());
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(capture());
      restore(redoStack.pop());
      return true;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
