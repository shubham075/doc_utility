import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP enable SharedArrayBuffer (needed later for threaded WASM).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: isolation,
    // Dev: forward /api/* to the PDF Suite API service (pnpm dev:services).
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@hyzyla/pdfium', 'quickjs-emscripten', '@jitl/quickjs-wasmfile-release-sync', 'quickjs-emscripten-core'] },
});
