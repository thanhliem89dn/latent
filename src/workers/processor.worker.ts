import * as Comlink from 'comlink';
import LibRaw, { type Metadata } from 'libraw-wasm';
import {
  defaultParams,
  runPipeline,
  type ProcessParams,
} from '../processing/pipeline';
import type { CroppedImage, RotatedRect } from '../processing/cropTypes';
import {
  applyCrop,
  findCropRect,
  pingOpencv,
} from './opencvClient';

export interface PreviewMetadata {
  cameraMake: string;
  cameraModel: string;
  rawWidth: number;
  rawHeight: number;
  iso: number;
  shutter: number;
  aperture: number;
  focalLength: number;
  timestamp: string | null;
}

export interface DecodeResult {
  filename: string;
  width: number;
  height: number;
  rgba: ArrayBufferLike;
  inputBytes: number;
  decodeMs: number;
  metadata: PreviewMetadata;
}

export interface ProcessResult {
  filename: string;
  width: number;
  height: number;
  rgba: ArrayBufferLike;
  processMs: number;
  cropMs: number; // 0 when crop was cached or disabled
  cropRect: RotatedRect | null;
}

let libraw: LibRaw | null = null;
function getLibRaw(): LibRaw {
  if (!libraw) libraw = new LibRaw();
  return libraw;
}

// All decode/process calls touch the module-scope `cached` and `croppedCache`
// across await boundaries. Comlink's worker dispatches RPC calls
// concurrently, so without a serializer two calls interleave and one returns
// data from the other's pixels. Queue them.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}


interface Cached {
  filename: string;
  width: number;
  height: number;
  channels: 1 | 3;
  raw16: Uint16Array;
}

let cached: Cached | null = null;

// Crop-result cache, keyed by the params that affect the crop output. Avoids
// re-running findContours + warpPerspective on every slider tweak.
interface CroppedCache {
  key: string;
  rect: RotatedRect | null;
  cropped: CroppedImage | null;
}
let croppedCache: CroppedCache | null = null;

function cropKey(p: ProcessParams): string {
  return `${p.darkThreshold}|${p.lightThreshold}|${p.borderCrop}`;
}

const STANDARD_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

function isStandardImage(filename: string): boolean {
  return STANDARD_EXT.test(filename);
}

// Decode a standard image format (PNG/JPEG/WebP/BMP/GIF) via createImageBitmap.
// Result is upscaled into our 16-bit working buffer so the rest of the
// pipeline can treat it the same as a LibRaw decode. Mirrors the Python app's
// cv2.imread fallback (RawProcessing.py:103-114).
async function decodeStandardImage(
  bytes: Uint8Array,
  filename: string,
): Promise<PreviewMetadata> {
  const blob = new Blob([bytes as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

    const px = bitmap.width * bitmap.height;
    const raw16 = new Uint16Array(px * 3);
    const d = imageData.data;
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      // 8-bit → 16-bit by multiplication, matching cv2.imread fallback.
      raw16[j] = d[i * 4] * 257;
      raw16[j + 1] = d[i * 4 + 1] * 257;
      raw16[j + 2] = d[i * 4 + 2] * 257;
    }

    cached = {
      filename,
      width: bitmap.width,
      height: bitmap.height,
      channels: 3,
      raw16,
    };

    return {
      cameraMake: '',
      cameraModel: filename.replace(STANDARD_EXT, ''),
      rawWidth: bitmap.width,
      rawHeight: bitmap.height,
      iso: 0,
      shutter: 0,
      aperture: 0,
      focalLength: 0,
      timestamp: null,
    };
  } finally {
    bitmap.close();
  }
}

async function decodeRaw(
  bytes: Uint8Array,
  filename: string,
): Promise<PreviewMetadata> {
  const raw = getLibRaw();
  await raw.open(bytes, {
    halfSize: true,
    outputBps: 16,
    outputColor: 1,
    useCameraWb: true,
    noAutoBright: true,
    userQual: 3,
  });

  const meta = await raw.metadata();
  const img = await raw.imageData();

  if (img.colors !== 3 && img.colors !== 1) {
    throw new Error(`unexpected channel count from LibRaw: ${img.colors}`);
  }
  if (img.bits !== 16) {
    throw new Error(`expected 16-bit decode, got ${img.bits}-bit`);
  }

  const raw16 = new Uint16Array(
    img.data.buffer,
    img.data.byteOffset,
    img.data.byteLength / 2,
  );

  cached = {
    filename,
    width: img.width,
    height: img.height,
    channels: img.colors as 1 | 3,
    raw16: new Uint16Array(raw16),
  };

  return compactMeta(meta);
}

