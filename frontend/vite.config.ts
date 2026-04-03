import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte(), react()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, 'src/lib'),
    },
  },
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        'test-tui-button': resolve(import.meta.dirname, 'test-tui-button.html'),
        'test-filter-chip-bar': resolve(import.meta.dirname, 'test-filter-chip-bar.html'),
        'test-tui-row': resolve(import.meta.dirname, 'test-tui-row.html'),
        'test-tui-menu-item': resolve(import.meta.dirname, 'test-tui-menu-item.html'),
        'test-tui-menu-panel': resolve(import.meta.dirname, 'test-tui-menu-panel.html'),
        'test-pin-input': resolve(import.meta.dirname, 'test-pin-input.html'),
        'test-status-dot': resolve(import.meta.dirname, 'test-status-dot.html'),
        'test-session-status-bar': resolve(import.meta.dirname, 'test-session-status-bar.html'),
        'test-pr-glyph': resolve(import.meta.dirname, 'test-pr-glyph.html'),
        'test-marquee-text': resolve(import.meta.dirname, 'test-marquee-text.html'),
        'test-session-indicator': resolve(import.meta.dirname, 'test-session-indicator.html'),
        'test-shortcut-hint': resolve(import.meta.dirname, 'test-shortcut-hint.html'),
        'test-update-toast': resolve(import.meta.dirname, 'test-update-toast.html'),
        'test-tui-progress': resolve(import.meta.dirname, 'test-tui-progress.html'),
        'test-image-toast': resolve(import.meta.dirname, 'test-image-toast.html'),
        'test-branch-switcher': resolve(import.meta.dirname, 'test-branch-switcher.html'),
        'test-diff-source-toggle': resolve(import.meta.dirname, 'test-diff-source-toggle.html'),
        'test-mobile-header': resolve(import.meta.dirname, 'test-mobile-header.html'),
        'test-agent-badge': resolve(import.meta.dirname, 'test-agent-badge.html'),
        'test-picker-result-row': resolve(import.meta.dirname, 'test-picker-result-row.html'),
        'test-dialog-shell': resolve(import.meta.dirname, 'test-dialog-shell.html'),
        'test-pin-gate': resolve(import.meta.dirname, 'test-pin-gate.html'),
        'test-mobile-input': resolve(import.meta.dirname, 'test-mobile-input.html'),
        'test-context-menu': resolve(import.meta.dirname, 'test-context-menu.html'),
      },
    },
  },
});
