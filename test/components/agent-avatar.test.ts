// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  AgentAvatar,
  avatarInitials,
  resolveAvatarTier,
} from '../../frontend/src/components/chat/AgentAvatar.js';
import type { SenderIdentity } from '../../frontend/src/lib/chat/sender-identity.js';
import { resolveSenderIdentity } from '../../frontend/src/lib/chat/sender-identity.js';
import { deriveColor } from '../../frontend/src/lib/colors.js';
import { builtInAgentProfileId } from '../../shared/agent-profile.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function agentIdentity(over: Partial<SenderIdentity> = {}): SenderIdentity {
  return {
    label: 'Backend Claude',
    colorVar: 'var(--sender-claude)',
    glyph: 'claude',
    kind: 'agent',
    ...over,
  };
}

describe('avatarInitials', () => {
  it('takes the first letter of the first two words for multi-word names', () => {
    expect(avatarInitials('Backend Claude')).toBe('BC');
    expect(avatarInitials('Reviewer Claude')).toBe('RC');
    expect(avatarInitials('acme review bot')).toBe('AR');
  });

  it('takes the first two alphanumerics for a single token', () => {
    expect(avatarInitials('claude')).toBe('CL');
    expect(avatarInitials('codex')).toBe('CO');
    expect(avatarInitials('hermes')).toBe('HE');
  });

  it('splits on separators and ignores punctuation', () => {
    expect(avatarInitials('backend.claude')).toBe('BC');
    expect(avatarInitials('  spaced   name ')).toBe('SN');
  });

  it('returns empty for a label with no letters or digits', () => {
    expect(avatarInitials('')).toBe('');
    expect(avatarInitials('   ')).toBe('');
    expect(avatarInitials('@#!')).toBe('');
  });
});

describe('resolveAvatarTier', () => {
  it('prefers image, then initials, then glyph', () => {
    expect(resolveAvatarTier({ imageUrl: 'blob:x', initials: 'BC' })).toBe(
      'image'
    );
    expect(resolveAvatarTier({ imageUrl: null, initials: 'BC' })).toBe(
      'initials'
    );
    expect(resolveAvatarTier({ imageUrl: null, initials: '' })).toBe('glyph');
  });
});

describe('AgentAvatar rendering', () => {
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

  function render(
    props: React.ComponentProps<typeof AgentAvatar>
  ): HTMLElement {
    act(() => {
      root.render(React.createElement(AgentAvatar, props));
    });
    return container.querySelector('.agent-avatar') as HTMLElement;
  }

  it('tier a — renders the uploaded image blob when an imageUrl is present', () => {
    const el = render({
      identity: agentIdentity(),
      name: 'Backend Claude',
      imageUrl: 'blob:avatar-1',
    });
    expect(el.getAttribute('data-tier')).toBe('image');
    const img = el.querySelector('img.agent-avatar__image') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:avatar-1');
    // no initials / glyph rendered in the image tier
    expect(el.querySelector('.agent-avatar__initials')).toBeNull();
    expect(el.querySelector('.agent-avatar__glyph')).toBeNull();
  });

  it('tier b — renders initials on the identity color when no image is present', () => {
    const el = render({ identity: agentIdentity(), name: 'Backend Claude' });
    expect(el.getAttribute('data-tier')).toBe('initials');
    const initials = el.querySelector('.agent-avatar__initials') as HTMLElement;
    expect(initials.textContent).toBe('BC');
  });

  it('tier c — falls back to the reused vendor glyph when there is no label', () => {
    const el = render({
      identity: agentIdentity({ label: '' }),
      name: '',
    });
    expect(el.getAttribute('data-tier')).toBe('glyph');
    // AgentBadge is reused for the glyph tier (Claude vendor mark).
    const svg = el.querySelector('svg[aria-label="Claude"]');
    expect(svg).not.toBeNull();
    expect(el.querySelector('.agent-avatar__initials')).toBeNull();
  });

  it('initials are distinct per profile by construction (two same-vendor profiles)', () => {
    const a = render({ identity: agentIdentity(), name: 'Backend Claude' });
    const aInitials = a.querySelector('.agent-avatar__initials')?.textContent;
    act(() => root.unmount());
    root = createRoot(container);
    const b = render({ identity: agentIdentity(), name: 'Reviewer Claude' });
    const bInitials = b.querySelector('.agent-avatar__initials')?.textContent;
    expect(aInitials).toBe('BC');
    expect(bInitials).toBe('RC');
    expect(aInitials).not.toBe(bInitials);
  });

  it('sources color from the identity — a DEFAULT profile keeps its vendor token', () => {
    // Exactly what a message row / DM row passes: the resolved identity.
    const identity = resolveSenderIdentity({
      kind: 'agent',
      id: builtInAgentProfileId('claude'),
      providerId: 'claude',
    });
    expect(identity.colorVar).toBe('var(--sender-claude)');
    const el = render({ identity, name: identity.label });
    const initials = el.querySelector('.agent-avatar__initials') as HTMLElement;
    // The initials-fill is the vendor token — the avatar does NOT override
    // @claude's established sender color with a hash.
    expect(initials.style.background).toBe('var(--sender-claude)');
    expect(initials.textContent).toBe('CL');
  });

  it('a NON-default profile hashes its color via deriveColor over the palette', () => {
    const profileId = 'agent-profile:claude:reviewer-9';
    const identity = resolveSenderIdentity({
      kind: 'agent',
      id: profileId,
      providerId: 'claude',
      displayName: 'Reviewer Claude',
    });
    expect(identity.colorVar).toBe(deriveColor(profileId));
    const el = render({ identity, name: identity.label });
    const initials = el.querySelector('.agent-avatar__initials') as HTMLElement;
    expect(initials.style.background).toBe(deriveColor(profileId));
  });

  it('applies the 2px badge radius at ≤24px and zero radius above (DESIGN.md)', () => {
    const small = render({ identity: agentIdentity(), name: 'X', size: 24 });
    expect(small.style.borderRadius).toBe('2px');
    act(() => root.unmount());
    root = createRoot(container);
    const large = render({ identity: agentIdentity(), name: 'X', size: 32 });
    expect(large.style.borderRadius).toBe('0px');
  });

  it('renders a presence status dot only when presence is set', () => {
    const withDot = render({
      identity: agentIdentity(),
      name: 'Backend Claude',
      presence: 'online',
    });
    const dot = withDot.querySelector('.agent-avatar__presence');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('agent-avatar__presence--online');
    act(() => root.unmount());
    root = createRoot(container);
    const noDot = render({ identity: agentIdentity(), name: 'Backend Claude' });
    expect(noDot.querySelector('.agent-avatar__presence')).toBeNull();
  });

  it('exposes an accessible image role + label and hides inner chrome', () => {
    const el = render({
      identity: agentIdentity(),
      name: 'Backend Claude',
      title: 'Backend Claude',
    });
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Backend Claude');
    expect(
      el.querySelector('.agent-avatar__initials')?.getAttribute('aria-hidden')
    ).toBe('true');
  });
});
