import { defineConfig } from 'vite';

// rapier3d-compat ships its WASM as base64 inside the JS bundle, so no special
// asset handling is needed. The server WS URL is injected at build via env.
export default defineConfig({
  server: { port: 5173, host: true },
  preview: { port: 4173 },
  define: {
    // Default EMPTY → the client connects to its own origin at runtime (the
    // single-container production setup, where the server serves the frontend
    // and the WS on one port). Dev sets WS_URL=ws://localhost:8090 (see the
    // root `dev:all` script) because there the server is a separate process.
    __WS_URL__: JSON.stringify(process.env.WS_URL ?? ''),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
