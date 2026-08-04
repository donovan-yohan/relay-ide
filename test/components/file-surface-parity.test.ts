// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceEvidencePreview,
  WorkspaceEvidenceRoot,
} from '../../shared/workspace-evidence.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The Evidence preview reads through TanStack Query; stub it so we exercise the
// rendering/action contract without a network round-trip.
const mockQuery: { current: unknown } = { current: null };
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => mockQuery.current,
}));
vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchWorkspaceEvidencePreview: vi.fn(),
}));

const { WorkspaceEvidencePreview } =
  await import('../../frontend/src/components/WorkspaceEvidencePreview.js');
const { FileTabContent } =
  await import('../../frontend/src/components/FileTabContent.js');

function evidenceRoot(): WorkspaceEvidenceRoot {
  return {
    ref: { id: 'root-1', nodeId: 'local', kind: 'repo' },
    name: 'repo',
    path: '/repo',
    nodeId: 'local',
    kind: 'repo',
    backing: 'repo',
    status: 'available',
    capabilities: { listFiles: true, previewFiles: true },
  } as unknown as WorkspaceEvidenceRoot;
}

function textPreview(): WorkspaceEvidencePreview {
  return {
    state: 'available',
    kind: 'text',
    encoding: 'utf8',
    content: 'hello world\nsecond line\n',
    bytesRead: 24,
    maxBytes: 65536,
    truncated: false,
  };
}

function menuLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.tui-menu-item')).map((el) =>
    (el.textContent ?? '').replace(/^>/, '').trim()
  );
}

describe('file surface parity: shared rendering + action primitives', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockQuery.current = null;
  });

  it('Evidence preview renders the shared CodeBlock and shared FileActionMenu', () => {
    mockQuery.current = {
      isError: false,
      isPending: false,
      data: { preview: textPreview() },
    };
    act(() => {
      root.render(
        React.createElement(WorkspaceEvidencePreview, {
          root: evidenceRoot(),
          selectedPath: 'AGENTS.md',
        })
      );
    });

    // Shared read-only renderer (same component the main file tab uses).
    expect(container.querySelector('.code-block')).not.toBeNull();

    // Shared action primitive, read-only subset.
    const trigger = container.querySelector(
      '.context-menu-trigger'
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    act(() => trigger!.click());
    const labels = menuLabels(container);
    expect(labels).toContain('copy relative path');
    expect(labels).toContain('copy files-read command');
    // Read-only surface must not expose editing actions.
    expect(labels).not.toContain('save');
    expect(labels).not.toContain('copy files-write command');
  });

  it('main file tab read view renders through the same shared CodeBlock', () => {
    act(() => {
      root.render(
        React.createElement(FileTabContent, {
          filePath: 'src/app.ts',
          fileName: 'app.ts',
          tabType: 'code',
          isChanged: false,
          diff: '',
          content: 'const x = 1;\n',
          loading: false,
          error: null,
          diffViewMode: 'unified',
          wordWrap: false,
          hasActiveSession: false,
          onRetry: () => {},
          onCloseTab: () => {},
        })
      );
    });
    expect(container.querySelector('.raw-file')).not.toBeNull();
    expect(container.querySelector('.code-block')).not.toBeNull();
  });
});
