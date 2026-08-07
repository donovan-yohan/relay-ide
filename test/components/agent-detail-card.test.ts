// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentDetailCardV2 } from '../../shared/agent-chat-protocol-v2.js';

const shikiMocks = vi.hoisted(() => ({
  useShikiHighlight: vi.fn(() => ({ tokens: null, highlighting: false })),
}));

vi.mock('../../frontend/src/hooks/useShikiHighlight.js', () => ({
  useShikiHighlight: shikiMocks.useShikiHighlight,
}));

const {
  AgentDetailCard,
  AGENT_DETAIL_RENDER_MAX_CHARS,
  AGENT_DETAIL_RENDER_MAX_LINES,
} = await import('../../frontend/src/components/chat/AgentDetailCard.js');
const { REASONING_STATUS_CLASS } =
  await import('../../frontend/src/components/chat/ReasoningDetail.js');
const { useReasoningDetailSettingsStore } =
  await import('../../frontend/src/lib/stores/reasoning-detail-settings.js');
const { resetFallbackReasoningDetailStateForTests } =
  await import('../../frontend/src/components/chat/ReasoningDetailState.js');

let host: HTMLDivElement;
let root: Root;

async function render(card: AgentDetailCardV2): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(AgentDetailCard, { card, itemId: 'durable-item-1' })
    );
  });
}

async function toggle(): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(
    '.ch-agent-card__toggle'
  );
  expect(button).toBeTruthy();
  await act(async () => button?.click());
}

