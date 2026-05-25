// Image-processing pipeline ported from
//   ref/Film-Scan-Converter/source/RawProcessing.py
// All functions operate on planar working buffers (Float32Array, length w*h*3,
// values in [0, 65535]) so we can chain them without round-tripping through 8-bit.

export type FilmType = 'bw-negative' | 'colour-negative' | 'slide' | 'crop-only';

export interface ProcessParams {
  filmType: FilmType;
  // Hist-EQ offsets, -100..100. Map to the Python app's `black_point` /
  // `white_point` sliders (RawProcessing.py:439-449).
  blackPoint: number;
  whitePoint: number;
  // Exposure controls, -100..100. RawProcessing.py:527-545.
  gamma: number;
  shadows: number;
  highlights: number;
  // White-balance, -100..100. RawProcessing.py:478-499 (wb_adjust_coeff).
  temp: number;
  tint: number;
  // Saturation, 0..200 (100 = no change). RawProcessing.py:547-558.
  sat: number;
  // Auto-crop knobs. dark/light are the thresholds in percent that drive
  // contour detection (RawProcessing.py:413-424). borderCrop trims/extends
  // the resulting rect (-10..50%).
  autoCrop: boolean;
  darkThreshold: number;
  lightThreshold: number;
  borderCrop: number;
}

export const defaultParams: ProcessParams = {
  filmType: 'colour-negative',
  blackPoint: 0,
  whitePoint: 0,
  gamma: 0,
  shadows: 0,
  highlights: 0,
  temp: 0,
  tint: 0,
  sat: 100,
  autoCrop: true,
  darkThreshold: 25,
  lightThreshold: 100,
  borderCrop: 1,
};

const BLACK_PCT = 0.5; // default_parameters['black_point_percentile']
const WHITE_PCT = 99.0; // default_parameters['white_point_percentile']
const EQ_SENSITIVITY = 0.2; // RawProcessing.py:428

// Build a Float32 working buffer from LibRaw's 16-bit RGB pack.
export function expandU16ToFloat(
  raw16: Uint16Array,
  channels: 1 | 3,
): Float32Array {
  if (channels === 3) {
    const out = new Float32Array(raw16.length);
    for (let i = 0; i < raw16.length; i++) out[i] = raw16[i];
    return out;
  }
  // grayscale → replicate to 3 channels so the rest of the pipeline is uniform
  const out = new Float32Array(raw16.length * 3);
  for (let i = 0; i < raw16.length; i++) {
    const v = raw16[i];
    out[i * 3] = v;
    out[i * 3 + 1] = v;
    out[i * 3 + 2] = v;
  }
  return out;
}

export function invert(img: Float32Array): void {
  for (let i = 0; i < img.length; i++) img[i] = 65535 - img[i];
}

