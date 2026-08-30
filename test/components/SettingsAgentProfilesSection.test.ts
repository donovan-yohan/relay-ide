// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentProfile } from '../../shared/agent-profile.js';
import { deleteAgentProfile } from '../../frontend/src/lib/api.js';
import type { FrameworkInfo } from '../../frontend/src/lib/types.js';
import { SearchableSelect } from '../../frontend/src/components/SearchableSelect.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConfigStore } from '../../frontend/src/lib/stores/config.js';
import {
  AgentProfileEditor,
  AgentProfileGallery,
  SettingsAgentProfilesSection,
  groupAgentProfiles,
  hermesProfileDraftError,
  profileDraftFrom,
  profileSubmitInput,
  withProfileProvider,
} from '../../frontend/src/components/dialogs/SettingsAgentProfilesSection.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const matchMedia = () =>
  ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as MediaQueryList;

const frameworks: FrameworkInfo[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: true,
    },
    eventSource: 'hooks',
  },
  {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: true,
    },
    eventSource: 'hooks',
  },
];

const hermesFrameworks: FrameworkInfo[] = [
  ...frameworks,
  {
    id: 'hermes',
    displayName: 'Hermes',
    command: 'hermes',
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: true,
    },
    eventSource: 'hooks',
  },
];

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agent-profile:claude:reviewer',
    providerId: 'claude',
    displayName: 'reviewer claude',
    avatar: null,
    model: 'sonnet',
    effort: 'high',
    isDefault: false,
    isBuiltIn: false,
    ...overrides,
  };
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function selectFramework(
  host: HTMLElement,
  label: string
): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>('.ss-trigger');
  await act(async () => trigger?.click());
  const option = Array.from(
    host.querySelectorAll<HTMLElement>('[role="option"]')
  ).find(
    (item) =>
      item.querySelector('.tui-menu-item__content')?.textContent?.trim() ===
      label
  );
  await act(async () =>
    option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  );
}

describe('AgentProfileEditor', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', matchMedia);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('submits a create profile draft from the configured provider catalog', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(AgentProfileEditor, {
          key: 'create-submit',
          frameworks,
          onCancel: vi.fn(),
          onSubmit,
        })
      );
    });
    await act(async () => {
      setInput(
        host.querySelector(
          'input[placeholder="e.g. reviewer codex"]'
        ) as HTMLInputElement,
        'review codex'
      );
    });
    await selectFramework(host, 'Codex');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'codex',
        displayName: 'review codex',
      })
    );
  });

  it('clears provider-owned model and effort when a create draft changes provider', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(AgentProfileEditor, {
          key: 'create-reset',
          frameworks,
          onCancel: vi.fn(),
          onSubmit,
        })
      );
    });
    const fields = Array.from(host.querySelectorAll('input'));
    await act(async () => {
      setInput(fields[1] as HTMLInputElement, 'gpt-5');
      setInput(fields[2] as HTMLInputElement, 'high');
    });
    await selectFramework(host, 'Codex');
    expect(
      Array.from(host.querySelectorAll('input')).map((input) => input.value)
    ).not.toContain('gpt-5');
    expect(
      Array.from(host.querySelectorAll('input')).map((input) => input.value)
    ).not.toContain('high');
  });

  it('submits an update profile draft', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(AgentProfileEditor, {
          key: 'update-submit',
          profile: profile({ displayName: 'updated reviewer' }),
          frameworks,
          onCancel: vi.fn(),
          onSubmit,
        })
      );
    });
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: 'claude',
        displayName: 'updated reviewer',
      })
    );
  });

  it('serializes blank optional fields as clear patches for an existing profile', () => {
    expect(
      profileSubmitInput(profileDraftFrom(profile()), { clearEmpty: true })
    ).toEqual(
      expect.objectContaining({
        systemPrompt: null,
        envVars: null,
        namePool: null,
        respondToAllowlist: null,
      })
    );
  });

  it('keeps an explicit blank display name when an edit resets to catalog inheritance', () => {
    expect(
      profileSubmitInput(
        { ...profileDraftFrom(profile()), displayName: '' },
        { clearEmpty: true }
      )
    ).toEqual(expect.objectContaining({ displayName: '' }));
  });
});

