// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionHandoffToHub } from '../../frontend/src/lib/actions/definitions/handoff.js';
import {
  HANDOFF_CANONICAL_COPY,
  HANDOFF_FIXTURE_ORDER,
  getHandoffPlanFixture,
} from '../../frontend/src/lib/handoff-fixtures.js';
import type { SessionSummary } from '../../frontend/src/lib/types.js';
import { HandoffPlanDialog } from '../../frontend/src/components/dialogs/HandoffPlanDialog.js';
import {
  _resetForTesting,
  getAction,
  registerGlobal,
} from '../../frontend/src/lib/actions/registry.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('handoff action meta', () => {
  it('registers palette aliases without invoking transfer directly', () => {
    _resetForTesting();
    const handler = vi.fn();
    registerGlobal([{ ...sessionHandoffToHub, handler }]);

    const registered = getAction('session.handoff-to-hub');
    expect(registered).toBeTruthy();
    expect(registered?.label).toBe('handoff to hub…');
    for (const alias of [
      'handoff',
      'move to hub',
      'laptop closing',
      'continue on hub',
    ]) {
      expect(registered?.aliases).toContain(alias);
    }
    expect(registered?.when?.({ view: 'session', sessionId: 'sess-1' })).toBe(
      true
    );
    expect(registered?.when?.({ view: 'dashboard' })).toBe(false);
    expect(registered?.disabledReason?.({ view: 'dashboard' })).toMatch(
      /select a session/
    );

    registered?.handler({ view: 'session', sessionId: 'sess-1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('handoff dry-run fixtures', () => {
  it('covers all required acceptance states', () => {
    expect(HANDOFF_FIXTURE_ORDER).toEqual([
      'clean',
      'conflicts',
      'grants-required',
      'stale-source',
      'offline-hub',
      'non-git-snapshot',
      'summary-only-continuation',
    ]);

    for (const key of HANDOFF_FIXTURE_ORDER) {
      const fixture = getHandoffPlanFixture(key);
      expect(fixture.plan.route.destinationNodeId).toBeTruthy();
      expect(fixture.plan.destinationProposal.cwd).toBeTruthy();
      expect(fixture.confirmDisabledReason).toMatch(/#691|blocked|unavailable/);
    }
  });

  it('models blocked, grant-required, non-git, and summary-only cases explicitly', () => {
    expect(getHandoffPlanFixture('clean').plan.conflicts).toHaveLength(0);
    expect(
      getHandoffPlanFixture('conflicts').plan.conflicts.length
    ).toBeGreaterThan(0);
    expect(
      getHandoffPlanFixture('grants-required').plan.requiredGrants.length
    ).toBeGreaterThan(0);
    expect(getHandoffPlanFixture('stale-source').plan.source.disposition).toBe(
      'stale-source'
    );
    expect(
      getHandoffPlanFixture('offline-hub').plan.conflicts.some(
        (conflict) => conflict.code === 'DESTINATION_UNAVAILABLE'
      )
    ).toBe(true);
    expect(getHandoffPlanFixture('non-git-snapshot').plan.transferMode).toBe(
      'approved-untracked-files'
    );
    expect(
      getHandoffPlanFixture('summary-only-continuation').agentContinuation.mode
    ).toBe('summary-only');
    expect(
      getHandoffPlanFixture('summary-only-continuation').plan.pathMappings
    ).toHaveLength(0);
  });
});

describe('<HandoffPlanDialog />', () => {
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
    vi.unstubAllGlobals();
  });

  async function render(props: React.ComponentProps<typeof HandoffPlanDialog>) {
    await act(async () => {
      root.render(React.createElement(HandoffPlanDialog, props));
    });
  }

  async function flushEffects() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function activeSession(
    overrides: Partial<SessionSummary> = {}
  ): SessionSummary {
    return {
      id: 'sess-local-692',
      type: 'terminal',
      repoName: 'relay-ide',
      repoPath: '/Users/dev/relay-ide',
      worktreePath: '/Users/dev/relay-ide/.worktrees/692-handoff-ui-live-api',
      cwd: '/Users/dev/relay-ide/.worktrees/692-handoff-ui-live-api',
      branchName: 'feat/692-handoff-ui-live-api',
      displayName: 'handoff task',
      createdAt: '2026-05-22T04:00:00.000Z',
      lastActivity: '2026-05-22T04:01:00.000Z',
      idle: false,
      activityState: 'waiting-for-input',
      workContextId: 'wc:issue-692',
      ...overrides,
    };
  }

  it('does not render when closed', async () => {
    await render({ open: false, onClose: vi.fn() });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders canonical copy and required plan sections in fixture mode', async () => {
    await render({ open: true, onClose: vi.fn(), initialFixture: 'clean' });
    const text = container.textContent ?? '';
    expect(text).toContain(HANDOFF_CANONICAL_COPY);
    for (const section of [
      'route',
      'transfer mode',
      'destination path',
      'includes and excludes',
      'conflicts',
      'grants',
      'source session outcome',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain(
      'read-only plan; no destination runtime is launched'
    );
  });

  it('can switch fixture states without transferring', async () => {
    const onClose = vi.fn();
    await render({ open: true, onClose, initialFixture: 'clean' });
    const conflictButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'conflicts'
    );
    expect(conflictButton).toBeTruthy();
    await act(async () => {
      conflictButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('destination has conflicts');
    expect(container.textContent).toContain('destination conflict');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders live no-source state without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await render({
      open: true,
      onClose: vi.fn(),
      mode: 'live',
      activeSession: null,
    });
    await flushEffects();

    expect(container.textContent).toContain('empty');
    expect(container.textContent).toContain('select an active tab');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests and renders a live read-only plan without creating a run', async () => {
    const fixturePlan = getHandoffPlanFixture('grants-required').plan;
    const plan = {
      ...fixturePlan,
      pathMappings: [],
      requiredGrants: [
        { leg: 'source-read', nodeId: 'local', capability: 'rpc:fs:read' },
        { leg: 'destination-write', nodeId: 'hub', capability: 'rpc:fs:write' },
      ],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/handoffs/plan') {
        const body = JSON.parse(String(init?.body));
        expect(body.request.source.workContextId).toBe('wc:issue-692');
        expect(body.request.source.cwd).toContain('692-handoff-ui-live-api');
        return new Response(JSON.stringify({ plan, readOnly: true }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render({
      open: true,
      onClose: vi.fn(),
      mode: 'live',
      activeSession: activeSession(),
    });
    await flushEffects();

    expect(container.textContent).toContain('live api dry run');
    expect(container.textContent).toContain(
      'live API returned a valid read-only plan with required transfer grants'
    );
    expect(container.textContent).toContain(
      'read-only plan; no destination runtime is launched'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps live API capability denial to a typed blocked state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'CAPABILITY_DENIED',
                message:
                  'missing validated capability context for handoff route',
                retryable: false,
                details: { missingCapabilities: ['session:read'] },
              },
            }),
            { status: 403 }
          )
      )
    );

    await render({
      open: true,
      onClose: vi.fn(),
      mode: 'live',
      activeSession: activeSession(),
    });
    await flushEffects();

    expect(container.textContent).toContain('capability denied');
    expect(container.textContent).toContain(
      'no raw logs, transcripts, provider auth, or secrets are exposed'
    );
    expect(container.textContent).not.toContain('start on hub');
  });

  it.each([
    {
      code: 'SOURCE_STALE_OR_OFFLINE',
      status: 409,
      expected: 'source is stale or offline',
    },
    {
      code: 'DESTINATION_UNAVAILABLE',
      status: 503,
      expected: 'hub unavailable',
    },
  ])(
    'maps live API $code to a typed non-secret error state',
    async ({ code, status, expected }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code,
                  message: `${code} should not expose raw payloads`,
                  retryable: false,
                  details: {
                    conflicts: [
                      {
                        code:
                          code === 'DESTINATION_UNAVAILABLE'
                            ? 'DESTINATION_UNAVAILABLE'
                            : 'STALE_SOURCE',
                        message: 'typed conflict summary only',
                      },
                    ],
                  },
                },
              }),
              { status }
            )
        )
      );

      await render({
        open: true,
        onClose: vi.fn(),
        mode: 'live',
        activeSession: activeSession(),
      });
      await flushEffects();

      expect(container.textContent).toContain(expected);
      expect(container.textContent).toContain('typed conflict summary only');
      expect(container.textContent).not.toContain('SECRET=');
      expect(container.textContent).not.toContain('raw transcript');
    }
  );
});
