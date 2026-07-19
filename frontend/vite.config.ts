import { defineConfig, type Plugin } from 'vite';
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
import { shikiLazyChunkViolation } from './src/lib/shiki-lazy-chunk-gate.js';

// Resolve via Node's module resolution so it works in worktrees, monorepos,
// and any node_modules layout without hard-coded relative paths.
const xtermDir = path.dirname(
  fileURLToPath(import.meta.resolve('@xterm/xterm/package.json'))
);
const addonWebgpu = path.resolve(xtermDir, 'addons', 'addon-webgpu');
const includeE2eFixtures = process.env.RELAY_IDE_E2E_FIXTURES === '1';

/** Build-time backpressure: syntax grammars must stay off the eager UI path. */
export function shikiLazyChunkGate(): Plugin {
  return {
    name: 'relay-shiki-lazy-chunk-gate',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? [output] : []
      );
      const violation = shikiLazyChunkViolation(chunks);
      if (violation) this.error(violation);
    },
  };
}

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
  buildInputs['test-pr-row-long'] = resolve(
    import.meta.dirname,
    'test-pr-row-long.html'
  );
  buildInputs['test-channel-timeline'] = resolve(
    import.meta.dirname,
    'test-channel-timeline.html'
  );
  buildInputs['test-channel-thread'] = resolve(
    import.meta.dirname,
    'test-channel-thread.html'
  );
  buildInputs['test-agent-detail-rows'] = resolve(
    import.meta.dirname,
    'test-agent-detail-rows.html'
  );
  buildInputs['test-sidebar-mechanics'] = resolve(
    import.meta.dirname,
    'test-sidebar-mechanics.html'
  );
  buildInputs['test-mobile-cockpit'] = resolve(
    import.meta.dirname,
    'test-mobile-cockpit.html'
  );
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), shikiLazyChunkGate()],
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
