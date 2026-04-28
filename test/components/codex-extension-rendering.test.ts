// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentProviderExtensionItemV2 } from '../../shared/agent-chat-protocol-v2.js';

// Import registry (side-effects: registers claude + codex renderers)
const { renderProviderExtension } = await import(
  '../../frontend/src/components/chat/extensions/registry.js'
);

function makeItem(
  kind: string | undefined,
  extra: Record<string, unknown> = {}
): AgentProviderExtensionItemV2 {
  return {
    id: `ext-${kind ?? 'unknown'}`,
    type: 'providerExtension',
    namespace: 'codex',
    payload: kind !== undefined ? { kind, ...extra } : { ...extra },
    status: 'completed',
  };
}

describe('codex provider-extension renderers', () => {
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

  async function renderItem(item: AgentProviderExtensionItemV2): Promise<void> {
    await act(async () => {
      root.render(renderProviderExtension(item) as React.ReactElement);
    });
  }

  it('renders EnteredReviewModeCard for kind=enteredReviewMode', async () => {
    const item = makeItem('enteredReviewMode', { review: 'security-audit' });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-enteredReviewMode')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.enteredReviewMode');
    expect(container.textContent).toContain('security-audit');
    expect(container.textContent).toContain('review mode active');
  });

  it('renders ExitedReviewModeCard for kind=exitedReviewMode', async () => {
    const item = makeItem('exitedReviewMode', {
      review: 'Review complete. All checks passed.',
    });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-exitedReviewMode')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.exitedReviewMode');
    expect(container.textContent).toContain('Review complete. All checks passed.');
  });

  it('renders ContextCompactionCard for kind=contextCompaction', async () => {
    const item = makeItem('contextCompaction', {
      summary: 'Removed 20k tokens of redundant context.',
    });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-contextCompaction')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.contextCompaction');
    expect(container.textContent).toContain('context compacted');
    expect(container.textContent).toContain(
      'Removed 20k tokens of redundant context.'
    );
  });

  it('renders ContextCompactionCard without summary field', async () => {
    const item = makeItem('contextCompaction');
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-contextCompaction')
    ).toBeTruthy();
    expect(container.textContent).toContain('context compacted');
  });

  it('renders TurnDiffCard for kind=turnDiff', async () => {
    const item = makeItem('turnDiff', {
      threadId: 'thread-abc',
      turnId: 'turn-1',
      diff: '@@ -1 +1 @@\n-old line\n+new line',
    });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-turnDiff')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.turnDiff');
    expect(container.textContent).toContain('thread-abc');
    expect(container.textContent).toContain('@@ -1 +1 @@');
  });

  it('renders ModelReroutedCard for kind=modelRerouted', async () => {
    const item = makeItem('modelRerouted', {
      threadId: 'thread-abc',
      turnId: 'turn-2',
      fromModel: 'o3-mini',
      toModel: 'o3',
      reason: 'rate limit reached',
    });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-modelRerouted')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.modelRerouted');
    expect(container.textContent).toContain('o3-mini');
    expect(container.textContent).toContain('o3');
    expect(container.textContent).toContain('rate limit reached');
  });

  it('renders ModelVerificationCard for kind=modelVerification with string entries', async () => {
    const item = makeItem('modelVerification', {
      threadId: 'thread-abc',
      turnId: 'turn-3',
      verifications: ['assertion 1 passed', 'assertion 2 passed'],
    });
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-modelVerification')
    ).toBeTruthy();
    expect(container.textContent).toContain('codex.modelVerification');
    expect(container.textContent).toContain('assertion 1 passed');
    expect(container.textContent).toContain('assertion 2 passed');
  });

  it('renders ModelVerificationCard with object entries using message field', async () => {
    const item = makeItem('modelVerification', {
      verifications: [{ message: 'check passed', status: 'ok' }],
    });
    await renderItem(item);

    expect(container.textContent).toContain('check passed');
  });

  it('renders nothing for unknown codex kind (null passthrough)', async () => {
    const item = makeItem('unknownFutureKind');
    await renderItem(item);

    // codex renderer returns null for unknown kinds → React renders nothing
    // (the namespace IS registered, so renderFallback is not invoked)
    expect(container.querySelector('.provider-extension--codex')).toBeNull();
    expect(container.children.length).toBe(0);
  });

  it('resolves via payload.subtype when payload.kind is absent', async () => {
    // kind field absent, subtype present — uses subtype for dispatch
    const item: AgentProviderExtensionItemV2 = {
      id: 'ext-subtype',
      type: 'providerExtension',
      namespace: 'codex',
      payload: { subtype: 'enteredReviewMode', review: 'via-subtype' },
      status: 'completed',
    };
    await renderItem(item);

    expect(
      container.querySelector('.provider-extension--codex-enteredReviewMode')
    ).toBeTruthy();
    expect(container.textContent).toContain('via-subtype');
  });
});
