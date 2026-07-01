// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentCompactionItemV2,
  AgentHookPromptItemV2,
  AgentPlanItemV2,
  AgentQuestionItemV2,
} from '../../shared/agent-chat-protocol-v2.js';

const { QuestionCard } =
  await import('../../frontend/src/components/chat/QuestionCard.js');
const { PlanCard } =
  await import('../../frontend/src/components/chat/PlanCard.js');
const { CompactionCard, HookPromptCard } =
  await import('../../frontend/src/components/chat/MediaCard.js');

function timestamp(): string {
  return new Date(Date.UTC(2026, 3, 28, 12, 0, 0)).toISOString();
}

function makeQuestionItem(
  overrides: Partial<AgentQuestionItemV2> = {}
): AgentQuestionItemV2 {
  return {
    id: 'question-test',
    type: 'question',
    requestId: 'input-1',
    question: 'Which approach should I take?',
    fields: [
      {
        id: 'approach',
        prompt: 'Pick an approach',
        options: ['refactor', 'rewrite'],
        isOther: true,
      },
    ],
    status: 'pending',
    startedAt: timestamp(),
    ...overrides,
  };
}

describe('QuestionCard rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAnswer = vi.fn<[string, Record<string, string[]>], void>();

  beforeEach(() => {
    onAnswer.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(item: AgentQuestionItemV2) {
    await act(async () => {
      root.render(React.createElement(QuestionCard, { item, onAnswer }));
    });
  }

  function optionButton(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === text
    );
  }

  it('renders per-field option buttons instead of raw text', async () => {
    await render(makeQuestionItem());

    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('Which approach should I take?');
    expect(container.textContent).toContain('Pick an approach');
    expect(optionButton('refactor')).toBeTruthy();
    expect(optionButton('rewrite')).toBeTruthy();
  });

  it('renders a free-text "other" input when isOther is set', async () => {
    await render(makeQuestionItem());

    const otherInput =
      container.querySelector<HTMLInputElement>('.qcard__other');
    expect(otherInput).toBeTruthy();
  });

  it('submits per-field answers through onAnswer when an option is selected', async () => {
    await render(makeQuestionItem());

    await act(async () => {
      optionButton('refactor')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });

    const submit = optionButton('submit');
    expect(submit?.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onAnswer).toHaveBeenCalledWith('input-1', {
      approach: ['refactor'],
    });
  });

  it('disables submit until every field has a selection', async () => {
    await render(
      makeQuestionItem({
        fields: [
          { id: 'a', prompt: 'field a', options: ['x', 'y'] },
          { id: 'b', prompt: 'field b', options: ['1', '2'] },
        ],
      })
    );

    expect(optionButton('submit')?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      optionButton('x')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });
    expect(optionButton('submit')?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      optionButton('1')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });
    expect(optionButton('submit')?.hasAttribute('disabled')).toBe(false);
  });

  it('accepts a free-text answer with no preset options', async () => {
    await render(
      makeQuestionItem({
        fields: [{ id: 'freeform', prompt: 'anything else?' }],
      })
    );

    const input = container.querySelector<HTMLInputElement>('.qcard__other');
    expect(input).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(input, 'ship it as-is');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      optionButton('submit')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });

    expect(onAnswer).toHaveBeenCalledWith('input-1', {
      freeform: ['ship it as-is'],
    });
  });

  it('renders a read-only answered state with chosen values and no submit button', async () => {
    await render(
      makeQuestionItem({
        status: 'completed',
        answers: { approach: ['rewrite'] },
      })
    );

    expect(container.textContent).toContain('answered');
    expect(container.textContent).toContain('rewrite');
    expect(optionButton('submit')).toBeUndefined();
    expect(container.querySelectorAll('.qcard__opt').length).toBe(0);
  });

  it('preserves field prompts in the answered view even when the completion patch drops fields', async () => {
    // Mirrors the real codex-native-adapter behavior: the agent-item-updated-v2
    // completion patch only carries {type, id, requestId, question, answers,
    // status, completedAt} — no `fields`. The component must cache the last
    // seen fields (by item id) to keep the read-only view legible.
    await render(makeQuestionItem());

    await render(
      makeQuestionItem({
        fields: undefined,
        status: 'completed',
        answers: { approach: ['rewrite'] },
        completedAt: timestamp(),
      })
    );

    expect(container.textContent).toContain('Pick an approach');
    expect(container.textContent).toContain('rewrite');
  });

  it('falls back to raw answers when a fields-less completed item is mounted fresh (reload/reconnect)', async () => {
    // Simulates a reload/second-client scenario: no prior render exists to
    // seed the fields cache, so the ref is empty on first mount. The
    // completed item never carries `fields` (mirrors the real codex
    // completion patch), only `answers`. The read-only summary must still
    // surface the answers instead of rendering nothing.
    const freshContainer = document.createElement('div');
    document.body.appendChild(freshContainer);
    const freshRoot = createRoot(freshContainer);

    try {
      await act(async () => {
        freshRoot.render(
          React.createElement(QuestionCard, {
            item: makeQuestionItem({
              fields: undefined,
              status: 'completed',
              answers: { approach: ['rewrite'] },
              completedAt: timestamp(),
            }),
            onAnswer,
          })
        );
      });

      expect(freshContainer.textContent).toContain('answered');
      expect(freshContainer.textContent).toContain('rewrite');
    } finally {
      act(() => freshRoot.unmount());
      freshContainer.remove();
    }
  });
});

