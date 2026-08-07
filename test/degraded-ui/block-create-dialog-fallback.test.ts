/**
 * Tests for slice 4 (#654) — WorkbenchBlockCreateDialog terminal-only fallback.
 *
 * When `nodeFileRpcAvailable` is false:
 *   - 'file' and 'artifact' kinds are hidden from the select options.
 *   - Terminal, markdown, work-context, and custom kinds remain available.
 *   - A warning note is rendered explaining why kinds are hidden.
 *
 * When `nodeFileRpcAvailable` is true or undefined:
 *   - All supported kinds are shown.
 *   - No warning note appears.
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchBlockCreateDialog } from '../../frontend/src/workbench/WorkbenchBlockCreateDialog.js';
import {
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  type EnvironmentOption,
} from '../../shared/environment-option.js';
import { DEFAULT_LOCAL_NODE_ID } from '../../shared/identity.js';

const FRESH_OPTION: EnvironmentOption = {
  schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
  id: 'env-local',
  node: {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    kind: 'local',
    displayName: 'dev mac',
    online: true,
  },
  capabilities: ['rpc:fs:read', 'pty:exec:session'],
  cwd: '/home/user/project',
  cwdMode: 'free',
  freshness: 'fresh',
  generatedAt: '2026-05-19T00:00:00.000Z',
};

function renderDialog(props: { nodeFileRpcAvailable?: boolean }) {
  return renderToStaticMarkup(
    React.createElement(WorkbenchBlockCreateDialog, {
      candidates: [FRESH_OPTION],
      onCreate: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    })
  );
}

describe('WorkbenchBlockCreateDialog — terminal-only fallback (#654)', () => {
  it('shows all supported kinds when nodeFileRpcAvailable is undefined', () => {
    const html = renderDialog({ nodeFileRpcAvailable: undefined });
    expect(html).toContain('terminal');
    expect(html).toContain('file');
    expect(html).toContain('artifact');
    expect(html).toContain('markdown');
    expect(html).not.toContain('file and artifact blocks hidden');
  });

  it('shows all supported kinds when nodeFileRpcAvailable is true', () => {
    const html = renderDialog({ nodeFileRpcAvailable: true });
    expect(html).toContain('file');
    expect(html).toContain('artifact');
    expect(html).not.toContain('file and artifact blocks hidden');
  });

  it('hides file and artifact kinds when nodeFileRpcAvailable is false', () => {
    const html = renderDialog({ nodeFileRpcAvailable: false });
    // Option elements for file and artifact must be absent
    // (exact match to avoid false positives from CSS class names or text)
    expect(html).not.toMatch(/value="file"/);
    expect(html).not.toMatch(/value="artifact"/);
  });

  it('keeps terminal, markdown, work-context, and custom when file rpc is unavailable', () => {
    const html = renderDialog({ nodeFileRpcAvailable: false });
    expect(html).toContain('terminal');
    expect(html).toContain('markdown');
    expect(html).toContain('work-context');
    expect(html).toContain('custom');
  });

  it('shows the file-rpc warning note when nodeFileRpcAvailable is false', () => {
    const html = renderDialog({ nodeFileRpcAvailable: false });
    expect(html).toContain('file and artifact blocks hidden');
    expect(html).toContain('file rpc unavailable on this node');
  });

  it('does not show the file-rpc warning note when nodeFileRpcAvailable is true', () => {
    const html = renderDialog({ nodeFileRpcAvailable: true });
    expect(html).not.toContain('file and artifact blocks hidden');
  });
});
