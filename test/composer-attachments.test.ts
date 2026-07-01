// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../frontend/src/components/chat/Composer.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
    });
  }
}

function pngFile(name = 'pic.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

describe('Composer image attachments', () => {
  it('shows a chip after selecting an image and sends it as an attachment', async () => {
    const onSend = vi.fn();
    act(() =>
      root.render(
        React.createElement(Composer, {
          onSend,
          onInterrupt: () => {},
          isActive: false,
        })
      )
    );

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    // happy-dom lets us define a read-only files list on the input.
    Object.defineProperty(fileInput, 'files', {
      value: [pngFile()],
      configurable: true,
    });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    const chip = container.querySelector('.composer__chip');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector('img')?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/
    );

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    const [content, attachments] = onSend.mock.calls[0]!;
    expect(content).toBe('');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect(attachments[0].path).toMatch(/^data:image\/png;base64,/);

    // Chip is cleared after send.
    expect(container.querySelector('.composer__chip')).toBeNull();
  });

  it('removes an attachment when its remove button is clicked', async () => {
    act(() =>
      root.render(
        React.createElement(Composer, {
          onSend: () => {},
          onInterrupt: () => {},
          isActive: false,
        })
      )
    );
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      value: [pngFile('a.png')],
      configurable: true,
    });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    expect(container.querySelector('.composer__chip')).not.toBeNull();

    const remove = container.querySelector(
      '.composer__chip-remove'
    ) as HTMLButtonElement;
    act(() => remove.click());
    expect(container.querySelector('.composer__chip')).toBeNull();
  });
});
