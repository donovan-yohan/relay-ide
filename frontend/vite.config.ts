import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBackendProxyTarget,
  createDevProxyConfig,
  getDevFrontendHost,
  getDevFrontendPort,
} from './dev-server.js';

// Resolve via Node's module resolution so it works in worktrees, monorepos,
// and any node_modules layout without hard-coded relative paths.
const xtermDir = path.dirname(
  fileURLToPath(import.meta.resolve('@xterm/xterm/package.json'))
);
const addonWebgpu = path.resolve(xtermDir, 'addons', 'addon-webgpu');
const includeE2eFixtures = process.env.RELAY_IDE_E2E_FIXTURES === '1';

const buildInputs: Record<string, string> = {
  main: resolve(import.meta.dirname, 'index.html'),
  'test-terminal': resolve(import.meta.dirname, 'test-terminal.html'),
};

if (includeE2eFixtures) {
  buildInputs['test-utility-rail-branch-panel'] = resolve(
    import.meta.dirname,
    'test-utility-rail-branch-panel.html'
  );
  buildInputs['test-full-page-diff'] = resolve(
    import.meta.dirname,
    'test-full-page-diff.html'
  );
  buildInputs['test-customize-session-dialog'] = resolve(
    import.meta.dirname,
    'test-customize-session-dialog.html'
  );
  buildInputs['test-environment-picker'] = resolve(
    import.meta.dirname,
    'test-environment-picker.html'
  );
  buildInputs['test-env-picker-dialog'] = resolve(
    import.meta.dirname,
    'test-env-picker-dialog.html'
  );
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, 'src/lib'),
      '@xterm/addon-webgpu': addonWebgpu,
    },
  },
  server: {
    host: getDevFrontendHost(),
    port: getDevFrontendPort(),
    strictPort: true,
    proxy: createDevProxyConfig(buildBackendProxyTarget()),
  },
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      input: buildInputs,
    },
  },
});
