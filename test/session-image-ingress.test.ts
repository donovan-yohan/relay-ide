import * as fs from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';

import {
  cleanupSessionImageTempDir,
  ingressSessionImage,
  parseSessionImagePayload,
  SessionImageIngressError,
} from '../server/session-image-ingress.js';
import { _resetForTesting as resetClipboardToolCache } from '../server/clipboard.js';
import type { Session } from '../server/types.js';

const OLD_DISPLAY = process.env['DISPLAY'];
const OLD_WAYLAND_DISPLAY = process.env['WAYLAND_DISPLAY'];

afterEach(() => {
  if (OLD_DISPLAY === undefined) delete process.env['DISPLAY'];
  else process.env['DISPLAY'] = OLD_DISPLAY;
  if (OLD_WAYLAND_DISPLAY === undefined) delete process.env['WAYLAND_DISPLAY'];
  else process.env['WAYLAND_DISPLAY'] = OLD_WAYLAND_DISPLAY;
  resetClipboardToolCache();
  cleanupSessionImageTempDir('sess-image-test');
  cleanupSessionImageTempDir('../evil');
});

describe('session image ingress', () => {
  it('validates MIME and size before writing', () => {
    expect(() =>
      parseSessionImagePayload({ data: 'abc', mimeType: 'image/png' })
    ).not.toThrow();
    expect(() =>
      parseSessionImagePayload({ data: 'abc', mimeType: 'text/plain' })
    ).toThrow(SessionImageIngressError);
    expect(() =>
      parseSessionImagePayload({
        data: 'x'.repeat(15 * 1024 * 1024),
        mimeType: 'image/png',
      })
    ).toThrow(/too large/i);
  });

  it('falls back to bracketed-paste path injection when no clipboard tool is available', async () => {
    delete process.env['DISPLAY'];
    delete process.env['WAYLAND_DISPLAY'];
    resetClipboardToolCache();

    const writes: string[] = [];
    const sessions = {
      get: (id: string) =>
        id === 'sess-image-test'
          ? ({ id, mode: 'pty' } as unknown as Session)
          : undefined,
      write: (_id: string, data: string) => writes.push(data),
    };

    const result = await ingressSessionImage({
      sessions,
      sessionId: 'sess-image-test',
      payload: {
        data: Buffer.from('png-bytes').toString('base64'),
        mimeType: 'image/png',
      },
      now: () => 123,
    });

    expect(result).toMatchObject({
      clipboardSet: false,
      inserted: true,
      mode: 'path',
    });
    expect(result.path).toContain(
      Buffer.from('sess-image-test', 'utf8').toString('base64url')
    );
    expect(result.path.endsWith('/paste-123.png')).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('png-bytes');
    expect(writes).toEqual([`\x1b[200~${result.path}\x1b[201~`]);
  });

  it('encodes session ids before using them in temp paths', async () => {
    delete process.env['DISPLAY'];
    delete process.env['WAYLAND_DISPLAY'];
    resetClipboardToolCache();

    const traversalId = '../evil';
    const sessions = {
      get: (id: string) =>
        id === traversalId
          ? ({ id, mode: 'pty' } as unknown as Session)
          : undefined,
      write: () => undefined,
    };

    const result = await ingressSessionImage({
      sessions,
      sessionId: traversalId,
      payload: {
        data: Buffer.from('png-bytes').toString('base64'),
        mimeType: 'image/png',
      },
      now: () => 321,
    });

    expect(result.path).toContain(
      Buffer.from(traversalId, 'utf8').toString('base64url')
    );
    expect(result.path).not.toContain('../evil');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('png-bytes');
  });

  it('records fallback PTY insertion as human supervisor input when available', async () => {
    delete process.env['DISPLAY'];
    delete process.env['WAYLAND_DISPLAY'];
    resetClipboardToolCache();

    const supervisorWrites: unknown[] = [];
    const sessions = {
      get: (id: string) =>
        id === 'sess-image-test'
          ? ({ id, mode: 'pty' } as unknown as Session)
          : undefined,
      write: () => {
        throw new Error(
          'raw PTY write should not be used when supervisorWrite exists'
        );
      },
      supervisorWrite: (_id: string, input: unknown) =>
        supervisorWrites.push(input),
    };

    const result = await ingressSessionImage({
      sessions,
      sessionId: 'sess-image-test',
      payload: {
        data: Buffer.from('png-bytes').toString('base64'),
        mimeType: 'image/png',
      },
      now: () => 789,
    });

    expect(supervisorWrites).toEqual([
      {
        action: 'sendText',
        actor: {
          kind: 'human',
          id: 'browser-image-paste',
          displayName: 'Browser image paste',
        },
        payload: `\x1b[200~${result.path}\x1b[201~`,
      },
    ]);
  });
});
