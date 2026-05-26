// Classic worker hosting OpenCV.js. Module workers can't init opencv.js
// (Emscripten env probe falls through to IS_SHELL and hangs), so we run cv
// ops here over a plain postMessage RPC and have the processor (module
// worker) call us as a nested child worker.
//
// Logic ported from src/processing/crop.ts (which was a TS draft) and
// ultimately from ref/Film-Scan-Converter/source/RawProcessing.py
// (find_optimal_crop, get_threshold, crop, shrink_box).

/* eslint-disable */
/* global cv, importScripts, self */

// Relative-to-this-worker so it resolves correctly both at the dev-server
// root ('/opencv.js') and under a GH Pages subpath ('/latent/opencv.js').
// importScripts() URLs are resolved relative to the worker script's location.
importScripts('./opencv.js');

let cvReady = false;
let cvInitError = null;
const readyWaiters = [];

const INIT_TIMEOUT_MS = 20000;

function whenCvReady() {
  if (cvReady) return Promise.resolve();
  if (cvInitError) return Promise.reject(cvInitError);
  return new Promise((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
  });
}

function flushReady() {
  cvReady = true;
  for (const w of readyWaiters) w.resolve();
  readyWaiters.length = 0;
}

function failInit(err) {
  if (cvReady) return;
  cvInitError = err;
  for (const w of readyWaiters) w.reject(err);
  readyWaiters.length = 0;
}

// Hard deadline so a silent opencv init failure surfaces as an error instead
// of an indefinite hang on every queued message.
setTimeout(() => {
  failInit(
    new Error(`OpenCV failed to initialize within ${INIT_TIMEOUT_MS / 1000}s`),
  );
}, INIT_TIMEOUT_MS);

// opencv.js sets self.cv synchronously, but cv.Mat etc. only exist after
// onRuntimeInitialized fires. The Module instance is the same object as cv.
if (typeof cv !== 'undefined') {
  if (cv.Mat) {
    flushReady();
  } else if (cv instanceof Promise) {
    cv.then((mod) => {
      self.cv = mod;
      flushReady();
    }).catch(failInit);
  } else {
    cv.onRuntimeInitialized = () => flushReady();
  }
} else {
  failInit(new Error('opencv.js did not expose `cv` after importScripts'));
}

function to8bitGray(raw16, channels, w, h) {
  const out = new Uint8Array(w * h);
  const SCALE = 255 / 65535;
  if (channels === 1) {
    for (let i = 0; i < w * h; i++) out[i] = (raw16[i] * SCALE) | 0;
    return out;
  }
  for (let p = 0, src = 0; p < w * h; p++, src += 3) {
    const r = raw16[src];
    const g = raw16[src + 1];
    const b = raw16[src + 2];
    out[p] = ((0.299 * r + 0.587 * g + 0.114 * b) * SCALE) | 0;
  }
  return out;
}

