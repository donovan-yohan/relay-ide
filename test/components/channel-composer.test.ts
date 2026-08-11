// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ChannelImagePart,
  ChannelMessageId,
  ChannelMessagePart,
} from '../../shared/channel-chat-protocol.js';
import {
  CHANNEL_COMPOSER_MAX_IMAGE_BYTES,
  ChannelComposer,
} from '../../frontend/src/components/chat/ChannelComposer.js';
import {
  executeChannelAgentCommand,
  fetchChannelRoster,
  HttpError,
  uploadChannelImages,
  type RosterEntry,
} from '../../frontend/src/lib/api.js';

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../frontend/src/lib/api.js')>()),
  executeChannelAgentCommand: vi.fn(),
  fetchChannelRoster: vi.fn(),
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

const codexRoster: RosterEntry[] = [
  {
    id: 'agent-profile:codex:default',
    displayName: 'Codex',
    providerId: 'codex',
    isDefault: true,
    isBuiltIn: true,
    kind: 'framework',
    available: true,
    reason: null,
    binding: null,
    commands: [
      {
        id: 'relay:model',
        name: 'model',
        description: 'Switch model for subsequent Codex responses',
        argumentHint: '<model>',
        args: [
          { value: 'gpt-5.4', label: 'gpt-5.4' },
          { value: 'gpt-5.6', label: 'gpt-5.6' },
        ],
        source: 'relay',
        sourceLabel: 'Relay',
        dispatch: 'relay-control',
        collisionKey: 'model',
      },
      {
        id: 'relay:effort',
        name: 'effort',
        description: 'Set Codex reasoning effort for subsequent responses',
        argumentHint: '<effort>',
        args: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' },
        ],
        source: 'relay',
        sourceLabel: 'Relay',
        dispatch: 'relay-control',
        collisionKey: 'effort',
      },
      {
        id: 'relay:fast',
        name: 'fast',
        description: 'Enable or disable Codex Fast Mode',
        argumentHint: '<on|off>',
        args: [
          { value: 'on', label: 'on' },
          { value: 'off', label: 'off' },
        ],
        source: 'relay',
        sourceLabel: 'Relay',
        dispatch: 'relay-control',
        collisionKey: 'fast',
      },
      {
        id: 'relay:clear',
        name: 'clear',
        description: 'Start a fresh session',
        source: 'relay',
        sourceLabel: 'Relay',
        dispatch: 'relay-control',
        collisionKey: 'clear',
      },
      {
        id: 'native:compact',
        name: 'compact',
        description: 'Provider-native command that must not use Relay controls',
        source: 'sdk',
        dispatch: 'agent',
      },
    ],
  },
];

const primeRoster: RosterEntry[] = [
  {
    id: 'agent-profile:prime-agent:default',
    displayName: 'Prime',
    providerId: 'prime-agent',
    isDefault: true,
    isBuiltIn: true,
    kind: 'framework',
    available: true,
    reason: null,
    binding: null,
    commands: [
      {
        id: 'relay:prime-agent:thinking',
        name: 'thinking',
        aliases: ['effort'],
        description: 'Set Prime Agent reasoning depth',
        args: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' },
        ],
        source: 'builtin',
        sourceLabel: 'Prime Agent',
        dispatch: 'relay-control',
        collisionKey: 'thinking',
      },
    ],
  },
];

interface RenderOpts {
  threadId?: ChannelMessageId;
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
  implicitCommandProviderId?: string;
}

