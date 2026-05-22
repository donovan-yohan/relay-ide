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
      'summary-only-agent-continuation',
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
    expect(getHandoffPlanFixture('conflicts').plan.conflicts.length).toBeGreaterThan(0);
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
      getHandoffPlanFixture('summary-only-agent-continuation').agentContinuation
        .mode
    ).toBe('summary-only');
    expect(
      getHandoffPlanFixture('summary-only-agent-continuation').plan.pathMappings
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
  });

  async function render(props: React.ComponentProps<typeof HandoffPlanDialog>) {
    await act(async () => {
      root.render(React.createElement(HandoffPlanDialog, props));
    });
  }

  it('does not render when closed', async () => {
    await render({ open: false, onClose: vi.fn() });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders canonical copy, required sections, and disabled confirm', async () => {
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
      'launch summary',
      'agent continuation',
    ]) {
      expect(text).toContain(section);
    }
    const startButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'start on hub'
    );
    expect(startButton).toBeTruthy();
    expect(startButton?.hasAttribute('disabled')).toBe(true);
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
});
