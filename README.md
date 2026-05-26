# Latent

Convert RAW photographs of film negatives into finished positives — entirely in the browser, nothing uploaded.

The *latent image* is the invisible image formed on photographic film during exposure, made visible by development. Latent does the same thing for the modern workflow where you photograph your negatives on a copy stand instead of using a flatbed scanner: it reads the RAW, finds the frame inside the carrier, inverts the negative, and stretches the histogram into a finished positive — all on your machine.

It is a port of [kaimonmok/Film-Scan-Converter](https://github.com/kaimonmok/Film-Scan-Converter) (Python + Tkinter, desktop) to the web.

## Features

- **RAW decoding** for DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, and more via [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm)
- **PNG / JPEG / WebP / BMP** decoded via `createImageBitmap` (a fallback path mirroring the Python app's `cv2.imread`)
- **Auto-crop** that finds the film frame inside the larger scan and straightens it — OpenCV.js `threshold` → `findContours` → `minAreaRect` → `warpPerspective`
- **Film type modes**: colour negative, black & white negative, slide / positive, no processing
- **Tonal grading**: black point, white point, exposure, shadows, highlights
- **Colour grading**: temperature, tint, saturation
- **Full-resolution export** as JPEG or PNG, generated in a Web Worker
- **Local-only**: every byte of your scans stays in your browser. No upload, no telemetry, no server.

## Quick start

```bash
npm install
npm run dev
# open http://localhost:5177
```

Load a film scan (RAW or already-converted file), pick the film type, dial in the crop and tone, and download the result.

## How it works

Latent runs three threads:

- **Main thread** (React) — UI, file picker, sliders, canvas preview
- **Processor worker** (module Web Worker) — hosts `libraw-wasm`, runs the pixel pipeline, dispatches crop ops
- **OpenCV worker** (classic Web Worker, child of the processor) — runs threshold, contour detection, perspective warp

A classic worker is required for OpenCV.js because Emscripten's environment probe only initialises correctly when `importScripts` is available. `libraw-wasm` works in a module worker, so the processor stays modern; OpenCV gets its own worker spawned from there.

The processing pipeline (`src/processing/pipeline.ts`) is a faithful port of `RawProcessing.py`:

| Step | Function | Reference |
|------|----------|-----------|
| Invert | `invert` | `RawProcessing.py:287` |
| Per-channel hist-EQ | `histEqualize` | `RawProcessing.py:426-450` |
| Exposure (gamma + shadows + highlights) | `exposure` | `RawProcessing.py:527-545` |
| White balance | `whiteBalance` | `RawProcessing.py:478-499` |
| Saturation | `saturation` | `RawProcessing.py:547-558` |
| Film-type dispatch | `runPipeline` | `RawProcessing.py:257-266` |

Auto-crop lives in `public/opencv-worker.js` and mirrors `find_optimal_crop` / `crop` / `get_threshold` from the same file.

## Stack

- Vite 6 + React 18 + TypeScript (strict)
- [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) — RAW decode in WebAssembly
- [@techstark/opencv-js](https://github.com/TechStark/opencv-js) — OpenCV.js, vendored as `public/opencv.js`
- [Comlink](https://github.com/GoogleChromeLabs/comlink) — Promise-based RPC to the processor worker
- [Newsreader](https://fonts.google.com/specimen/Newsreader) + [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) self-hosted via `@fontsource`

## Design

The UI is *a single sheet of warm paper* — a contact-sheet aesthetic borrowed from photo editorial conventions:

- Newsreader display serif paired with IBM Plex Mono everywhere else
- Warm bone (`#F4EFEA`) on warm ink (`#1A1815`) — no pure black or white
- Sprocket-hole gutters at the top and bottom of the page
- Framed preview with a frame-number tag and edge-code metadata
- Mono-labelled controls grouped into Stock / Crop / Tone / Colour / Export

Design tokens live in `src/App.css`.

## Status

Early prototype. Working today: RAW + standard-image decode, full pipeline at preview resolution, auto-crop, slider grading, full-resolution JPEG / PNG export.

Not yet: batch processing, per-file settings persistence, WB / film-base colour pickers, dust removal, histogram view, dark "darkroom" mode.

## Credits

Algorithm and feature scope owe everything to [kaimonmok/Film-Scan-Converter](https://github.com/kaimonmok/Film-Scan-Converter). RAW decoding by [LibRaw](https://www.libraw.org/) via [ybouane/LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm). Image processing by [OpenCV.js](https://github.com/TechStark/opencv-js).