function makePlanItem(
  overrides: Partial<AgentPlanItemV2> = {}
): AgentPlanItemV2 {
  return {
    id: 'plan-test',
    type: 'plan',
    text: 'fallback plan text',
    status: 'running',
    startedAt: timestamp(),
    ...overrides,
  };
}

describe('PlanCard rendering', () => {
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

  async function render(item: AgentPlanItemV2) {
    await act(async () => {
      root.render(React.createElement(PlanCard, { item }));
    });
  }

  it('renders a checklist with a status glyph per step', async () => {
    await render(
      makePlanItem({
        steps: [
          { step: 'read the file', status: 'completed' },
          { step: 'apply the patch', status: 'inProgress' },
          { step: 'run the tests', status: 'pending' },
        ],
      })
    );

    expect(container.querySelector('pre')).toBeNull();
    const steps = Array.from(container.querySelectorAll('.pcard__step'));
    expect(steps).toHaveLength(3);
    expect(steps[0]?.textContent).toContain('[x]');
    expect(steps[0]?.textContent).toContain('read the file');
    expect(steps[1]?.textContent).toContain('[~]');
    expect(steps[2]?.textContent).toContain('[ ]');
  });

  it('shows an approval-state badge when present', async () => {
    await render(
      makePlanItem({
        steps: [{ step: 'do the thing', status: 'pending' }],
        approvalState: 'approved',
      })
    );

    expect(container.textContent).toContain('approved');
  });

  it('falls back to item.text when steps[] is empty', async () => {
    await render(makePlanItem({ steps: [] }));

    expect(container.querySelector('.pcard__steps')).toBeNull();
    expect(container.textContent).toContain('fallback plan text');
  });
});

describe('CompactionCard rendering', () => {
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

  function makeCompactionItem(
    overrides: Partial<AgentCompactionItemV2> = {}
  ): AgentCompactionItemV2 {
    return {
      id: 'compaction-test',
      type: 'compaction',
      summary: 'condensed the last 40 turns',
      status: 'completed',
      startedAt: timestamp(),
      ...overrides,
    };
  }

  it('renders the summary and no raw <pre>', async () => {
    await act(async () => {
      root.render(
        React.createElement(CompactionCard, { item: makeCompactionItem() })
      );
    });

    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('condensed the last 40 turns');
  });

  it('shows tokensBefore -> tokensAfter when present', async () => {
    await act(async () => {
      root.render(
        React.createElement(CompactionCard, {
          item: makeCompactionItem({ tokensBefore: 42000, tokensAfter: 1200 }),
        })
      );
    });

    expect(container.textContent).toContain('42000');
    expect(container.textContent).toContain('1200');
  });
});

describe('HookPromptCard rendering', () => {
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

  function makeHookPromptItem(
    overrides: Partial<AgentHookPromptItemV2> = {}
  ): AgentHookPromptItemV2 {
    return {
      id: 'hookprompt-test',
      type: 'hookPrompt',
      prompt: 'pre-commit hook wants confirmation',
      status: 'completed',
      startedAt: timestamp(),
      ...overrides,
    };
  }

  it('renders the prompt and source label, no raw <pre>', async () => {
    await act(async () => {
      root.render(
        React.createElement(HookPromptCard, {
          item: makeHookPromptItem({ source: 'pre-commit' }),
        })
      );
    });

    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain(
      'pre-commit hook wants confirmation'
    );
    expect(container.textContent).toContain('pre-commit');
  });
});
