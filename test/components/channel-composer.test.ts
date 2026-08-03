// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ChannelImagePart,
  ChannelMessagePart,
} from '../../shared/channel-chat-protocol.js';
import {
  CHANNEL_COMPOSER_MAX_IMAGE_BYTES,
  ChannelComposer,
} from '../../frontend/src/components/chat/ChannelComposer.js';
import { uploadChannelImages } from '../../frontend/src/lib/api.js';

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../frontend/src/lib/api.js')>()),
  uploadChannelImages: vi.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

interface RenderOpts {
  onSend?: (
    text: string,
    clientMessageId: string,
    parts: ChannelMessagePart[]
  ) => Promise<void>;
  postPending?: boolean;
  storeDown?: boolean;
  archived?: boolean;
  onRestore?: () => void;
  restorePending?: boolean;
}

async function renderComposer(opts: RenderOpts = {}): Promise<void> {
  // ChannelComposer lazily fetches the @mention roster via useQuery, so it must
  // render under a QueryClientProvider even when the palette never opens.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ChannelComposer, {
          channelId: 'topic:general',
          channelTitle: 'general',
          onSend: opts.onSend ?? (() => Promise.resolve()),
          postPending: opts.postPending ?? false,
          storeDown: opts.storeDown ?? false,
          archived: opts.archived ?? false,
          onRestore: opts.onRestore ?? (() => {}),
          restorePending: opts.restorePending ?? false,
        })
      )
    );
  });
}

async function typeAndEnter(text: string): Promise<void> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  await act(async () => {
    setNativeValue(ta, text);
  });
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function enterAgain(): Promise<void> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function imageFile(name = 'fixture.png', type = 'image/png', size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function pasteFiles(files: File[]): Promise<Event> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
  await act(async () => ta.dispatchEvent(event));
  return event;
}

const imagePart: ChannelImagePart = {
  type: 'image',
  id: 'cha:test-image',
  mime: 'image/png',
  w: 2,
  h: 2,
  bytes: 4,
};
const secondImagePart: ChannelImagePart = {
  ...imagePart,
  id: 'cha:second-image',
};