describe('AgentDetailCard', () => {
  beforeEach(() => {
    shikiMocks.useShikiHighlight.mockClear();
    useReasoningDetailSettingsStore.getState().reset();
    resetFallbackReasoningDetailStateForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('maps every reasoning status to its explicit class', () => {
    const expected = {
      pending: 'ch-agent-card__status--pending',
      running: 'ch-agent-card__status--running',
      'reasoning…': 'ch-agent-card__status--running',
      completed: 'ch-agent-card__status--completed',
      failed: 'ch-agent-card__status--failed',
      cancelled: 'ch-agent-card__status--cancelled',
      interrupted: 'ch-agent-card__status--cancelled',
      truncated: 'ch-agent-card__status--cancelled',
    } satisfies typeof REASONING_STATUS_CLASS;

    expect(REASONING_STATUS_CLASS).toEqual(expected);
  });

  it('renders pending reasoning with the pending class', async () => {
    await render({
      kind: 'thought',
      title: 'queued reasoning',
      status: 'pending',
      content: 'waiting for provider execution',
    });

    expect(host.querySelector('.ch-agent-card__status')?.textContent).toBe(
      'pending'
    );
    expect(
      host
        .querySelector('.ch-agent-card__status')
        ?.classList.contains('ch-agent-card__status--pending')
    ).toBe(true);
  });

  it('keeps a 500-line output collapsed until its summary is toggled', async () => {
    const content = Array.from(
      { length: 500 },
      (_, index) => `line ${index}`
    ).join('\n');
    await render({
      kind: 'output',
      title: 'npm test -- --runInBand',
      status: 'completed',
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength,
    });

    const button = host.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.ch-agent-card__body')).toBeNull();
    expect(button?.textContent).toContain('npm test -- --runInBand');
    expect(button?.textContent).toContain('500 lines');
    expect(button?.textContent).toContain('completed');

    await toggle();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
      'line 499'
    );

    await toggle();
    expect(host.querySelector('.ch-agent-card__body')).toBeNull();
  });

  it('expands thought content and keeps the toggle functional', async () => {
    await render({
      kind: 'thought',
      title: 'inspect the reducer path',
      status: 'running',
      content: 'The snapshot may replace the current item.',
    });

    expect(host.querySelector('.ch-agent-card__body')).toBeNull();
    expect(host.querySelector('.ch-agent-card__chevron')).not.toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('.ch-agent-card__toggle')?.disabled
    ).toBe(false);
    await toggle();
    expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
      'The snapshot may replace the current item.'
    );
  });

  it('uses the persisted expanded default for each new reasoning block', async () => {
    useReasoningDetailSettingsStore.getState().setDefaultState('expanded');
    await render({
      kind: 'thought',
      title: 'provider title is not presented as prose',
      status: 'running',
      content: 'first retained fragment',
    });

    const toggle = host.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe(
      'Collapse Reasoning summary (reasoning…)'
    );
    expect(host.textContent).toContain('Reasoning summary');
    expect(host.textContent).not.toContain(
      'provider title is not presented as prose'
    );
    expect(host.textContent).toContain('first retained fragment');
  });

  it('keeps a manual override stable while settings and streaming content change', async () => {
    useReasoningDetailSettingsStore.getState().setDefaultState('expanded');
    await render({
      kind: 'thought',
      title: 'thinking',
      status: 'running',
      content: 'first fragment',
    });

    // Two manual toggles leave the block expanded but mark its presentation as
    // user-controlled. A later opposite default must affect only new blocks.
    await toggle();
    await toggle();
    useReasoningDetailSettingsStore.getState().setDefaultState('collapsed');
    await render({
      kind: 'thought',
      title: 'thinking',
      status: 'running',
      content: 'first fragment plus streamed delta',
    });

    expect(
      host
        .querySelector('.ch-agent-card__toggle')
        ?.getAttribute('aria-expanded')
    ).toBe('true');
    expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
      'first fragment plus streamed delta'
    );

    await act(async () => {
      root.render(
        React.createElement(AgentDetailCard, {
          card: {
            kind: 'thought',
            title: 'thinking',
            status: 'running',
            content: 'a newly created block',
          },
          itemId: 'durable-item-2',
        })
      );
    });
    expect(
      host
        .querySelector('.ch-agent-card__toggle')
        ?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it.each(['interrupted', 'failed', 'truncated'] as const)(
    'shows the truthful %s terminal state while expanded',
    async (reasoningTerminalState) => {
      useReasoningDetailSettingsStore.getState().setDefaultState('expanded');
      await act(async () => {
        root.render(
          React.createElement(AgentDetailCard, {
            card: {
              kind: 'thought',
              title: 'thinking',
              status:
                reasoningTerminalState === 'failed' ? 'failed' : 'cancelled',
              content: 'retained provider-visible summary',
            },
            itemId: `terminal-${reasoningTerminalState}`,
            reasoningTerminalState,
          })
        );
      });

      expect(host.querySelector('.ch-agent-card__status')?.textContent).toBe(
        reasoningTerminalState
      );
      expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
        'retained provider-visible summary'
      );
    }
  );

  it('removes an empty terminal reasoning detail', async () => {
    await render({
      kind: 'thought',
      title: 'thinking',
      status: 'completed',
    });

    expect(host.querySelector('.ch-agent-card')).toBeNull();
    expect(host.querySelector('.ch-agent-card__chevron')).toBeNull();
  });

  it('tints only added and removed diff lines and reports their counts', async () => {
    await render({
      kind: 'diff',
      title: 'frontend/src/App.tsx',
      path: 'frontend/src/App.tsx',
      status: 'completed',
      content: '--- a/App.tsx\n+++ b/App.tsx\n-old\n+new\n context',
      additions: 1,
      deletions: 1,
    });

    expect(host.querySelector('.ch-agent-card__toggle')?.textContent).toContain(
      '+1 -1'
    );
    await toggle();

    const added = host.querySelectorAll('.ch-agent-card__line--added');
    const removed = host.querySelectorAll('.ch-agent-card__line--removed');
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(added[0]?.textContent).toContain('+new');
    expect(removed[0]?.textContent).toContain('-old');
  });

  it('updates one expanded durable card in place as status and content change', async () => {
    await render({
      kind: 'tool_call',
      title: 'search files',
      status: 'running',
      content: 'first result',
    });
    await toggle();

    await render({
      kind: 'tool_call',
      title: 'search files',
      status: 'completed',
      content: 'final result',
    });

    expect(host.querySelectorAll('.ch-agent-card')).toHaveLength(1);
    expect(
      host
        .querySelector('.ch-agent-card__toggle')
        ?.getAttribute('aria-expanded')
    ).toBe('true');
    expect(host.querySelector('.ch-agent-card__body')?.textContent).toContain(
      'final result'
    );
    expect(host.textContent).not.toContain('first result');
  });

  it('bounds large streaming output and skips Shiki until completion', async () => {
    const content = Array.from(
      { length: AGENT_DETAIL_RENDER_MAX_LINES + 250 },
      (_, index) => `${index}:${'x'.repeat(80)}`
    ).join('\n');
    expect(content.length).toBeGreaterThan(AGENT_DETAIL_RENDER_MAX_CHARS);
    await render({
      kind: 'output',
      title: 'npm run build',
      status: 'running',
      content,
      language: 'bash',
      sizeBytes: content.length,
    });

    await toggle();

    expect(
      host.querySelectorAll('.ch-agent-card__line').length
    ).toBeLessThanOrEqual(AGENT_DETAIL_RENDER_MAX_LINES);
    expect(host.querySelector('.ch-agent-card__truncated')?.textContent).toBe(
      'showing latest bounded output'
    );
    expect(host.textContent).toContain(
      `${AGENT_DETAIL_RENDER_MAX_LINES + 249}:`
    );
    expect(shikiMocks.useShikiHighlight).toHaveBeenLastCalledWith(
      'agent-detail:durable-item-1:bash',
      '',
      'bash'
    );
  });

  it('labels fallback content length as characters, not bytes', async () => {
    await render({
      kind: 'output',
      title: 'unicode output',
      status: 'running',
      content: '✓',
    });

    expect(host.querySelector('.ch-agent-card__size')?.textContent).toBe(
      '1 char'
    );
  });
});
