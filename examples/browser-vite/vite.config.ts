import { defineConfig } from 'vite';

export default defineConfig({
  // ESM workers (module workers) — required by spawn.ts's { type: 'module' }.
  worker: { format: 'es' },
});
