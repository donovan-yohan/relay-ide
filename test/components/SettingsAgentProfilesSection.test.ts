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
  profileDraftFrom,
  profileSubmitInput,
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
