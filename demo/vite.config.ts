import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The hosted demo: a static build with relative paths, so it works from any URL
// (GitHub Pages serves it under the repository's name).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../out/demo', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
});