// Exact per-channel percentile via a 16-bit histogram. O(N) per channel.
function percentile(
  img: Float32Array,
  channel: 0 | 1 | 2,
  pct: number,
): number {
  const hist = new Uint32Array(65536);
  let count = 0;
  for (let i = channel; i < img.length; i += 3) {
    let v = img[i] | 0;
    if (v < 0) v = 0;
    else if (v > 65535) v = 65535;
    hist[v]++;
    count++;
  }
  const target = Math.max(1, Math.floor((pct / 100) * count));
  let acc = 0;
  for (let v = 0; v < 65536; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 65535;
}

// Ported from hist_EQ (RawProcessing.py:426-450). Per-channel black/white-point
// stretch with user offsets. No film-base detection yet.
export function histEqualize(
  img: Float32Array,
  params: ProcessParams,
): void {
  for (let ch = 0; ch < 3; ch++) {
    const chTyped = ch as 0 | 1 | 2;
    const blackPt = percentile(img, chTyped, BLACK_PCT);
    const blackOffset =
      (params.blackPoint / 100) * EQ_SENSITIVITY * 65535 - blackPt;

    for (let i = ch; i < img.length; i += 3) img[i] += blackOffset;

    const whitePt = percentile(img, chTyped, WHITE_PCT);
    const whiteMul =
      whitePt > 0
        ? (65535 + (params.whitePoint / 100) * EQ_SENSITIVITY * 65535) / whitePt
        : 1;

    for (let i = ch; i < img.length; i += 3) img[i] *= whiteMul;
  }
}

// Ported from wb_adjust_coeff (RawProcessing.py:478-499). Original is in BGR;
// rewritten for RGB.
export function whiteBalance(img: Float32Array, params: ProcessParams): void {
  if (params.temp === 0 && params.tint === 0) return;
  const M = 200;
  const rMul = 1 + params.temp / M + params.tint / M / 2;
  const gMul = 1 - params.tint / M;
  const bMul = 1 - params.temp / M + params.tint / M / 2;
  for (let i = 0; i < img.length; i += 3) {
    img[i] *= rMul;
    img[i + 1] *= gMul;
    img[i + 2] *= bMul;
  }
}

// Ported from exposure (RawProcessing.py:527-545). Operates on normalized
// [0, 1] values, then rescales back to [0, 65535].
export function exposure(img: Float32Array, params: ProcessParams): void {
  const gammaExp = Math.pow(2, -params.gamma / 100);
  const s = params.shadows;
  const h = params.highlights;
  const shadowsCoef = 4.15e-5 * s * s + 0.02185 * s;
  const highlightsCoef = -4.15e-5 * h * h + 0.02185 * h;

  const skipShadows = s === 0;
  const skipHighlights = h === 0;
  const skipGamma = params.gamma === 0;

  for (let i = 0; i < img.length; i++) {
    let v = img[i] / 65535;
    if (v < 0) v = 0;
    if (!skipGamma) v = Math.pow(v, gammaExp);
    if (!skipShadows) {
      const t = v - 0.75;
      if (t < 0) v += shadowsCoef * t * t * v;
    }
    if (!skipHighlights) {
      const t = v - 0.25;
      if (t > 0) v += highlightsCoef * t * t * (1 - v);
    }
    img[i] = v * 65535;
  }
}

// Ported from sat_adjust (RawProcessing.py:547-558). Direct HSV math to avoid
// dragging in a color library.
export function saturation(img: Float32Array, params: ProcessParams): void {
  if (params.sat === 100) return;
  const k = params.sat / 100;
  for (let i = 0; i < img.length; i += 3) {
    const r = img[i] / 65535;
    const g = img[i + 1] / 65535;
    const b = img[i + 2] / 65535;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) continue;
    const s = (max - min) / max;
    const newS = Math.min(1, s * k);
    if (newS === s) continue;
    // Scale chroma around the value (max). New min = max * (1 - newS).
    const newMin = max * (1 - newS);
    const scale = max === min ? 0 : (max - newMin) / (max - min);
    img[i] = (max - (max - r) * scale) * 65535;
    img[i + 1] = (max - (max - g) * scale) * 65535;
    img[i + 2] = (max - (max - b) * scale) * 65535;
  }
}

// Final tonemap: clip to [0, 65535] then pack into a canvas-ready RGBA buffer.
export function toRgba8(
  img: Float32Array,
  w: number,
  h: number,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const SCALE = 255 / 65535;
  for (let p = 0, src = 0; p < w * h; p++, src += 3) {
    rgba[p * 4 + 0] = img[src] * SCALE;
    rgba[p * 4 + 1] = img[src + 1] * SCALE;
    rgba[p * 4 + 2] = img[src + 2] * SCALE;
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

// Pipeline dispatch — mirrors the switch in RawProcessing.py:257-266.
export function runPipeline(
  raw16: Uint16Array,
  channels: 1 | 3,
  w: number,
  h: number,
  params: ProcessParams,
): Uint8ClampedArray {
  if (params.filmType === 'crop-only') {
    // Direct 16-bit → 8-bit pack.
    const out = new Uint8ClampedArray(w * h * 4);
    const SCALE = 255 / 65535;
    if (channels === 3) {
      for (let p = 0, src = 0; p < w * h; p++, src += 3) {
        out[p * 4 + 0] = raw16[src] * SCALE;
        out[p * 4 + 1] = raw16[src + 1] * SCALE;
        out[p * 4 + 2] = raw16[src + 2] * SCALE;
        out[p * 4 + 3] = 255;
      }
    } else {
      for (let p = 0; p < w * h; p++) {
        const v = raw16[p] * SCALE;
        out[p * 4 + 0] = v;
        out[p * 4 + 1] = v;
        out[p * 4 + 2] = v;
        out[p * 4 + 3] = 255;
      }
    }
    return out;
  }

  const img = expandU16ToFloat(raw16, channels);

  switch (params.filmType) {
    case 'bw-negative':
      // Force grayscale: average channels, replicate.
      if (channels === 3) {
        for (let i = 0; i < img.length; i += 3) {
          const g = (img[i] + img[i + 1] + img[i + 2]) / 3;
          img[i] = g;
          img[i + 1] = g;
          img[i + 2] = g;
        }
      }
      invert(img);
      histEqualize(img, params);
      exposure(img, params);
      break;
    case 'colour-negative':
      invert(img);
      histEqualize(img, params);
      whiteBalance(img, params);
      exposure(img, params);
      saturation(img, params);
      break;
    case 'slide':
      histEqualize(img, params);
      whiteBalance(img, params);
      exposure(img, params);
      saturation(img, params);
      break;
  }

  return toRgba8(img, w, h);
}
