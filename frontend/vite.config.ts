import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve via Node's module resolution so it works in worktrees, monorepos,
// and any node_modules layout without hard-coded relative paths.
const xtermDir = path.dirname(
  fileURLToPath(import.meta.resolve('@xterm/xterm/package.json'))
);
const addonWebgpu = path.resolve(xtermDir, 'addons', 'addon-webgpu');

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, 'src/lib'),
      '@xterm/addon-webgpu': addonWebgpu,
    },
  },
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        'test-split-pane-layout': resolve(import.meta.dirname, 'test-split-pane-layout.html'),
        'test-mobile-header': resolve(import.meta.dirname, 'test-mobile-header.html'),
      },
    },
  },
});
