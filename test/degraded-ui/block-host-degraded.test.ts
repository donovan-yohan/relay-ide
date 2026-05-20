/**
 * Tests for slice 4 (#654) — BlockHost degraded-state cards.
 *
 * Covers:
 *   - NodeDegradedCard renders when nodeFileRpcAvailable=false AND kind is a
 *     file-rpc-requiring kind (file, artifact).
 *   - DeniedCard renders when nodeFileRpcAvailable=false but kind is NOT
 *     file-rpc-requiring — the capability gate still applies.
 *   - NodeDegradedCard is distinct from DeniedCard in the rendered HTML.
 *   - Terminal blocks always render regardless of nodeFileRpcAvailable.
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockHost } from '../../frontend/src/workbench/BlockHost.js';
import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockContext,
} from '../../shared/workbench-block-types.js';

// Minimal no-op context helpers
const NOOP_CTX: WorkbenchBlockContext = {
  capabilityGrants: [],
  requestCapability: () => Promise.resolve(false),
  close: () => {},
  emitAuditEvent: () => {},
};

function ctx(
  overrides: Partial<WorkbenchBlockContext> = {}
): WorkbenchBlockContext {
  return { ...NOOP_CTX, ...overrides };
}

function fileDescriptor(
  overrides: Partial<WorkbenchBlockDescriptor> = {}
): WorkbenchBlockDescriptor {
  return {
    id: 'blk-1',
    kind: 'file',
    title: 'readme',
    capabilityRequirements: ['rpc:fs:read'],
    meta: {
      fileRef: { kind: 'file', id: 'file:node-1:/README.md' },
      mode: 'read',
    },
    ...overrides,
  } as WorkbenchBlockDescriptor;
}

function terminalDescriptor(): WorkbenchBlockDescriptor {
  return {
    id: 'blk-2',
    kind: 'terminal',
    title: 'shell',
    capabilityRequirements: ['pty:exec:session'],
    meta: { sessionRef: { kind: 'session', sessionId: 'sess-1' } },
  } as unknown as WorkbenchBlockDescriptor;
}

function artifactDescriptor(): WorkbenchBlockDescriptor {
  return {
    id: 'blk-3',
    kind: 'artifact',
    title: 'output.txt',
    capabilityRequirements: ['rpc:fs:read'],
    meta: {
      artifactRef: { kind: 'artifact', id: 'artifact:1' },
      contentType: 'text/plain',
    },
  } as unknown as WorkbenchBlockDescriptor;
}

describe('BlockHost — NodeDegradedCard (#654)', () => {
  it('renders NodeDegradedCard for a file block when nodeFileRpcAvailable is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: fileDescriptor(),
        context: ctx({ nodeFileRpcAvailable: false }),
      })
    );
    expect(html).toContain('file rpc unavailable on this node');
    expect(html).toContain('block-node-degraded');
  });

  it('renders NodeDegradedCard for an artifact block when nodeFileRpcAvailable is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: artifactDescriptor(),
        context: ctx({ nodeFileRpcAvailable: false }),
      })
    );
    expect(html).toContain('file rpc unavailable on this node');
    expect(html).toContain('block-node-degraded');
  });

  it('does NOT render NodeDegradedCard when nodeFileRpcAvailable is true (falls through to DeniedCard)', () => {
    // The file block still needs rpc:fs:read capability — without it, DeniedCard shows.
    // With nodeFileRpcAvailable=true, we skip the node-degraded check.
    const html = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: fileDescriptor(),
        context: ctx({ nodeFileRpcAvailable: true, capabilityGrants: [] }),
      })
    );
    // DeniedCard should show (missing rpc:fs:read)
    expect(html).not.toContain('file rpc unavailable on this node');
    expect(html).toContain('access denied');
    expect(html).toContain('rpc:fs:read');
  });

  it('does NOT render NodeDegradedCard when nodeFileRpcAvailable is undefined (optimistic)', () => {
    const html = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: fileDescriptor(),
        context: ctx({ nodeFileRpcAvailable: undefined, capabilityGrants: [] }),
      })
    );
    expect(html).not.toContain('file rpc unavailable on this node');
    // Still hits capability gate because rpc:fs:read is not in capabilityGrants
    expect(html).toContain('access denied');
  });

  it('renders terminal blocks regardless of nodeFileRpcAvailable=false', () => {
    const html = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: terminalDescriptor(),
        context: ctx({ nodeFileRpcAvailable: false, capabilityGrants: [] }),
      })
    );
    // Terminal hits the capability gate (pty:exec:session not in grants), but
    // NOT the node-degraded gate — file rpc is irrelevant for terminal.
    expect(html).not.toContain('file rpc unavailable on this node');
    // Should hit access denied for pty:exec:session instead
    expect(html).toContain('access denied');
    expect(html).toContain('pty:exec:session');
  });

  it('NodeDegradedCard content is distinct from DeniedCard content', () => {
    const degradedHtml = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: fileDescriptor(),
        context: ctx({ nodeFileRpcAvailable: false }),
      })
    );
    const deniedHtml = renderToStaticMarkup(
      React.createElement(BlockHost, {
        descriptor: fileDescriptor(),
        context: ctx({ nodeFileRpcAvailable: true, capabilityGrants: [] }),
      })
    );

    // NodeDegradedCard uses warning-coloured heading about node helper
    expect(degradedHtml).toContain('file rpc unavailable on this node');
    expect(degradedHtml).not.toContain('access denied — missing capabilities');

    // DeniedCard talks about capability grants, not node helper
    expect(deniedHtml).toContain('access denied — missing capabilities');
    expect(deniedHtml).not.toContain('file rpc unavailable on this node');
  });
});
