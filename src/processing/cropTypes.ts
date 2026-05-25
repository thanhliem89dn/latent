// Shared types used by both the processor (module) worker and the opencv
// (classic) worker. The opencv worker is plain JS so it doesn't import these
// — these definitions are duplicated implicitly by its postMessage shape.

export interface RotatedRect {
  cx: number; // centre x, normalised [0..1]
  cy: number; // centre y, normalised [0..1]
  w: number; // size width, normalised
  h: number; // size height, normalised
  angle: number; // degrees, normalised to match the Python reference
}

export interface CroppedImage {
  raw16: Uint16Array;
  width: number;
  height: number;
}
