// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentApprovalDecisionV2,
  AgentApprovalItemV2,
} from '../../shared/agent-chat-protocol-v2.js';

const { ApprovalCard } =
  await import('../../frontend/src/components/chat/ApprovalCard.js');

function timestamp(): string {
  return new Date(Date.UTC(2026, 3, 28, 12, 0, 0)).toISOString();
}

function makeApprovalItem(
  overrides: Partial<AgentApprovalItemV2> = {}
): AgentApprovalItemV2 {
  return {
    id: 'approval-test',
    type: 'approval',
    requestId: 'req-1',
    kind: 'permission',
    description: 'Claude wants to use Bash',
    target: 'npm test',
    status: 'pending',
    startedAt: timestamp(),
    ...overrides,
  };
}

describe('ApprovalCard rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onApprove = vi.fn<[string, AgentApprovalDecisionV2], void>();

  beforeEach(() => {
    onApprove.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(item: AgentApprovalItemV2) {
    await act(async () => {
      root.render(
        React.createElement(ApprovalCard, {
          item,
          onApprove,
        })
      );
    });
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === text
    );
    expect(button, `button "${text}"`).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function buttonTexts(): string[] {
    return Array.from(container.querySelectorAll('button')).map(
      (b) => b.textContent ?? ''
    );
  }

  it('Claude-shape supported (binary) renders only allow + allow always + deny', async () => {
    await render(
      makeApprovalItem({
        supported: { scopes: ['once', 'permanent'], amendmentTypes: [], canCancel: false },
      })
    );

    const texts = buttonTexts();
    expect(texts).toContain('allow');
    expect(texts).toContain('allow always');
    expect(texts).toContain('deny');
    expect(texts).not.toContain('allow for session');
    expect(texts).not.toContain('allow for turn');
    expect(texts).not.toContain('cancel');
  });

  it('Claude accept/once decision payload on allow click', async () => {
    await render(
      makeApprovalItem({
        supported: { scopes: ['once', 'permanent'], amendmentTypes: [], canCancel: false },
      })
    );

    await clickButton('allow');
    expect(onApprove).toHaveBeenCalledWith('req-1', { kind: 'accept', scope: 'once' });
  });

  it('Claude accept/permanent decision payload on allow always click', async () => {
    await render(
      makeApprovalItem({
        supported: { scopes: ['once', 'permanent'], amendmentTypes: [], canCancel: false },
      })
    );

    await clickButton('allow always');
    expect(onApprove).toHaveBeenCalledWith('req-1', { kind: 'accept', scope: 'permanent' });
  });

  it('Decline decision payload on deny click', async () => {
    await render(
      makeApprovalItem({
        supported: { scopes: ['once', 'permanent'], amendmentTypes: [], canCancel: false },
      })
    );

    await clickButton('deny');
    expect(onApprove).toHaveBeenCalledWith('req-1', { kind: 'decline' });
  });

  it('Codex command-shape supported renders accept + scope chips + amendment buttons + deny + cancel', async () => {
    await render(
      makeApprovalItem({
        kind: 'command',
        supported: {
          scopes: ['once', 'session', 'turn', 'permanent'],
          amendmentTypes: ['execpolicy', 'networkPolicy'],
          canCancel: true,
        },
        details: {
          kind: 'command',
          command: 'npm test',
          cwd: '/tmp/repo',
        },
      })
    );

    const texts = buttonTexts();
    expect(texts).toContain('allow');
    expect(texts).toContain('allow for session');
    expect(texts).toContain('allow for turn');
    expect(texts).toContain('allow always');
    expect(texts).toContain('allow with exec policy');
    expect(texts).toContain('allow with network policy');
    expect(texts).toContain('deny');
    expect(texts).toContain('cancel');
  });

  it('Codex command-shape decision payload on allow for session click', async () => {
    await render(
      makeApprovalItem({
        kind: 'command',
        supported: {
          scopes: ['once', 'session'],
          amendmentTypes: [],
          canCancel: true,
        },
      })
    );

    await clickButton('allow for session');
    expect(onApprove).toHaveBeenCalledWith('req-1', { kind: 'accept', scope: 'session' });
  });

  it('Codex command-shape decision payload on cancel click', async () => {
    await render(
      makeApprovalItem({
        kind: 'command',
        supported: {
          scopes: ['once'],
          amendmentTypes: [],
          canCancel: true,
        },
      })
    );

    await clickButton('cancel');
    expect(onApprove).toHaveBeenCalledWith('req-1', { kind: 'cancel' });
  });

  it('Codex file-shape supported (no amendments) renders accept + scope chips + deny + cancel', async () => {
    await render(
      makeApprovalItem({
        kind: 'patch',
        supported: {
          scopes: ['once', 'session'],
          amendmentTypes: [],
          canCancel: true,
        },
        details: {
          kind: 'patch',
          diff: '@@ -1,1 +1,1 @@\n-old\n+new',
        },
      })
    );

    const texts = buttonTexts();
    expect(texts).toContain('allow');
    expect(texts).toContain('allow for session');
    expect(texts).toContain('deny');
    expect(texts).toContain('cancel');
    expect(texts).not.toContain('allow with exec policy');
    expect(texts).not.toContain('allow always');
  });

  it('renders responded state with decision label when item already has a decision', async () => {
    await render(
      makeApprovalItem({
        status: 'completed',
        decision: { kind: 'accept', scope: 'once' },
        respondedBy: 'user',
        supported: { scopes: ['once', 'permanent'], amendmentTypes: [], canCancel: false },
      })
    );

    // No buttons — shows responded label
    expect(buttonTexts()).toHaveLength(0);
    expect(container.textContent).toContain('allowed');
  });

  it('renders command details body for command kind', async () => {
    await render(
      makeApprovalItem({
        kind: 'command',
        details: {
          kind: 'command',
          command: 'npm run build',
          cwd: '/workspace',
        },
      })
    );

    expect(container.textContent).toContain('npm run build');
    expect(container.textContent).toContain('cwd: /workspace');
  });

  it('renders diff body for patch kind', async () => {
    await render(
      makeApprovalItem({
        kind: 'patch',
        details: {
          kind: 'patch',
          diff: '@@ -1,1 +1,1 @@\n-old\n+new',
          changes: [{ path: 'src/index.ts', kind: 'modified' }],
        },
      })
    );

    expect(container.textContent).toContain('src/index.ts');
    expect(container.textContent).toContain('modified');
  });

  it('renders permissions list for permissionsGrant kind', async () => {
    await render(
      makeApprovalItem({
        kind: 'permissionsGrant',
        details: {
          kind: 'permissionsGrant',
          permissions: ['read:files', 'write:files'],
        },
      })
    );

    expect(container.textContent).toContain('read:files');
    expect(container.textContent).toContain('write:files');
  });

  it('renders elicitation details for elicitation kind', async () => {
    await render(
      makeApprovalItem({
        kind: 'elicitation',
        details: {
          kind: 'elicitation',
          serverName: 'my-mcp-server',
          mode: 'prompt',
          message: 'Please confirm this action.',
        },
      })
    );

    expect(container.textContent).toContain('my-mcp-server');
    expect(container.textContent).toContain('Please confirm this action.');
  });

  it('falls back to plain target+detail when details is absent', async () => {
    await render(
      makeApprovalItem({
        target: 'src/index.ts',
        detail: 'editing line 42',
        details: undefined,
      })
    );

    expect(container.textContent).toContain('src/index.ts');
    expect(container.textContent).toContain('editing line 42');
  });
});
