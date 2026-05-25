// Thin Promise-based RPC over postMessage to the classic opencv worker.
// Called from the processor (module) worker. The opencv worker lives at
// /opencv-worker.js (served verbatim from public/) and uses importScripts
// so that opencv.js's Emscripten env detection lands on IS_WORKER.

import type { RotatedRect, CroppedImage } from '../processing/cropTypes';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker('/opencv-worker.js'); // classic, served from public/
  w.onmessage = (e: MessageEvent) => {
    const { id, result, error } = e.data as {
      id: number;
      result?: unknown;
      error?: string;
    };
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  };
  w.onerror = (e) => {
    const msg = e.message || 'opencv worker crashed';
    for (const [, p] of pending) p.reject(new Error(`opencv worker: ${msg}`));
    pending.clear();
    // Drop the dead worker so the next call respawns a fresh one. Without
    // this, postMessage to a terminated worker silently no-ops and the next
    // pending entry hangs forever.
    if (worker === w) worker = null;
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  };
  worker = w;
  return worker;
}

function call<T>(fn: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ id, fn, args }, transfer);
  });
}

export async function pingOpencv(): Promise<'pong'> {
  return await call<'pong'>('ping', []);
}

export async function findCropRect(
  raw16: Uint16Array,
  channels: 1 | 3,
  w: number,
  h: number,
  darkThreshold: number,
  lightThreshold: number,
): Promise<RotatedRect | null> {
  // The cv worker is in a different agent — transferring would detach the
  // processor's cached buffer. Send a copy and transfer that, so we hand
  // off ownership without losing the cache.
  const copy = new Uint16Array(raw16);
  return await call<RotatedRect | null>(
    'findCropRect',
    [{ raw16: copy, channels, w, h, darkThreshold, lightThreshold }],
    [copy.buffer],
  );
}

export async function applyCrop(
  raw16: Uint16Array,
  channels: 1 | 3,
  w: number,
  h: number,
  rect: RotatedRect,
  borderCrop: number,
): Promise<CroppedImage> {
  const copy = new Uint16Array(raw16);
  return await call<CroppedImage>(
    'applyCrop',
    [{ raw16: copy, channels, w, h, rect, borderCrop }],
    [copy.buffer],
  );
}