describe('AgentProfileEditor hermes profile binding (#1453)', () => {
  let host: HTMLDivElement;
  let root: Root;

  const hermesProfile = (overrides: Partial<AgentProfile> = {}) =>
    profile({
      id: 'agent-profile:hermes:product',
      providerId: 'hermes',
      displayName: 'product owner',
      model: '',
      effort: '',
      ...overrides,
    });

  const hermesInput = () =>
    host.querySelector<HTMLInputElement>('input[placeholder="hermes default"]');

  const renderEditor = async (
    props: Partial<Parameters<typeof AgentProfileEditor>[0]> & {
      key?: string;
    } = {}
  ) => {
    await act(async () => {
      root.render(
        React.createElement(AgentProfileEditor, {
          frameworks: hermesFrameworks,
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          ...props,
        })
      );
    });
  };

  beforeEach(() => {
    vi.stubGlobal('matchMedia', matchMedia);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('renders the binding field with its helper text only for the hermes provider', async () => {
    await renderEditor({ profile: profile() });
    expect(hermesInput()).toBeNull();
    await renderEditor({ key: 'hermes', profile: hermesProfile() });
    expect(hermesInput()).not.toBeNull();
    expect(
      host.querySelector('.agent-profiles-editor__field-hint')?.textContent
    ).toBe('optional. leave blank to use the hermes default profile.');
    expect(
      host.querySelector('.agent-profiles-editor__field-error')
    ).toBeNull();
    const hintId = host.querySelector('.agent-profiles-editor__field-hint')?.id;
    expect(hintId).toBeTruthy();
    expect(hermesInput()?.getAttribute('aria-describedby')).toBe(hintId);
    expect(hermesInput()?.getAttribute('aria-label')).toBe('hermes profile');
    await act(async () =>
      setInput(hermesInput() as HTMLInputElement, '../other')
    );
    const errorId = host.querySelector(
      '.agent-profiles-editor__field-error'
    )?.id;
    expect(hermesInput()?.getAttribute('aria-describedby')).toBe(
      `${hintId} ${errorId}`
    );
  });

  it('shows the stored binding and submits it unchanged', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({ hermesProfile: 'koi-product' }),
      onSubmit,
    });
    expect(hermesInput()?.value).toBe('koi-product');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'hermes',
        hermesProfile: 'koi-product',
      })
    );
  });

  it('patches null — never the empty string — when the operator clears the binding', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({ hermesProfile: 'koi-product' }),
      onSubmit,
    });
    await act(async () => setInput(hermesInput() as HTMLInputElement, ''));
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    const input = onSubmit.mock.calls[0]?.[0] as { hermesProfile?: unknown };
    expect(input.hermesProfile).toBeNull();
    expect(input.hermesProfile).not.toBe('');
  });

  it('blocks save on a path-traversing or malformed binding and never submits it', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({ hermesProfile: 'koi-product' }),
      onSubmit,
    });
    const save = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'save profile'
      );
    expect(save()?.disabled).toBe(false);
    for (const invalid of [
      '../other',
      'a/b',
      '..',
      '.',
      'has space',
      '%2e%2e',
      'x'.repeat(65),
    ]) {
      await act(async () =>
        setInput(hermesInput() as HTMLInputElement, invalid)
      );
      expect(save()?.disabled).toBe(true);
      expect(
        host.querySelector('.agent-profiles-editor__field-error')?.textContent
      ).toContain('64');
      expect(hermesInput()?.getAttribute('aria-invalid')).toBe('true');
      await act(async () => {
        (host.querySelector('form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        );
      });
      expect(onSubmit).not.toHaveBeenCalled();
    }
    await act(async () =>
      setInput(hermesInput() as HTMLInputElement, 'ika-frontend')
    );
    expect(save()?.disabled).toBe(false);
    expect(
      host.querySelector('.agent-profiles-editor__field-error')
    ).toBeNull();
    expect(hermesInput()?.getAttribute('aria-invalid')).toBe('false');
  });

  it('drops the binding when the draft leaves the hermes provider', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({ hermesProfile: 'koi-product' }),
      onSubmit,
    });
    await selectFramework(host, 'Codex');
    expect(hermesInput()).toBeNull();
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'codex', hermesProfile: null })
    );
  });

  it('omits the binding entirely from a non-hermes create draft', () => {
    const draft = {
      ...profileDraftFrom(),
      providerId: 'codex',
      displayName: 'review codex',
      hermesProfile: 'koi-product',
    };
    expect(profileSubmitInput(draft)).not.toHaveProperty('hermesProfile');
    expect(withProfileProvider(draft, 'hermes').hermesProfile).toBe('');
  });

  it('accepts a valid binding and rejects segment-escaping values', () => {
    const draft = (value: string) => ({
      ...profileDraftFrom(hermesProfile()),
      hermesProfile: value,
    });
    expect(hermesProfileDraftError(draft(''))).toBeNull();
    expect(hermesProfileDraftError(draft('  '))).toBeNull();
    expect(hermesProfileDraftError(draft('koi-product'))).toBeNull();
    expect(hermesProfileDraftError(draft('a_b.c-1'))).toBeNull();
    for (const invalid of [
      '..',
      '.',
      '../other',
      'a/b',
      'a b',
      'x'.repeat(65),
    ]) {
      expect(hermesProfileDraftError(draft(invalid))).toBeTruthy();
    }
    expect(
      hermesProfileDraftError({
        ...profileDraftFrom(profile()),
        hermesProfile: '../other',
      })
    ).toBeNull();
  });

  it('serializes a trimmed binding and keeps the create path free of empty strings', () => {
    expect(
      profileSubmitInput({
        ...profileDraftFrom(hermesProfile()),
        hermesProfile: '  koi-product  ',
      })
    ).toEqual(expect.objectContaining({ hermesProfile: 'koi-product' }));
    expect(
      profileSubmitInput(profileDraftFrom(hermesProfile()))
    ).not.toHaveProperty('hermesProfile');
    expect(
      profileSubmitInput(profileDraftFrom(hermesProfile()), {
        clearEmpty: true,
      })
    ).toEqual(expect.objectContaining({ hermesProfile: null }));
    // A non-hermes edit sends the field too — as an unconditional `null`, the
    // same shape `model`/`effort` already use. Pinned because it is a new
    // field on every profile write, and `''` here would be a router 400.
    expect(
      profileSubmitInput(profileDraftFrom(profile()), { clearEmpty: true })
    ).toEqual(expect.objectContaining({ hermesProfile: null }));
  });

  // ── per-profile gateway key (#1453) ───────────────────────────────────────

  const keyInput = () =>
    host.querySelector<HTMLInputElement>(
      'input[placeholder="stored"], input[placeholder="gateway default key"]'
    );
  const keyHint = () =>
    host.querySelector(
      '.agent-profiles-editor__secret .agent-profiles-editor__field-hint'
    )?.textContent ?? '';
  const button = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );

  it('renders a masked key field, only for hermes, and never a value', async () => {
    await renderEditor({ profile: profile() });
    expect(keyInput()).toBeNull();

    await renderEditor({ key: 'hermes', profile: hermesProfile() });
    const input = keyInput();
    expect(input).not.toBeNull();
    // The value is write-only: the server never sends it, so the box is empty
    // and the type masks anything typed into it.
    expect(input?.type).toBe('password');
    expect(input?.value).toBe('');
    expect(input?.getAttribute('aria-label')).toBe('hermes api key');
    expect(keyHint()).toContain('not set');

    await renderEditor({
      key: 'hermes-set',
      profile: hermesProfile({ hermesApiKeySet: true }),
    });
    expect(keyInput()?.value).toBe('');
    expect(keyHint()).toContain('set');
    expect(host.innerHTML).not.toContain('hermesApiKey"');
  });

  it('omits the key from a save that did not touch it', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({
        hermesProfile: 'koi-product',
        hermesApiKeySet: true,
      }),
      onSubmit,
    });
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    // An untouched empty box means "keep the stored key" — sending `null` here
    // would silently wipe the credential on every unrelated profile edit.
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('hermesApiKey');
  });

  it('sends a typed key, and sends null when the operator clears it', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({
        hermesProfile: 'koi-product',
        hermesApiKeySet: true,
      }),
      onSubmit,
    });
    await act(async () =>
      setInput(keyInput() as HTMLInputElement, '  koi-only-key  ')
    );
    expect(keyHint()).toContain('replaced on save');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ hermesApiKey: 'koi-only-key' })
    );

    onSubmit.mockClear();
    await renderEditor({
      key: 'clear',
      profile: hermesProfile({
        hermesProfile: 'koi-product',
        hermesApiKeySet: true,
      }),
      onSubmit,
    });
    await act(async () => button('clear')?.click());
    expect(keyHint()).toContain('cleared on save');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ hermesApiKey: null })
    );
  });

  it('undoes a pending clear with keep', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({ hermesApiKeySet: true }),
      onSubmit,
    });
    await act(async () => button('clear')?.click());
    await act(async () => button('keep')?.click());
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('hermesApiKey');
  });

  it('never sends the key field on a provider change; the server owns that clear', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({
        hermesProfile: 'koi-product',
        hermesApiKeySet: true,
      }),
      onSubmit,
    });
    await selectFramework(host, 'Codex');
    expect(keyInput()).toBeNull();
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    // The store clears the secret and the binding whenever the SAVED provider
    // changes. Arming a client-side clear as well would wipe the key on a
    // round trip (hermes -> codex -> hermes) that is not a provider change at
    // all, so the draft must stay quiet about a key it did not touch.
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ providerId: 'codex' })
    );
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('hermesApiKey');
  });

  it('survives a provider round trip without arming a wipe', async () => {
    const onSubmit = vi.fn();
    await renderEditor({
      profile: hermesProfile({
        hermesProfile: 'koi-product',
        hermesApiKeySet: true,
      }),
      onSubmit,
    });
    await selectFramework(host, 'Codex');
    await selectFramework(host, 'Hermes');
    // Still truthfully "set": the key never left the row, and the save the
    // operator is about to make does not change the provider.
    expect(keyHint()).toContain('set');
    expect(keyHint()).not.toContain('not set');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('hermesApiKey');
  });

  it('never offers clear and keep at the same time', async () => {
    await renderEditor({ profile: hermesProfile({ hermesApiKeySet: true }) });
    expect(button('clear')).toBeTruthy();
    expect(button('keep')).toBeUndefined();
    await act(async () => button('clear')?.click());
    expect(button('clear')).toBeUndefined();
    expect(button('keep')).toBeTruthy();
    await act(async () => button('keep')?.click());
    expect(button('clear')).toBeTruthy();
    expect(button('keep')).toBeUndefined();
  });

  it('blocks save on a malformed key and never submits it', async () => {
    const onSubmit = vi.fn();
    await renderEditor({ profile: hermesProfile(), onSubmit });
    const save = () => button('save profile');
    expect(save()?.disabled).toBe(false);
    for (const invalid of ['has space', 'k'.repeat(4097), 'ékey']) {
      await act(async () => setInput(keyInput() as HTMLInputElement, invalid));
      expect(save()?.disabled).toBe(true);
      expect(keyInput()?.getAttribute('aria-invalid')).toBe('true');
      await act(async () => {
        (host.querySelector('form') as HTMLFormElement).dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        );
      });
      expect(onSubmit).not.toHaveBeenCalled();
    }
    await act(async () => setInput(keyInput() as HTMLInputElement, 'good-key'));
    expect(save()?.disabled).toBe(false);
    expect(keyInput()?.getAttribute('aria-invalid')).toBe('false');
  });

  it('reports the stored-key marker, never a value, into the draft', () => {
    expect(
      profileDraftFrom(hermesProfile({ hermesApiKeySet: true }))
    ).toMatchObject({
      hermesApiKey: '',
      hermesApiKeyStored: true,
      hermesApiKeyCleared: false,
    });
    expect(profileDraftFrom(hermesProfile())).toMatchObject({
      hermesApiKeyStored: false,
    });
  });
});

