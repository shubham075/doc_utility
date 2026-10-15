import { defineConfig } from 'vitest/config';

// Some tests start Python (qpdf, pyHanko) and generate keys: allow generous time.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