async function renderComposer(opts: RenderOpts = {}): Promise<QueryClient> {
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
          ...(opts.implicitCommandProviderId
            ? { implicitCommandProviderId: opts.implicitCommandProviderId }
            : {}),
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
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
  return queryClient;
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

async function settleRoster(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressKey(
  key: string,
  options: { shiftKey?: boolean } = {}
): Promise<void> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  await act(async () => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ...options,
        bubbles: true,
        cancelable: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressMobileSend(): Promise<Event> {
  const ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    inputType: { value: 'insertLineBreak' },
    isComposing: { value: false },
  });
  await act(async () => {
    ta.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
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
    vi.mocked(fetchChannelRoster).mockResolvedValue(codexRoster);
    vi.mocked(executeChannelAgentCommand).mockReset();
    vi.mocked(executeChannelAgentCommand).mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('grows long drafts to a pane-relative cap and preserves most of a short timeline', async () => {
    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      value: 800,
    });
    container.className = 'ch-main';
    await renderComposer();

    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    Object.defineProperty(ta, 'scrollHeight', {
      configurable: true,
      value: 700,
    });
    await act(async () => setNativeValue(ta, 'a long draft'));

    // 45% of the conversation pane: much more than the old six-line cap.
    expect(ta.style.height).toBe('360px');

    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      value: 320,
    });
    await act(async () => window.dispatchEvent(new Event('resize')));

    // A short/mobile pane still leaves the timeline as the larger region.
    expect(ta.style.height).toBe('144px');
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

  it('turns an exact @profile/fast pick into a dedicated fast control, never a channel post', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;

    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();
    expect(
      container.querySelector(
        '[role="listbox"][aria-label="commands for Codex"]'
      )
    ).not.toBeNull();
    expect(ta.getAttribute('aria-controls')).toBe(
      'channel-agent-command-palette'
    );
    expect(ta.getAttribute('aria-activedescendant')).toBe(
      'channel-agent-command-option-0'
    );

    // First Enter chooses the command, second chooses the default `on` option.
    await pressKey('Enter');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'fast',
      args: 'on',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uses the DM target and live roster values for bare /model without posting', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({
      onSend,
      implicitCommandProviderId: 'codex',
    });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/model'));
    await settleRoster();

    expect(
      container.querySelector(
        '[role="listbox"][aria-label="commands for Codex"]'
      )?.textContent
    ).toContain('/model');
    await pressKey('Enter');
    // The enumerated choices come from the currently fetched roster, not a
    // display-name or static UI list. Choose the second live model.
    await pressKey('ArrowDown');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'model',
      args: 'gpt-5.6',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('');
  });

  it('dispatches a threaded slash command to its exact runtime scope', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({
      threadId: 'chm:thread-42' as ChannelMessageId,
      onSend,
    });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;

    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();
    await pressKey('Enter');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'fast',
      args: 'on',
      threadId: 'chm:thread-42',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('holds a reserved bare Codex control until its live roster resolves', async () => {
    let resolveRoster: ((value: RosterEntry[]) => void) | undefined;
    vi.mocked(fetchChannelRoster).mockImplementation(
      () =>
        new Promise<RosterEntry[]>((resolve) => {
          resolveRoster = resolve;
        })
    );
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend, implicitCommandProviderId: 'codex' });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/model'));
    await act(async () => Promise.resolve());
    expect(fetchChannelRoster).toHaveBeenCalledWith('topic:general');

    // Before the exact default profile and its live catalog arrive, Enter is a
    // loading-palette action, never a 400-producing normal channel post.
    await pressKey('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain('loading commands…');

    await act(async () => {
      resolveRoster?.(codexRoster);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain('loading commands…')
    );
    expect(container.textContent).toContain('/model');
    await pressKey('Enter');
    expect(container.textContent).toContain('gpt-5.4');
  });

  it.each([
    [
      'a default without model controls',
      [{ ...codexRoster[0]!, commands: [] }],
    ],
    ['no current default profile', [{ ...codexRoster[0]!, isDefault: false }]],
  ])(
    'keeps /model unavailable rather than posting when the roster has %s',
    async (_caseName, roster) => {
      vi.mocked(fetchChannelRoster).mockResolvedValue(roster);
      const onSend = vi.fn(async () => {});
      await renderComposer({ onSend, implicitCommandProviderId: 'codex' });
      const ta = container.querySelector(
        '.ch-composer__ta'
      ) as HTMLTextAreaElement;
      await act(async () => setNativeValue(ta, '/model'));
      await settleRoster();

      expect(container.textContent).toContain('commands unavailable');
      await pressKey('Enter');
      expect(onSend).not.toHaveBeenCalled();
      expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    }
  );

  it('uses the DM target for bare /effort without consuming a model turn', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({
      onSend,
      implicitCommandProviderId: 'codex',
    });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/effort'));
    await settleRoster();

    await pressKey('Enter');
    await pressKey('ArrowDown');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'effort',
      args: 'high',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('');
  });

  it('uses the exact non-Codex DM provider profile and live control catalog', async () => {
    vi.mocked(fetchChannelRoster).mockResolvedValue(primeRoster);
    const onSend = vi.fn(async () => {});
    await renderComposer({
      onSend,
      implicitCommandProviderId: 'prime-agent',
    });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/effort'));
    await settleRoster();

    expect(
      container.querySelector(
        '[role="listbox"][aria-label="commands for Prime"]'
      )?.textContent
    ).toContain('/thinking');
    await pressKey('Enter');
    await pressKey('ArrowDown');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:prime-agent:default',
      command: 'thinking',
      args: 'high',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps a bare group-channel slash draft as ordinary prose', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });
    await typeAndEnter('/model gpt-5.6');

    expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      '/model gpt-5.6',
      expect.any(String),
      [],
      undefined
    );
    expect(
      (container.querySelector('[role="listbox"]') as HTMLElement).style.display
    ).toBe('none');
  });

  it('uses a promoted custom Codex default instead of the dormant built-in id', async () => {
    vi.mocked(fetchChannelRoster).mockResolvedValue([
      {
        ...codexRoster[0]!,
        id: 'agent-profile:codex:promoted-default',
        displayName: 'Codex Primary',
        isBuiltIn: false,
      },
    ]);
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend, implicitCommandProviderId: 'codex' });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/model'));
    await settleRoster();

    await pressKey('Enter');
    await pressKey('Enter');
    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:promoted-default',
      command: 'model',
      args: 'gpt-5.4',
    });
    expect(executeChannelAgentCommand).not.toHaveBeenCalledWith(
      'topic:general',
      expect.objectContaining({ profileId: 'agent-profile:codex:default' })
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps unknown Codex slash input and non-Codex DM slash input sendable', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({
      onSend,
      implicitCommandProviderId: 'codex',
    });
    let ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/skill investigate'));
    await settleRoster();
    expect(
      (container.querySelector('[role="listbox"]') as HTMLElement).style.display
    ).toBe('none');
    await pressKey('Enter');
    expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      '/skill investigate',
      expect.any(String),
      [],
      undefined
    );

    vi.mocked(onSend).mockClear();
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderComposer({ onSend, implicitCommandProviderId: 'claude' });
    ta = container.querySelector('.ch-composer__ta') as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '/model sonnet'));
    await settleRoster();
    expect(
      (container.querySelector('[role="listbox"]') as HTMLElement).style.display
    ).toBe('none');
    await pressKey('Enter');
    expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      '/model sonnet',
      expect.any(String),
      [],
      undefined
    );
  });

  it('accepts the single space inserted by mention selection before / commands', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;

    await act(async () => setNativeValue(ta, '@'));
    await settleRoster();
    await pressKey('Enter');
    expect(ta.value).toBe('@codex ');

    await act(async () => setNativeValue(ta, '@codex /'));
    await settleRoster();
    expect(
      container.querySelector(
        '[role="listbox"][aria-label="commands for Codex"]'
      )
    ).not.toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uses the mobile beforeinput send intent to pick the command and its fast value', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();

    expect((await pressMobileSend()).defaultPrevented).toBe(true);
    expect((await pressMobileSend()).defaultPrevented).toBe(true);
    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'fast',
      args: 'on',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('immediately invalidates and refetches the roster after a successful control', async () => {
    vi.mocked(fetchChannelRoster)
      .mockResolvedValueOnce(codexRoster)
      .mockResolvedValueOnce(codexRoster);
    const queryClient = await renderComposer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();

    await pressKey('Enter');
    await pressKey('Enter');

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['channel-roster', 'topic:general'],
      })
    );
    await vi.waitFor(() => expect(fetchChannelRoster).toHaveBeenCalledTimes(2));
  });

  it('immediately refreshes the roster after an unavailable control retracts', async () => {
    vi.mocked(fetchChannelRoster)
      .mockResolvedValueOnce(codexRoster)
      .mockResolvedValueOnce([]);
    vi.mocked(executeChannelAgentCommand).mockRejectedValue(
      new HttpError(
        400,
        'Prime Agent no longer supports /fast on this runtime',
        'INVALID_ARGUMENT',
        false,
        { reasonCode: 'UNAVAILABLE_COMMAND' }
      )
    );
    const queryClient = await renderComposer();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();

    await pressKey('Enter');
    await pressKey('Enter');

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['channel-roster', 'topic:general'],
      })
    );
    await vi.waitFor(() => expect(fetchChannelRoster).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain('no longer supports /fast');
  });

  it('escapes the command palette without losing the exact draft or posting it', async () => {
    const onSend = vi.fn(async () => {});
    await renderComposer({ onSend });
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/fast'));
    await settleRoster();

    await pressKey('Escape');
    expect(ta.value).toBe('@codex/fast');
    expect(
      (
        container.querySelector(
          '[role="listbox"][aria-label="commands for Codex"]'
        ) as HTMLElement
      ).style.display
    ).toBe('none');
    // The next Enter reopens the command preview; it can never route this
    // command-shaped draft as a normal channel message.
    await pressKey('Enter');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation row before a destructive command is sent', async () => {
    await renderComposer();
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/clear'));
    await settleRoster();

    await pressKey('Enter');
    expect(executeChannelAgentCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain('confirm');
    await pressKey('Enter');

    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:codex:default',
      command: 'clear',
      confirmed: true,
    });
  });

  it('uses the most recent exact profile command, not an earlier mention', async () => {
    vi.mocked(fetchChannelRoster).mockResolvedValue([
      ...codexRoster,
      {
        id: 'agent-profile:claude:default',
        displayName: 'Claude',
        providerId: 'claude',
        isDefault: true,
        isBuiltIn: true,
        kind: 'framework',
        available: true,
        reason: null,
        binding: null,
        commands: [
          {
            id: 'relay:claude-clear',
            name: 'clear',
            dispatch: 'relay-control',
            destructive: true,
          },
        ],
      },
    ]);
    await renderComposer();
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/fast … @claude/clear'));
    await settleRoster();

    expect(
      container.querySelector('[role="listbox"]')?.getAttribute('aria-label')
    ).toBe('commands for Claude');
    await pressKey('Enter');
    await pressKey('Enter');
    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:claude:default',
      command: 'clear',
      confirmed: true,
    });
  });

  it('keeps collision-token profile identity when selecting a command', async () => {
    vi.mocked(fetchChannelRoster).mockResolvedValue([
      ...codexRoster,
      {
        id: 'agent-profile:claude:aaaaaa',
        displayName: 'Reviewer',
        providerId: 'claude',
        isDefault: false,
        isBuiltIn: false,
        kind: 'framework',
        available: true,
        reason: null,
        binding: null,
        commands: [
          { id: 'relay:a-fast', name: 'fast', dispatch: 'relay-control' },
        ],
      },
      {
        id: 'agent-profile:codex:bbbbbb',
        displayName: 'Reviewer',
        providerId: 'codex',
        isDefault: false,
        isBuiltIn: false,
        kind: 'framework',
        available: true,
        reason: null,
        binding: null,
        commands: [
          { id: 'relay:b-fast', name: 'fast', dispatch: 'relay-control' },
        ],
      },
    ]);
    await renderComposer();
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@Reviewer#aaaaaa/fast'));
    await settleRoster();

    await pressKey('Enter');
    expect(executeChannelAgentCommand).toHaveBeenCalledWith('topic:general', {
      profileId: 'agent-profile:claude:aaaaaa',
      command: 'fast',
    });
  });

  it('never shows provider-native commands in the Relay control palette', async () => {
    await renderComposer();
    const ta = container.querySelector(
      '.ch-composer__ta'
    ) as HTMLTextAreaElement;
    await act(async () => setNativeValue(ta, '@codex/'));
    await settleRoster();

    expect(container.textContent).toContain('/fast');
    expect(container.textContent).not.toContain('/compact');
  });
});
