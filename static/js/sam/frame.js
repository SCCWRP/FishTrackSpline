// Capture the frame the <video> is showing, at native resolution, as a PNG blob.

let canvas = null;

export function captureFrame(video) {
  canvas ??= document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0); // synchronous: pixels are fixed here
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('frame capture failed'))), 'image/png');
  });
}
