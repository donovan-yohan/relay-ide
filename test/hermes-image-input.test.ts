import { describe, expect, it } from 'vitest';
import {
  attachmentToResponsesImageUrl,
  buildResponsesInput,
  resolveHermesGatewaySettings,
} from '../server/protocol-adapters/hermes-adapter.js';
import type { Attachment } from '../server/protocol-adapter.js';

const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('buildResponsesInput', () => {
  it('returns the plain string when there are no image attachments', () => {
    expect(buildResponsesInput('hello')).toBe('hello');
    expect(
      buildResponsesInput('hello', [{ type: 'file', path: '/tmp/x.txt' }])
    ).toBe('hello');
  });

  it('builds an interleaved user message for image attachments', () => {
    const input = buildResponsesInput('describe', [
      { type: 'image', path: DATA_URI },
    ]);
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: DATA_URI },
        ],
      },
    ]);
  });

  it('reads a file-path image via the injected reader', () => {
    const input = buildResponsesInput(
      'q',
      [{ type: 'image', path: '/tmp/pic.png', mimeType: 'image/png' }],
      () => Buffer.from('PNGBYTES')
    );
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'q' },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`,
          },
        ],
      },
    ]);
  });

  it('states a file-read failure instead of silently omitting the image', () => {
    const input = buildResponsesInput(
      'inspect',
      [{ type: 'image', path: '/tmp/missing.png', mimeType: 'image/png' }],
      () => {
        throw new Error('gone');
      }
    );
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'inspect\n\n[image attachment not deliverable to hermes: missing.png, dimensions unavailable]',
          },
        ],
      },
    ]);
  });
});

describe('attachmentToResponsesImageUrl', () => {
  const img = (path: string, mimeType?: string): Attachment =>
    mimeType ? { type: 'image', path, mimeType } : { type: 'image', path };

  it('passes through data/http/blob urls unchanged', () => {
    expect(attachmentToResponsesImageUrl(img(DATA_URI))).toBe(DATA_URI);
    expect(attachmentToResponsesImageUrl(img('https://x/y.png'))).toBe(
      'https://x/y.png'
    );
  });

  it('encodes a readable file to a data uri, inferring mime from extension', () => {
    expect(
      attachmentToResponsesImageUrl(img('/tmp/a.jpg'), () => Buffer.from('JJ'))
    ).toBe(`data:image/jpeg;base64,${Buffer.from('JJ').toString('base64')}`);
  });

  it('returns null for an unreadable path', () => {
    expect(
      attachmentToResponsesImageUrl(img('/tmp/missing.png'), () => {
        throw new Error('nope');
      })
    ).toBeNull();
  });
});

// Live: proves the real gateway accepts our image-input shape. Skips in CI.
describe('live Hermes gateway image input', () => {
  it('accepts an input_image responses request', async () => {
    const settings = resolveHermesGatewaySettings(undefined);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(settings.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : {}),
    };
    let reachable: boolean;
    try {
      const health = await fetch(`${settings.endpoint}/health`, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      reachable = health.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.log('[skip] no live Hermes gateway at', settings.endpoint);
      return;
    }
    const res = await fetch(`${settings.endpoint}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: buildResponsesInput('What is in this image?', [
          { type: 'image', path: DATA_URI },
        ]),
        stream: false,
        store: true,
        session_id: 'relay-image-itest',
      }),
      signal: AbortSignal.timeout(60000),
    });
    expect(res.ok).toBe(true);
  });
});
