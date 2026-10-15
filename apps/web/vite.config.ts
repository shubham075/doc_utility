import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP enable SharedArrayBuffer (needed later for threaded WASM).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@hyzyla/pdfium'] },
});
