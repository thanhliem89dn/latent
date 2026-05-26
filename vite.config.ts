import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP headers enable SharedArrayBuffer, which WASM threads in
// libraw-wasm / opencv.js depend on. Dev server only — GitHub Pages can't
// set custom headers, so production runs single-threaded. If you ever
// self-host, mirror these headers there too.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ command }) => ({
  // GH Pages serves the site under /<repo>/. Use the same base for `vite
  // preview` so we can sanity-check the production paths locally.
  base: command === 'build' ? '/latent/' : '/',
  plugins: [react()],
  server: { port: 5177, strictPort: true, headers: crossOriginIsolation },
  preview: { port: 5177, strictPort: true, headers: crossOriginIsolation },
  worker: { format: 'es' },
  // libraw-wasm uses `new Worker(new URL('./worker.js', import.meta.url))` and
  // ships its own .wasm next to that worker. Vite's dep prebundler rewrites
  // those relative URLs and breaks the asset resolution — skip prebundling
  // and let the package be served as-is from node_modules.
  optimizeDeps: { exclude: ['libraw-wasm'] },
}));
