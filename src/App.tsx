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
  const [status, setStatus] = useState('booting worker...');
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
        setStatus('warming OpenCV...');
        await p.warmCv();
        setStatus('worker ready — pick a RAW file');
      } catch (err) {
        setStatus(`worker failed: ${err}`);
      }
    })();
  }, []);

  async function handleFile(file: File) {
    setStatus(`decoding ${file.name}...`);
    setMeta(null);
    setLastProcessMs(null);
    setLastCropMs(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await getProcessor().decode(buf, file.name, params);
      drawPreview(res.width, res.height, res.rgba);
      setMeta({ decode: res, metadata: res.metadata });
      setStatus(`decoded ${file.name} in ${res.decodeMs.toFixed(0)} ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`decode failed: ${msg}`);
      console.error(err);
    }
  }

  // Re-process on every param change. Slider drags fire one event per step;
  // process() runs in the worker so the main thread stays responsive.
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

  return (
    <div className="app">
      <header>
        <h1>Native Film Scan</h1>
        <p className="status">
          {status}
          {lastProcessMs != null && meta && ` · process ${lastProcessMs.toFixed(0)} ms`}
          {lastCropMs != null && meta && ` · last crop ${lastCropMs.toFixed(0)} ms`}
        </p>
      </header>

      <section className="picker">
        <input
          type="file"
          accept=".dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.tiff,.tif,.jpg,.jpeg,.png"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </section>

      <div className="main">
        <section className="preview">
          <canvas ref={previewRef} />
          {meta && (
            <dl>
              <dt>file</dt>
              <dd>{meta.decode.filename}</dd>
              <dt>camera</dt>
              <dd>
                {meta.metadata.cameraMake} {meta.metadata.cameraModel}
              </dd>
              <dt>raw size</dt>
              <dd>
                {meta.metadata.rawWidth} × {meta.metadata.rawHeight}
              </dd>
              <dt>preview</dt>
              <dd>
                {meta.decode.width} × {meta.decode.height} (half-size, 16-bit)
              </dd>
              <dt>exposure</dt>
              <dd>
                ISO {meta.metadata.iso} · 1/
                {meta.metadata.shutter > 0
                  ? Math.round(1 / meta.metadata.shutter)
                  : '?'}
                s · f/{meta.metadata.aperture} · {meta.metadata.focalLength}mm
              </dd>
              <dt>decode</dt>
              <dd>{meta.decode.decodeMs.toFixed(1)} ms</dd>
            </dl>
          )}
        </section>

        <ControlPanel params={params} setParams={setParams} disabled={!meta} />
      </div>
    </div>
  );
}

interface ControlProps {
  params: ProcessParams;
  setParams: (next: ProcessParams) => void;
  disabled: boolean;
}

const FILM_TYPES: { value: FilmType; label: string }[] = [
  { value: 'colour-negative', label: 'Colour negative' },
  { value: 'bw-negative', label: 'B&W negative' },
  { value: 'slide', label: 'Slide / positive' },
  { value: 'crop-only', label: 'No processing' },
];

function ControlPanel({ params, setParams, disabled }: ControlProps) {
  function patch<K extends keyof ProcessParams>(key: K, value: ProcessParams[K]) {
    setParams({ ...params, [key]: value });
  }

  return (
    <aside className="controls" aria-disabled={disabled}>
      <fieldset disabled={disabled}>
        <label className="row">
          <span>Film type</span>
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
        </label>

        <h4>Auto crop</h4>
        <label className="row check">
          <input
            type="checkbox"
            checked={params.autoCrop}
            onChange={(e) => patch('autoCrop', e.target.checked)}
          />
          <span>Detect & crop frame</span>
        </label>
        <Slider label="Dark threshold" min={0} max={100} step={1} value={params.darkThreshold} onChange={(v) => patch('darkThreshold', v)} />
        <Slider label="Light threshold" min={0} max={100} step={1} value={params.lightThreshold} onChange={(v) => patch('lightThreshold', v)} />
        <Slider label="Border crop %" min={-10} max={50} step={1} value={params.borderCrop} onChange={(v) => patch('borderCrop', v)} />

        <h4>Tone</h4>
        <Slider label="Black point" min={-100} max={100} step={1} value={params.blackPoint} onChange={(v) => patch('blackPoint', v)} />
        <Slider label="White point" min={-100} max={100} step={1} value={params.whitePoint} onChange={(v) => patch('whitePoint', v)} />
        <Slider label="Exposure (gamma)" min={-100} max={100} step={1} value={params.gamma} onChange={(v) => patch('gamma', v)} />
        <Slider label="Shadows" min={-100} max={100} step={1} value={params.shadows} onChange={(v) => patch('shadows', v)} />
        <Slider label="Highlights" min={-100} max={100} step={1} value={params.highlights} onChange={(v) => patch('highlights', v)} />

        <h4>Colour</h4>
        <Slider label="Temperature" min={-100} max={100} step={1} value={params.temp} onChange={(v) => patch('temp', v)} />
        <Slider label="Tint" min={-100} max={100} step={1} value={params.tint} onChange={(v) => patch('tint', v)} />
        <Slider label="Saturation" min={0} max={200} step={1} value={params.sat} onChange={(v) => patch('sat', v)} />

        <button type="button" className="reset" onClick={() => setParams(defaultParams)}>
          Reset
        </button>
      </fieldset>
    </aside>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}

function Slider({ label, min, max, step, value, onChange }: SliderProps) {
  return (
    <label className="row slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{value}</output>
    </label>
  );
}
