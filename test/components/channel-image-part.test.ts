// @vitest-environment happy-dom

import React, { act } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelImagePart as ChannelImagePartModel } from '../../shared/channel-chat-protocol.js';
import {
  ChannelImagePart,
  reservedChannelImageSize,
} from '../../frontend/src/components/chat/ChannelImagePart.js';
import { fetchChannelAttachmentBlob } from '../../frontend/src/lib/api.js';

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../frontend/src/lib/api.js')>()),
  fetchChannelAttachmentBlob: vi.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const part: ChannelImagePartModel = {
  type: 'image',
  id: 'cha:render-test',
  mime: 'image/png',
  w: 800,
  h: 400,
  bytes: 128,
  alt: 'fixture image',
};

let container: HTMLDivElement;
let root: Root;
let intersectionCallback: IntersectionObserverCallback | null = null;
let createObjectUrl: Mock<(obj: Blob | MediaSource) => string>;
let revokeObjectUrl: Mock<(url: string) => void>;
const OriginalIntersectionObserver = globalThis.IntersectionObserver;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

async function renderImage(
  imagePart: ChannelImagePartModel = part
): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(ChannelImagePart, {
        channelId: 'topic:general',
        part: imagePart,
        ordinal: 1,
      })
    );
  });
}

async function reveal(): Promise<void> {
  await act(async () => {
    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChannelImagePart (#1203)', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    intersectionCallback = null;
    globalThis.IntersectionObserver = class IntersectionObserverMock {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '240px';
      readonly thresholds = [0];
    };
    createObjectUrl = vi.fn(() => 'blob:channel-image');
    revokeObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;
    URL.revokeObjectURL = revokeObjectUrl;
    vi.mocked(fetchChannelAttachmentBlob).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelector('.ch-image-lightbox')?.remove();
    globalThis.IntersectionObserver = OriginalIntersectionObserver;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    vi.clearAllMocks();
  });

  it('bounds extreme aspect ratios while enlarging small images when both axes allow it', () => {
    expect(reservedChannelImageSize(1, 10_000)).toMatchObject({
      width: 1,
      height: 320,
    });
    expect(reservedChannelImageSize(10_000, 1)).toMatchObject({
      width: 480,
      height: 1,
    });
    expect(reservedChannelImageSize(1, 1)).toMatchObject({
      width: 96,
      height: 96,
    });
    for (const size of [
      reservedChannelImageSize(1, 10_000),
      reservedChannelImageSize(10_000, 1),
      reservedChannelImageSize(80, 50),
    ]) {
      expect(size.width).toBeLessThanOrEqual(480);
      expect(size.height).toBeLessThanOrEqual(320);
    }
  });

  it('reserves intrinsic geometry before lazily fetching through the authenticated helper', async () => {
    vi.mocked(fetchChannelAttachmentBlob).mockResolvedValue(
      new Blob(['image'], { type: 'image/png' })
    );
    await renderImage();

    const frame = container.querySelector(
      '.ch-image-part'
    ) as HTMLButtonElement;
    expect(frame.style.width).toBe('480px');
    expect(frame.style.height).toBe('240px');
    expect(frame.textContent).toContain('loading image');
    expect(fetchChannelAttachmentBlob).not.toHaveBeenCalled();

    await reveal();
    expect(fetchChannelAttachmentBlob).toHaveBeenCalledWith(
      'topic:general',
      'cha:render-test',
      expect.any(AbortSignal)
    );
    const image = container.querySelector(
      '.ch-image-part__image'
    ) as HTMLImageElement;
    expect(image.src).toContain('blob:channel-image');
    expect(image.loading).toBe('lazy');
    expect(image.alt).toBe('fixture image');

    act(() => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:channel-image');
    root = createRoot(container);
  });

  it('keeps the reserved box and shows a placeholder when the payload is missing', async () => {
    vi.mocked(fetchChannelAttachmentBlob).mockRejectedValue(
      new Error('not found')
    );
    await renderImage();
    await reveal();

    const frame = container.querySelector(
      '.ch-image-part'
    ) as HTMLButtonElement;
    expect(frame.style.width).toBe('480px');
    expect(frame.style.height).toBe('240px');
    expect(frame.textContent).toContain('image unavailable');
    expect(frame.disabled).toBe(true);
  });

  it('applies bounded width and height to an extreme tall frame before fetch', async () => {
    await renderImage({ ...part, w: 1, h: 10_000 });

    const frame = container.querySelector(
      '.ch-image-part'
    ) as HTMLButtonElement;
    expect(frame.style.width).toBe('1px');
    expect(frame.style.height).toBe('320px');
    expect(frame.style.aspectRatio).toBe('');
    expect(fetchChannelAttachmentBlob).not.toHaveBeenCalled();
  });

  it('opens a modal overlay and consumes Escape before the thread layer', async () => {
    vi.mocked(fetchChannelAttachmentBlob).mockResolvedValue(
      new Blob(['image'], { type: 'image/png' })
    );
    let parentEscapes = 0;
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          {
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Escape') parentEscapes += 1;
            },
          },
          React.createElement(ChannelImagePart, {
            channelId: 'topic:general',
            part,
            ordinal: 1,
          })
        )
      );
    });
    await reveal();

    const frame = container.querySelector(
      '.ch-image-part'
    ) as HTMLButtonElement;
    await act(async () => frame.click());
    const dialog = document.querySelector(
      '.ch-image-lightbox'
    ) as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(parentEscapes).toBe(0);
    expect(document.querySelector('.ch-image-lightbox')).toBeNull();
    expect(document.activeElement).toBe(frame);
  });
});
