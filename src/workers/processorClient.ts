import * as Comlink from 'comlink';
import type { Processor } from './processor.worker';

let cached: Comlink.Remote<Processor> | null = null;

export function getProcessor(): Comlink.Remote<Processor> {
  if (cached) return cached;
  const worker = new Worker(
    new URL('./processor.worker.ts', import.meta.url),
    { type: 'module', name: 'film-scan-processor' },
  );
  cached = Comlink.wrap<Processor>(worker);
  return cached;
}

export type {
  DecodeResult,
  ProcessResult,
  PreviewMetadata,
  ExportFormat,
  ExportResult,
} from './processor.worker';
