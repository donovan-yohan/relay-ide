// @vitest-environment happy-dom

import React, { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileBlock } from '../frontend/src/workbench/blocks/file.js';
import type {
  FileBlockDescriptor,
  WorkbenchBlockContext,
} from '../shared/workbench-block-types.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const filePath = '/tmp/current.txt';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 30; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function fileDescriptor(): FileBlockDescriptor {
  return {
    kind: 'file',
    id: 'file-block-stale-reseed',
    title: 'current.txt',
    capabilityRequirements: ['rpc:fs:read'],
    meta: {
      mode: 'edit',
      fileRef: {
        nodeId: 'node-a',
        path: filePath,
        capturedAt: '2026-01-01T00:00:00Z',
        intent: 'read',
      },
    },
  };
}

function blockContext(): WorkbenchBlockContext {
  return {
    session: {
      nodeId: 'node-a',
      sessionId: 'session-a',
      tabKind: 'terminal',
      cwd: '/tmp',
    },
    capabilityGrants: [
      {
        id: 'grant-a',
        ref: 'grant-a',
        capabilities: ['rpc:fs:read', 'rpc:fs:write'],
        decision: 'allow',
        policyClass: 'write',
      },
    ],
    requestCapability: async () => true,
    close: () => {},
    emitAuditEvent: () => {},
  } as WorkbenchBlockContext;
}

describe('FileBlock edit reload reseed', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let serverContent: string;

  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    serverContent = 'original content';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/files/stat')) {
          return jsonResponse({
            operation: 'stat',
            root: '/',
            cwd: '/tmp',
            path: filePath,
            stat: {
              path: filePath,
              name: 'current.txt',
              type: 'file',
              size: serverContent.length,
              mtimeMs: Date.now(),
              mode: 0o644,
            },
          });
        }
        if (url.endsWith('/files/read')) {
          return jsonResponse({
            operation: 'read',
            root: '/',
            cwd: '/tmp',
            path: filePath,
            encoding: 'utf8',
            content: serverContent,
            bytesRead: serverContent.length,
            truncatedBytes: false,
            truncatedLines: false,
            maxBytes: 65536,
          });
        }
        if (url.endsWith('/files/write')) {
          return jsonResponse(
            {
              error: {
                code: 'INVALID_REQUEST',
                message: 'expected hash mismatch',
                details: {
                  reasonCode: 'FILE_RPC_EXPECTED_HASH_MISMATCH',
                },
              },
            },
            400
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('refetch reload reseeds the draft from changed initialContent after stale expectedHash errors', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(FileBlock, {
            descriptor: fileDescriptor(),
            context: blockContext(),
          })
        )
      );
    });

    await waitFor(() => {
      expect(container.querySelector('textarea')?.value).toBe(
        'original content'
      );
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await act(async () => {
      setTextareaValue(textarea as HTMLTextAreaElement, 'draft stale edit');
    });
    expect(container.querySelector('textarea')?.value).toBe('draft stale edit');

    serverContent = 'server current content';

    await waitFor(() => {
      const preview = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'preview diff'
      );
      expect(preview?.hasAttribute('disabled')).toBe(false);
    });

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'preview diff')
        ?.click();
    });

    await waitFor(() => {
      const confirm = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'confirm write'
      );
      expect(confirm?.hasAttribute('disabled')).toBe(false);
    });

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'confirm write')
        ?.click();
    });

    await waitFor(() => {
      expect(container.textContent).toContain(
        'file changed since last read — reload before saving'
      );
      expect(
        [...container.querySelectorAll('button')].some(
          (button) => button.textContent === 'reload'
        )
      ).toBe(true);
    });

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'reload')
        ?.click();
    });

    await waitFor(() => {
      expect(container.querySelector('textarea')?.value).toBe(
        'server current content'
      );
      expect(container.textContent).not.toContain('draft stale edit');
      expect(container.textContent).not.toContain(
        'file changed since last read — reload before saving'
      );
    });
  });
});
