// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentProfile } from '../../shared/agent-profile.js';
import { deleteAgentProfile } from '../../frontend/src/lib/api.js';
import type { FrameworkInfo } from '../../frontend/src/lib/types.js';
import { SearchableSelect } from '../../frontend/src/components/SearchableSelect.js';
import {
  AgentProfileEditor,
  AgentProfileGallery,
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
    host.querySelector<HTMLInputElement>(
      'input[placeholder="gateway default"]'
    );

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