function compactMeta(m: Metadata): PreviewMetadata {
  return {
    cameraMake: m.camera_make ?? '',
    cameraModel: m.camera_model ?? '',
    rawWidth: m.raw_width ?? 0,
    rawHeight: m.raw_height ?? 0,
    iso: m.iso_speed ?? 0,
    shutter: m.shutter ?? 0,
    aperture: m.aperture ?? 0,
    focalLength: m.focal_len ?? 0,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : null,
  };
}

export class Processor {
  async ping(): Promise<'pong'> {
    return 'pong';
  }

  async warmCv(): Promise<{ ready: true }> {
    await pingOpencv();
    return { ready: true };
  }

  async decode(
    fileBuf: ArrayBuffer,
    filename: string,
    params: ProcessParams = defaultParams,
  ): Promise<DecodeResult> {
    return serialize(async () => {
      const t0 = performance.now();
      const bytes = new Uint8Array(fileBuf);
      const inputBytes = bytes.length;

      // Drop any prior state up front so a mid-decode failure can't leave a
      // stale image visible to subsequent process() calls.
      cached = null;
      croppedCache = null;

      let meta: PreviewMetadata;
      if (isStandardImage(filename)) {
        meta = await decodeStandardImage(bytes, filename);
      } else {
        meta = await decodeRaw(bytes, filename);
      }
      const decodeMs = performance.now() - t0;

      const { rgba8, width, height, cropRect } = await processCached(params);
      const buf = rgba8.buffer;

      return Comlink.transfer(
        {
          filename,
          width,
          height,
          rgba: buf,
          inputBytes,
          decodeMs,
          metadata: meta,
          ...(cropRect ? { cropRect } : {}),
        },
        [buf],
      );
    });
  }

  async process(params: ProcessParams): Promise<ProcessResult> {
    return serialize(async () => {
      if (!cached) throw new Error('no image loaded — call decode() first');
      const t0 = performance.now();
      const { rgba8, width, height, cropMs, cropRect } = await processCached(params);
      const buf = rgba8.buffer;
      return Comlink.transfer(
        {
          filename: cached.filename,
          width,
          height,
          rgba: buf,
          processMs: performance.now() - t0,
          cropMs,
          cropRect,
        },
        [buf],
      );
    });
  }
}

interface PipelineRun {
  rgba8: Uint8ClampedArray;
  width: number;
  height: number;
  cropMs: number;
  cropRect: RotatedRect | null;
}

async function processCached(params: ProcessParams): Promise<PipelineRun> {
  if (!cached) throw new Error('no cached image');

  let pixels: Uint16Array = cached.raw16;
  let w = cached.width;
  let h = cached.height;
  let channels = cached.channels;
  let cropMs = 0;
  let cropRect: RotatedRect | null = null;

  if (params.autoCrop) {
    const key = cropKey(params);
    if (!croppedCache || croppedCache.key !== key) {
      const tCrop = performance.now();
      const rect = await findCropRect(
        cached.raw16,
        cached.channels,
        cached.width,
        cached.height,
        params.darkThreshold,
        params.lightThreshold,
      );
      const cropped = rect
        ? await applyCrop(
            cached.raw16,
            cached.channels,
            cached.width,
            cached.height,
            rect,
            params.borderCrop,
          )
        : null;
      cropMs = performance.now() - tCrop;
      croppedCache = { key, rect, cropped };
    }
    cropRect = croppedCache.rect;
    if (croppedCache.cropped) {
      pixels = croppedCache.cropped.raw16;
      w = croppedCache.cropped.width;
      h = croppedCache.cropped.height;
      channels = cached.channels;
    }
  }

  const rgba8 = runPipeline(pixels, channels, w, h, params);
  return { rgba8, width: w, height: h, cropMs, cropRect };
}

Comlink.expose(new Processor());