describe('SettingsAgentProfilesSection edit target (#1453)', () => {
  let host: HTMLDivElement;
  let root: Root;
  const bound = profile({
    id: 'agent-profile:hermes:product',
    providerId: 'hermes',
    displayName: 'product owner',
    hermesProfile: 'koi-product',
    model: '',
    effort: '',
  });
  const unbound = profile({
    id: 'agent-profile:claude:reviewer',
    providerId: 'claude',
    displayName: 'reviewer claude',
  });

  beforeEach(() => {
    vi.stubGlobal('matchMedia', matchMedia);
    useConfigStore.setState({ frameworks: hermesFrameworks });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /**
   * The gallery stays mounted while the editor is open, so a second `edit`
   * click retargets the submit handler. If the editor is not remounted per
   * edited row it keeps the first profile's draft, and this PR's binding is
   * what gets written onto — or cleared off — the wrong profile.
   */
  it('re-seeds the editor when a second profile is opened for edit', async () => {
    const writes: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (!init || init.method === undefined || init.method === 'GET') {
          return new Response(JSON.stringify({ profiles: [bound, unbound] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ profile: unbound }), {
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(SettingsAgentProfilesSection, {
            searchQuery: '',
          })
        )
      );
    });
    for (
      let i = 0;
      i < 50 && !host.querySelector('.agent-profiles-card');
      i++
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(host.querySelectorAll('.agent-profiles-card')).toHaveLength(2);
    const editButton = (profileId: string) =>
      host
        .querySelector(`[data-profile-id="${profileId}"]`)
        ?.querySelector<HTMLButtonElement>('button');
    await act(async () => editButton(bound.id)?.click());
    expect(
      host.querySelector<HTMLInputElement>(
        'input[placeholder="hermes default"]'
      )?.value
    ).toBe('koi-product');
    await act(async () => editButton(unbound.id)?.click());
    // The hermes-only field must be gone: the draft now belongs to a claude row.
    expect(
      host.querySelector('input[placeholder="hermes default"]')
    ).toBeNull();
    expect(
      host.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. reviewer codex"]'
      )?.value
    ).toBe('reviewer claude');
    await act(async () => {
      (host.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
    });
    await act(async () => {});
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain(encodeURIComponent(unbound.id));
    expect(writes[0]?.body).toEqual(
      expect.objectContaining({
        providerId: 'claude',
        displayName: 'reviewer claude',
        hermesProfile: null,
      })
    );
  });

  it('starts a duplicate with no gateway key, even from a keyed source (#1453)', async () => {
    const keyed = profile({
      id: 'agent-profile:hermes:keyed',
      providerId: 'hermes',
      displayName: 'keyed hermes',
      hermesProfile: 'koi-product',
      hermesApiKeySet: true,
      model: '',
      effort: '',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ profiles: [keyed] }), {
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(SettingsAgentProfilesSection, {
            searchQuery: '',
          })
        )
      );
    });
    for (
      let i = 0;
      i < 50 && !host.querySelector('.agent-profiles-card');
      i++
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    const cardButtons = Array.from(
      host
        .querySelector(`[data-profile-id="${keyed.id}"]`)
        ?.querySelectorAll<HTMLButtonElement>('button') ?? []
    );
    const hint = () =>
      host.querySelector(
        '.agent-profiles-editor__secret .agent-profiles-editor__field-hint'
      )?.textContent ?? '';

    await act(async () => cardButtons[0]?.click());
    expect(hint()).toContain('set');
    expect(hint()).not.toContain('not set');

    // The secret lives in its own column and is NOT copied server-side, so a
    // duplicate that claimed a key would be lying to the operator.
    await act(async () => cardButtons[1]?.click());
    expect(hint()).toContain('not set');
  });
});

