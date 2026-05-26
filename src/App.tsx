import { useEffect, useRef, useState } from 'react';
import {
  getProcessor,
  type DecodeResult,
  type PreviewMetadata,
} from './workers/processorClient';
import {
  defaultParams,
  type FilmType,
  type ProcessParams,
} from './processing/pipeline';

export function App() {
  const [status, setStatus] = useState('booting');
  const [meta, setMeta] = useState<{
    decode: DecodeResult;
    metadata: PreviewMetadata;
  } | null>(null);
  const [params, setParams] = useState<ProcessParams>(defaultParams);
  const [lastProcessMs, setLastProcessMs] = useState<number | null>(null);
  const [lastCropMs, setLastCropMs] = useState<number | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const p = getProcessor();
    (async () => {
      try {
        await p.ping();
        setStatus('warming opencv');
        await p.warmCv();
        setStatus('ready');
      } catch (err) {
        setStatus(`worker failed: ${err}`);
      }
    })();
  }, []);

  async function handleFile(file: File) {
    setStatus(`decoding ${file.name}`);
    setMeta(null);
    setLastProcessMs(null);
    setLastCropMs(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await getProcessor().decode(buf, file.name, params);
      drawPreview(res.width, res.height, res.rgba);
      setMeta({ decode: res, metadata: res.metadata });
      setStatus(`decoded in ${res.decodeMs.toFixed(0)} ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`decode failed: ${msg}`);
      console.error(err);
    }
  }

  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getProcessor().process(params);
        if (cancelled) return;
        drawPreview(res.width, res.height, res.rgba);
        setLastProcessMs(res.processMs);
        if (res.cropMs > 0) setLastCropMs(res.cropMs);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`process failed: ${msg}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, meta?.decode.filename]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawPreview(w: number, h: number, rgba: ArrayBufferLike) {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const data = new ImageData(
      new Uint8ClampedArray(rgba as ArrayBuffer),
      w,
      h,
    );
    ctx.putImageData(data, 0, 0);
  }

  const frameTag = frameNumberFor(meta?.decode.filename);

  return (
    <div className="sheet">
      <div className="sprockets" aria-hidden="true" />

      <header className="masthead">
        <h1>Native Film Scan</h1>
        <div className="meta">
          <span>contact sheet · negative converter</span>
          <span className="status">
            {status}
            {lastProcessMs != null && meta && ` · ${lastProcessMs.toFixed(0)}ms`}
            {lastCropMs != null && meta && ` · crop ${lastCropMs.toFixed(0)}ms`}
          </span>
        </div>
      </header>

      <section className="picker">
        <span>load</span>
        <input
          type="file"
          accept=".dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.tiff,.tif,.jpg,.jpeg,.png"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </section>

      <div className="layout">
        <section className="preview">
          <div className="frame">
            {meta && <div className="frame-tag">{frameTag}</div>}
            <canvas ref={previewRef} />
          </div>
          <div className="edge-code">
            {meta ? (
              <>
                <span className="em">{meta.decode.filename}</span>
                <span>
                  {meta.metadata.cameraMake} {meta.metadata.cameraModel}
                </span>
                <span>
                  {meta.metadata.iso ? `iso ${meta.metadata.iso} · ` : ''}
                  {meta.metadata.shutter > 0
                    ? `1/${Math.round(1 / meta.metadata.shutter)}s · `
                    : ''}
                  {meta.metadata.aperture
                    ? `f/${meta.metadata.aperture} · `
                    : ''}
                  {meta.metadata.focalLength
                    ? `${meta.metadata.focalLength}mm`
                    : ''}
                </span>
                <span>
                  {meta.decode.width} × {meta.decode.height}
                </span>
              </>
            ) : (
              <span>no negative loaded</span>
            )}
          </div>
        </section>

        <ControlPanel params={params} setParams={setParams} disabled={!meta} />
      </div>

      <div className="sprockets" aria-hidden="true" />

      <footer className="colophon">
        <span>native film scan</span>
        <span>v0 · contact sheet</span>
      </footer>
    </div>
  );
}

// Derive a "frame number" like 23A from the filename. Uses the trailing digits
// of the basename, padded to 2, then a letter from the first char of the rest.
// Falls back to "01".
function frameNumberFor(filename?: string): string {
  if (!filename) return '01';
  const base = filename.replace(/\.[^.]+$/, '');
  const digits = base.match(/(\d+)(?!.*\d)/)?.[1];
  if (!digits) return base.slice(0, 3).toUpperCase().padEnd(2, '·');
  const n = digits.slice(-2).padStart(2, '0');
  // tag the frame with a letter when there are more digits than we showed
  const letter = digits.length > 2 ? 'A' : '';
  return `${n}${letter}`;
}

interface ControlProps {
  params: ProcessParams;
  setParams: (next: ProcessParams) => void;
  disabled: boolean;
}

const FILM_TYPES: { value: FilmType; label: string }[] = [
  { value: 'colour-negative', label: 'Colour negative' },
  { value: 'bw-negative', label: 'Black & white negative' },
  { value: 'slide', label: 'Slide / positive' },
  { value: 'crop-only', label: 'No processing' },
];

function ControlPanel({ params, setParams, disabled }: ControlProps) {
  function patch<K extends keyof ProcessParams>(
    key: K,
    value: ProcessParams[K],
  ) {
    setParams({ ...params, [key]: value });
  }

  return (
    <aside className="controls" aria-disabled={disabled}>
      <fieldset disabled={disabled}>
        <div className="control-group">
          <h2>Stock</h2>
          <div className="row select">
            <span>film type</span>
            <select
              value={params.filmType}
              onChange={(e) => patch('filmType', e.target.value as FilmType)}
            >
              {FILM_TYPES.map((ft) => (
                <option key={ft.value} value={ft.value}>
                  {ft.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="control-group">
          <h2>Crop</h2>
          <label className="row check">
            <input
              type="checkbox"
              checked={params.autoCrop}
              onChange={(e) => patch('autoCrop', e.target.checked)}
            />
            <span>detect frame</span>
          </label>
          <Slider
            label="dark"
            min={0}
            max={100}
            value={params.darkThreshold}
            onChange={(v) => patch('darkThreshold', v)}
          />
          <Slider
            label="light"
            min={0}
            max={100}
            value={params.lightThreshold}
            onChange={(v) => patch('lightThreshold', v)}
          />
          <Slider
            label="border"
            min={-10}
            max={50}
            value={params.borderCrop}
            onChange={(v) => patch('borderCrop', v)}
          />
        </div>

        <div className="control-group">
          <h2>Tone</h2>
          <Slider
            label="black"
            min={-100}
            max={100}
            value={params.blackPoint}
            onChange={(v) => patch('blackPoint', v)}
          />
          <Slider
            label="white"
            min={-100}
            max={100}
            value={params.whitePoint}
            onChange={(v) => patch('whitePoint', v)}
          />
          <Slider
            label="exposure"
            min={-100}
            max={100}
            value={params.gamma}
            onChange={(v) => patch('gamma', v)}
          />
          <Slider
            label="shadows"
            min={-100}
            max={100}
            value={params.shadows}
            onChange={(v) => patch('shadows', v)}
          />
          <Slider
            label="highlights"
            min={-100}
            max={100}
            value={params.highlights}
            onChange={(v) => patch('highlights', v)}
          />
        </div>

        <div className="control-group">
          <h2>Colour</h2>
          <Slider
            label="temperature"
            min={-100}
            max={100}
            value={params.temp}
            onChange={(v) => patch('temp', v)}
          />
          <Slider
            label="tint"
            min={-100}
            max={100}
            value={params.tint}
            onChange={(v) => patch('tint', v)}
          />
          <Slider
            label="saturation"
            min={0}
            max={200}
            value={params.sat}
            onChange={(v) => patch('sat', v)}
          />
        </div>

        <button
          type="button"
          className="reset"
          onClick={() => setParams(defaultParams)}
        >
          Reset settings
        </button>
      </fieldset>
    </aside>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}

function Slider({ label, min, max, value, onChange }: SliderProps) {
  return (
    <div className="row slider">
      <div className="label-row">
        <span>{label}</span>
        <output>{value}</output>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