describe('ChannelComposer (#1178)', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(uploadChannelImages).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('reuses the same clientMessageId on retry after a failed send, then rotates on success', async () => {
    const ids: string[] = [];
    let failNext = true;
    const onSend = vi.fn(async (_text: string, clientMessageId: string) => {
      ids.push(clientMessageId);
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
    });

    await renderComposer({ onSend });

    await typeAndEnter('hello world');
    expect(onSend).toHaveBeenCalledTimes(1);

    // Draft is preserved after the failure so the user can retry.
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe('hello world');

    // Retry (press Enter again) → SAME clientMessageId so the server dedupes.
    await enterAgain();
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(ids[0]).toBe(ids[1]);

    // Success cleared the draft and rotated the idempotency key.
    expect(ta.value).toBe('');
    await typeAndEnter('second message');
    expect(onSend).toHaveBeenCalledTimes(3);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('uploads a pasted image immediately, exposes pending state, and sends an image-only message', async () => {
    let finishUpload: ((parts: ChannelImagePart[]) => void) | undefined;
    vi.mocked(uploadChannelImages).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        })
    );
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });

    const paste = await pasteFiles([imageFile()]);
    expect(paste.defaultPrevented).toBe(true);
    expect(uploadChannelImages).toHaveBeenCalledWith('topic:general', [
      expect.objectContaining({ name: 'fixture.png', type: 'image/png' }),
    ]);
    expect(
      container.querySelector('.ch-composer__attachment-status')?.textContent
    ).toBe('uploading…');

    await act(async () => {
      finishUpload?.([imagePart]);
      await Promise.resolve();
    });
    expect(
      container.querySelector('.ch-composer__attachment-status')?.textContent
    ).toBe('ready');

    await enterAgain();
    // The 4th argument is the #1308 slice 4 steering choice — `undefined` on a
    // plain send, which is what an idle composer always produces.
    expect(onSend).toHaveBeenCalledWith(
      '',
      expect.any(String),
      [imagePart],
      undefined
    );
    expect(container.querySelector('.ch-composer__attachment')).toBeNull();
  });

  it('retains uploaded refs and the clientMessageId when message posting is retried', async () => {
    vi.mocked(uploadChannelImages).mockResolvedValue([imagePart]);
    const calls: Array<{ id: string; parts: ChannelMessagePart[] }> = [];
    let failNext = true;
    const onSend = vi.fn(
      async (_text: string, id: string, parts: ChannelMessagePart[]) => {
        calls.push({ id, parts });
        if (failNext) {
          failNext = false;
          throw new Error('post failed');
        }
      }
    );
    await renderComposer({ onSend });
    await pasteFiles([imageFile()]);
    await act(async () => Promise.resolve());

    await typeAndEnter('with image');
    expect(container.querySelector('.ch-composer__attachment')).not.toBeNull();
    await enterAgain();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.id).toBe(calls[0]?.id);
    expect(calls[0]?.parts).toEqual([imagePart]);
    expect(calls[1]?.parts).toEqual([imagePart]);
    expect(uploadChannelImages).toHaveBeenCalledTimes(1);
  });

  it('preserves attachments added while an earlier post is in flight', async () => {
    vi.mocked(uploadChannelImages)
      .mockResolvedValueOnce([imagePart])
      .mockResolvedValueOnce([secondImagePart]);
    let finishPost: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPost = resolve;
        })
    );
    await renderComposer({ onSend });
    await pasteFiles([imageFile('first.png')]);
    await act(async () => Promise.resolve());

    await typeAndEnter('first post');
    expect(onSend).toHaveBeenCalledWith(
      'first post',
      expect.any(String),
      [imagePart],
      undefined
    );

    await pasteFiles([imageFile('second.png')]);
    await act(async () => Promise.resolve());
    expect(container.querySelectorAll('.ch-composer__attachment')).toHaveLength(
      2
    );

    await act(async () => {
      finishPost?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    const remaining = container.querySelectorAll('.ch-composer__attachment');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('second.png');
    expect(remaining[0]?.textContent).toContain('ready');
    expect(uploadChannelImages).toHaveBeenCalledTimes(2);
  });

  it('caps a draft at four images and rejects oversized files before upload', async () => {
    vi.mocked(uploadChannelImages).mockResolvedValue([imagePart]);
    await renderComposer();
    await pasteFiles(
      Array.from({ length: 5 }, (_, index) => imageFile(`image-${index}.png`))
    );
    expect(uploadChannelImages).toHaveBeenCalledTimes(4);
    expect(container.querySelectorAll('.ch-composer__attachment')).toHaveLength(
      4
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'up to 4 images'
    );

    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.ch-composer__attachment-remove'
      )
    );
    await act(async () => removeButtons[0]?.click());
    await pasteFiles([
      imageFile(
        'too-large.png',
        'image/png',
        CHANNEL_COMPOSER_MAX_IMAGE_BYTES + 1
      ),
    ]);
    expect(uploadChannelImages).toHaveBeenCalledTimes(4);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'max 5mb'
    );
  });

  it('surfaces a failed upload and retries the same file in place', async () => {
    vi.mocked(uploadChannelImages)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([imagePart]);
    await renderComposer();
    await pasteFiles([imageFile()]);
    await act(async () => Promise.resolve());

    expect(
      container.querySelector('.ch-composer__attachment-status')?.textContent
    ).toBe('failed');
    const retry = container.querySelector(
      '.ch-composer__attachment-retry'
    ) as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(uploadChannelImages).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('.ch-composer__attachment-status')?.textContent
    ).toBe('ready');
  });

  it('opens the raster-only file picker fallback from the attach control', async () => {
    await renderComposer();
    const picker = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const pickerClick = vi.spyOn(picker, 'click');
    const attach = container.querySelector(
      '.ch-composer__attach'
    ) as HTMLButtonElement;

    await act(async () => attach.click());
    expect(pickerClick).toHaveBeenCalledTimes(1);
    expect(picker.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    expect(picker.multiple).toBe(true);
  });

  it('shows the 503 store-unavailable banner while keeping the input live', async () => {
    await renderComposer({ storeDown: true });
    const banner = container.querySelector('.ch-composer__banner');
    expect(banner?.textContent).toContain('unavailable');
    // Input stays present (not replaced) so a queued draft is not lost.
    expect(container.querySelector('.ch-composer__ta')).not.toBeNull();
  });

  it('replaces the composer with a restore bar when 409 archived', async () => {
    const onRestore = vi.fn();
    await renderComposer({ archived: true, onRestore });
    expect(container.querySelector('.ch-composer--archived')).not.toBeNull();
    // The textarea is gone in the archived state.
    expect(container.querySelector('.ch-composer__ta')).toBeNull();

    const restore = container.querySelector(
      '.ch-composer__restore'
    ) as HTMLButtonElement;
    await act(async () => restore.click());
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
