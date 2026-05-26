# Latent — notes for Claude

## What this app does

Latent converts RAW photographs of physical film negatives into finished positive images, entirely in the browser. It's a port of [kaimonmok/Film-Scan-Converter](https://github.com/kaimonmok/Film-Scan-Converter) (Python + Tkinter desktop) to a web app.

The Python source is the canonical reference for any new pipeline work. Clone it into `ref/Film-Scan-Converter/` (gitignored) when porting:

```bash
mkdir -p ref && cd ref && git clone https://github.com/kaimonmok/Film-Scan-Converter.git
```

The pipeline you'll port from lives in `ref/Film-Scan-Converter/source/RawProcessing.py`.

## Architecture (three threads)

| Thread | File | Notes |
|---|---|---|
| Main (React) | `src/App.tsx` | UI; calls processor over Comlink |
| Processor (module Web Worker) | `src/workers/processor.worker.ts` | Hosts `libraw-wasm`, runs pipeline, dispatches crop ops |
| OpenCV (classic Web Worker, child of processor) | `public/opencv-worker.js` | Plain JS, `importScripts('/opencv.js')` |

**Why OpenCV is a classic worker:** OpenCV.js cannot init in a module worker. Its Emscripten environment probe checks for `window` (absent) and `importScripts` (absent in module workers, present in classic) and falls through to `IS_SHELL`, then hangs on the wasm load. Keep `public/opencv-worker.js` classic — do not change it to a module worker.

**Why `libraw-wasm` is fine in a module worker:** different Emscripten config; it spawns its own internal worker anyway. We're already nesting workers (main → processor → libraw-wasm's internal → opencv); all combinations are standard.

## Worker contract — read this before touching processor.worker.ts

All methods that mutate `cached` or `croppedCache` MUST run inside `serialize(() => …)`. Comlink dispatches incoming RPCs concurrently — without serialization, `decode(A)` and `decode(B)` (or `process()` during a decode) interleave at `await` boundaries and one call reads the other's pixel buffer. `serialize` is a simple promise-chain queue at module scope.

The OpenCV RPC (`src/workers/opencvClient.ts`) uses numeric IDs and a pending-promise Map. On worker error the worker reference is nulled and terminated so the next call respawns. `whenCvReady` has a 20 s init deadline that rejects all queued waiters; if you see "warming OpenCV...forever" it's almost certainly a regression that broke that deadline.

## Pipeline mapping (TS → Python)

`src/processing/pipeline.ts`:

| TS function | Python source | Lines |
|---|---|---|
| `invert` | inline | `RawProcessing.py:287` |
| `histEqualize` | `hist_EQ` | 426–450 |
| `whiteBalance` | `wb_adjust_coeff` | 478–499 |
| `exposure` | `exposure` | 527–545 |
| `saturation` | `sat_adjust` | 547–558 |
| `runPipeline` | switch | 257–266 |

`public/opencv-worker.js`:

| JS function | Python source | Lines |
|---|---|---|
| `findCropRect` | `find_optimal_crop` + `get_threshold` | 346–424 |
| `applyCrop` | `crop` + `shrink_box` | 361–389, 687–715 |

The Python reference uses BGR (OpenCV native); we keep RGB end-to-end. WB multipliers in `whiteBalance` are rewritten for RGB — see the comment there.

## Auto-crop subtleties

`findCropRect` swaps `width ↔ height` and adds 90° to angle when `cv.minAreaRect` returns angle ≤ 0. This is a no-op geometric transformation — the same rectangle in a different representation. `applyCrop` consumes the rect as-is. **Do not subtract 90 from the angle in `applyCrop`** — earlier code did and it broke tilted negatives. See the fix in commit `b60742d`.

`contours.get(bestIdx)` is called AFTER iterating contours. Do not call `.delete()` on individual contours retrieved from a `MatVector` — the vector owns the underlying memory and the `finally` in `findCropRect` calls `MatVector.delete()` for cleanup.

## Build / run

```bash
npm install
npm run dev       # http://localhost:5177
npm run build     # tsc -b && vite build
npm run typecheck # tsc -b without emit
```

Dev server sets `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (vite.config.ts). Required for `SharedArrayBuffer` / WASM threads. Mirror these on whatever serves the production build, or future opencv / libraw threading regresses.

`optimizeDeps: { exclude: ['libraw-wasm'] }` because the package uses `new Worker(new URL('./worker.js', import.meta.url))` — Vite's prebundler rewrites those URLs and breaks the wasm asset path.

No tests. Verify changes by loading a real RAW or PNG/JPG in dev.

## Conventions

- **Comments**: avoid them. Code should explain itself. Add a comment only when the *why* is non-obvious — a hidden constraint, a workaround, surprising behaviour. Don't narrate what the code does; the code does that.
- **No backwards-compat shims**, no half-finished implementations, no error handling for cases that can't happen.
- **TypeScript strict**. Run `npx tsc -b` before commit. `Uint8ClampedArray.buffer` is `ArrayBufferLike` in TS 5+ — widen typed-array buffer fields in worker contracts accordingly.
- **Memory**: full-resolution RAWs decode to hundreds of MB. Always release wasm objects (`Mat.delete`, `MatVector.delete`) in `finally`. Cache only one image at a time in the processor worker.
- **Fonts** are self-hosted via `@fontsource/*`. Never add a third-party `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` — it breaks behind COOP/COEP.

## Common gotchas

- **OpenCV worker must stay classic** (above)
- **`libraw-wasm` transfers your input buffer**. After `raw.open(bytes)` the buffer is detached. Keep a copy if you need the bytes later (e.g. for full-res re-export).
- **Comlink + Transferable**: use `Comlink.transfer(value, [buf])` for zero-copy returns of typed-array buffers.
- **OffscreenCanvas.convertToBlob** is the correct path for encoding JPEG/PNG in a worker.

## Reference

- Upstream Python: <https://github.com/kaimonmok/Film-Scan-Converter>
- LibRaw-Wasm API: <https://github.com/ybouane/LibRaw-Wasm> — types in `src/libraw-wasm.d.ts` (package ships none)
- OpenCV.js: <https://github.com/TechStark/opencv-js> — vendored verbatim into `public/opencv.js`
