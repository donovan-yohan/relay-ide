import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchNodeFsWrite } from '../frontend/src/lib/api.js';

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function installFetchMock(
  response: Record<string, unknown>,
  status = 200
): () => CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      captured.push({
        url: u,
        method: init?.method ?? 'GET',
        body: bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  ) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = original;
    return captured;
  };
}

describe('fetchNodeFsWrite', () => {
  let restore: () => CapturedRequest[];
  afterEach(() => {
    if (restore) restore();
  });

  it('POSTs to the hub write route with operation, mode, contentBase64', async () => {
    restore = installFetchMock({
      operation: 'write',
      root: '/',
      cwd: '/',
      path: '/x.txt',
      mode: 'overwrite',
      bytesWritten: 5,
      newHash: 'a'.repeat(64),
      newMtime: '2026-05-20T00:00:00Z',
      created: false,
    });

    const res = await fetchNodeFsWrite({
      nodeId: 'mac',
      sessionId: 's1',
      path: '/x.txt',
      mode: 'overwrite',
      content: 'hello',
      expectedHash: 'b'.repeat(64),
    });

    expect(res.bytesWritten).toBe(5);
    expect(res.newHash).toBe('a'.repeat(64));

    const requests = restore();
    restore = () => [];
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/hub/nodes/mac/sessions/s1/files/write');
    expect(requests[0]!.body.path).toBe('/x.txt');
    expect(requests[0]!.body.mode).toBe('overwrite');
    expect(requests[0]!.body.expectedHash).toBe('b'.repeat(64));
    // 'hello' base64-encodes to 'aGVsbG8='
    expect(requests[0]!.body.contentBase64).toBe('aGVsbG8=');
  });

  it('encodes UTF-8 content correctly (multi-byte chars)', async () => {
    restore = installFetchMock({
      operation: 'write',
      root: '/',
      cwd: '/',
      path: '/u.txt',
      mode: 'overwrite',
      bytesWritten: 4,
      newHash: 'c'.repeat(64),
      newMtime: '2026-05-20T00:00:00Z',
      created: false,
    });

    await fetchNodeFsWrite({
      nodeId: 'n',
      sessionId: 's',
      path: '/u.txt',
      mode: 'overwrite',
      content: 'café', // 'é' is 2 bytes in UTF-8 (0xC3 0xA9)
    });

    const requests = restore();
    restore = () => [];
    // 'café' UTF-8 bytes: 0x63 0x61 0x66 0xC3 0xA9 → base64 'Y2Fmw6k='
    expect(requests[0]!.body.contentBase64).toBe('Y2Fmw6k=');
  });

  it('omits expectedHash when not supplied', async () => {
    restore = installFetchMock({
      operation: 'write',
      root: '/',
      cwd: '/',
      path: '/new.txt',
      mode: 'create',
      bytesWritten: 0,
      newHash: 'd'.repeat(64),
      newMtime: '2026-05-20T00:00:00Z',
      created: true,
    });

    await fetchNodeFsWrite({
      nodeId: 'n',
      sessionId: 's',
      path: '/new.txt',
      mode: 'create',
      content: '',
    });

    const requests = restore();
    restore = () => [];
    expect(requests[0]!.body).not.toHaveProperty('expectedHash');
    expect(requests[0]!.body.mode).toBe('create');
  });

  it('surfaces an HttpError on non-OK response', async () => {
    restore = installFetchMock(
      {
        error: {
          code: 'FILE_RPC_WRITE_HASH_MISMATCH',
          message: 'hash mismatch',
        },
      },
      409
    );

    await expect(
      fetchNodeFsWrite({
        nodeId: 'n',
        sessionId: 's',
        path: '/x.txt',
        mode: 'overwrite',
        content: 'hi',
        expectedHash: 'e'.repeat(64),
      })
    ).rejects.toMatchObject({ status: 409 });

    restore();
    restore = () => [];
  });
});
