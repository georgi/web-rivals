import { defineConfig } from 'vitest/config';

// Shared sim is plain TS (no DOM). Tests run in node by default.
// RapierTraceWorld tests init the WASM build in-process; Mock tests need nothing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