function findCropRect(raw16, channels, w, h, darkThreshold, lightThreshold) {
  const gray = to8bitGray(raw16, channels, w, h);

  const src = new cv.Mat(h, w, cv.CV_8UC1);
  const darkMat = new cv.Mat();
  const lightMat = new cv.Mat();
  const combined = new cv.Mat();
  const eroded = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    src.data.set(gray);
    const dark = (darkThreshold / 100) * 255;
    const light = (lightThreshold / 100) * 255;
    cv.threshold(src, darkMat, dark, 255, cv.THRESH_BINARY);
    cv.threshold(src, lightMat, light, 255, cv.THRESH_BINARY_INV);
    cv.bitwise_and(darkMat, lightMat, combined);
    cv.erode(combined, eroded, kernel, new cv.Point(-1, -1), 2);

    cv.findContours(
      eroded,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    // Don't delete contours retrieved from a MatVector — they share the
    // underlying memory with the vector, which is freed in `finally`. Premature
    // delete can free memory we read back via contours.get(bestIdx).
    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) {
        bestArea = a;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;

    const contour = contours.get(bestIdx);
    const rect = cv.minAreaRect(contour);

    let rectW = rect.size.width;
    let rectH = rect.size.height;
    let angle = rect.angle;
    if (angle <= 0) {
      const tmp = rectW;
      rectW = rectH;
      rectH = tmp;
      angle += 90;
    }
    return {
      cx: rect.center.x / w,
      cy: rect.center.y / h,
      w: rectW / w,
      h: rectH / h,
      angle,
    };
  } finally {
    src.delete();
    darkMat.delete();
    lightMat.delete();
    combined.delete();
    eroded.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function applyCrop(raw16, channels, w, h, rect, borderCrop) {
  const cxPx = rect.cx * w;
  const cyPx = rect.cy * h;
  const wPx = rect.w * w;
  const hPx = rect.h * h;

  const portrait = h > w;
  const xCrop = portrait ? borderCrop : (borderCrop * h) / w;
  const yCrop = portrait ? (borderCrop * w) / h : borderCrop;

  const insetW = wPx * (1 - xCrop / 100);
  const insetH = hPx * (1 - yCrop / 100);
  // findCropRect already normalised the rect: when cv.minAreaRect's angle was
  // ≤ 0 it swapped w/h and added 90 to angle. That swap+rotation is a no-op
  // geometric representation, so we pass it straight through here. (The
  // previous `rect.angle - 90` undid the angle but not the dim swap, producing
  // a rect rotated 90° from the actual one — visible on tilted negatives.)
  const insetRect = {
    center: { x: cxPx, y: cyPx },
    size: { width: insetW, height: insetH },
    angle: rect.angle,
  };
  const box = cv.RotatedRect.points(insetRect);
  const srcPts = new Float32Array([
    box[0].x, box[0].y,
    box[1].x, box[1].y,
    box[2].x, box[2].y,
    box[3].x, box[3].y,
  ]);

  const outW = Math.max(1, Math.round(hPx * (1 - yCrop / 100)));
  const outH = Math.max(1, Math.round(wPx * (1 - xCrop / 100)));
  const dstPts = new Float32Array([
    0, outW - 1,
    0, 0,
    outH - 1, 0,
    outH - 1, outW - 1,
  ]);

  const matType = channels === 3 ? cv.CV_16UC3 : cv.CV_16UC1;
  const srcMat = new cv.Mat(h, w, matType);
  const dstMat = new cv.Mat();
  const srcPtsMat = cv.matFromArray(4, 1, cv.CV_32FC2, Array.from(srcPts));
  const dstPtsMat = cv.matFromArray(4, 1, cv.CV_32FC2, Array.from(dstPts));
  const M = cv.getPerspectiveTransform(srcPtsMat, dstPtsMat);
  const dsize = new cv.Size(outH, outW);
  try {
    srcMat.data16U.set(raw16);
    cv.warpPerspective(
      srcMat,
      dstMat,
      M,
      dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    );
    let outRaw;
    let finalW = dstMat.cols;
    let finalH = dstMat.rows;
    // rect.angle is post-normalisation (in (0, 90]). > 45° means the rect's
    // long axis sits along what cv treats as the height; rotate the output
    // back into landscape orientation. Mirrors Python `if rect[2] > 45`.
    if (rect.angle > 45) {
      const rotated = new cv.Mat();
      cv.rotate(dstMat, rotated, cv.ROTATE_90_CLOCKWISE);
      outRaw = new Uint16Array(rotated.data16U);
      finalW = rotated.cols;
      finalH = rotated.rows;
      rotated.delete();
    } else {
      outRaw = new Uint16Array(dstMat.data16U);
    }
    return { raw16: outRaw, width: finalW, height: finalH };
  } finally {
    srcMat.delete();
    dstMat.delete();
    srcPtsMat.delete();
    dstPtsMat.delete();
    M.delete();
  }
}

self.onmessage = async (e) => {
  const { id, fn, args } = e.data;
  try {
    await whenCvReady();
    let result;
    let transfer = [];
    switch (fn) {
      case 'ping':
        result = 'pong';
        break;
      case 'findCropRect': {
        const a = args[0];
        result = findCropRect(
          a.raw16,
          a.channels,
          a.w,
          a.h,
          a.darkThreshold,
          a.lightThreshold,
        );
        break;
      }
      case 'applyCrop': {
        const a = args[0];
        result = applyCrop(a.raw16, a.channels, a.w, a.h, a.rect, a.borderCrop);
        transfer = [result.raw16.buffer];
        break;
      }
      default:
        throw new Error(`unknown fn: ${fn}`);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
