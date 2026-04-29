// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTabBar } from '../frontend/src/components/SessionTabBar.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

function session(id: string, agent: string): SessionSummary {
  return {
    id,
    type: 'agent',
    agent,
    mode: 'web',
    repoName: 'relay-ide',
    repoPath: '/repo',
    worktreePath: null,
    cwd: '/repo',
    branchName: 'main',
    displayName: id,
    createdAt: '2026-04-25T00:00:00.000Z',
    lastActivity: '2026-04-25T00:00:00.000Z',
    idle: true,
    status: 'active',
  };
}

describe('SessionTabBar agent icons', () => {
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

  it('renders provider badges for agent tabs', async () => {
    await act(async () => {
      root.render(
        React.createElement(SessionTabBar, {
          sessions: [
            session('session-claude', 'claude'),
            session('session-codex', 'codex'),
            session('session-opencode', 'opencode'),
            session('session-hermes', 'hermes'),
          ],
          activeSessionId: 'session-opencode',
          onSelectSession: vi.fn(),
          onCloseSession: vi.fn(),
          onNewAgent: vi.fn(),
          onNewTerminal: vi.fn(),
          onCustomize: vi.fn(),
        })
      );
    });

    expect(container.querySelector('svg[aria-label="Claude"]')).toBeTruthy();
    expect(container.querySelector('svg[aria-label="Codex"]')).toBeTruthy();
    expect(container.querySelector('svg[aria-label="OpenCode"]')).toBeTruthy();
    expect(container.querySelector('svg[aria-label="Hermes"]')).toBeTruthy();
  });
});
