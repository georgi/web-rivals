import { defineConfig } from 'vite';

// rapier3d-compat ships its WASM as base64 inside the JS bundle, so no special
// asset handling is needed. The server WS URL is injected at build via env.
export default defineConfig({
  server: { port: 5173, host: true },
  preview: { port: 4173 },
  define: {
    // Default 8090 (not the common-collision 8080); override with WS_URL.
    __WS_URL__: JSON.stringify(process.env.WS_URL ?? 'ws://localhost:8090'),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