describe('AgentProfileGallery', () => {
  it('groups cards by configured vendor and marks the provider default', () => {
    const profiles = [
      profile({
        id: 'agent-profile:claude:default',
        displayName: '',
        isDefault: true,
        isBuiltIn: true,
      }),
      profile({
        id: 'agent-profile:codex:reviewer',
        providerId: 'codex',
        displayName: 'review codex',
      }),
    ];
    expect(
      groupAgentProfiles(profiles, frameworks).map((group) => group.label)
    ).toEqual(['Claude Code', 'Codex']);
    const html = renderToStaticMarkup(
      React.createElement(AgentProfileGallery, {
        profiles,
        frameworks,
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onSetDefault: vi.fn(),
      })
    );
    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex');
    expect(html).toContain('default');
    expect(html).toContain('built-in default');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>delete<\/button>/);
  });

  it('subtitles a bound hermes card with its gateway profile (#1453)', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentProfileGallery, {
        profiles: [
          profile({
            id: 'agent-profile:hermes:product',
            providerId: 'hermes',
            displayName: 'product owner',
            hermesProfile: 'koi-product',
          }),
          profile({
            id: 'agent-profile:hermes:plain',
            providerId: 'hermes',
            displayName: 'plain hermes',
          }),
        ],
        frameworks: hermesFrameworks,
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onSetDefault: vi.fn(),
      })
    );
    expect(html).toContain('hermes · koi-product');
    expect(html.match(/hermes ·/g)).toHaveLength(1);
  });
});

describe('SearchableSelect keyboard and ARIA', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('opens as a combobox and selects the roved option with ArrowDown and Enter', async () => {
    const onchange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(SearchableSelect, {
          options: frameworks.map(({ id, displayName }) => ({
            value: id,
            label: displayName,
          })),
          placeholder: 'select framework',
          onchange,
        })
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('.ss-trigger');
    await act(async () =>
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    );
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(input?.getAttribute('aria-expanded')).toBe('true');
    expect(input?.getAttribute('aria-controls')).toBeTruthy();
    expect(input?.getAttribute('aria-activedescendant')).toContain('option-0');
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onchange).toHaveBeenCalledWith('claude');
  });
});

describe('deleteAgentProfile', () => {
  it("accepts the router's empty 204 delete response", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      deleteAgentProfile('agent-profile:claude:reviewer')
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/agent-profiles/agent-profile%3Aclaude%3Areviewer',
      { method: 'DELETE' }
    );
    vi.unstubAllGlobals();
  });
});
