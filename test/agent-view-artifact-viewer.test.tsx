// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ViewArtifactPackage } from '../shared/agent-view-artifact.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchAgentViewArtifactPackage: vi.fn(),
}));

vi.mock('../frontend/src/lib/api.js', () => ({
  fetchAgentViewArtifactPackage: mocks.fetchAgentViewArtifactPackage,
}));

const { AgentViewArtifactViewer } = await import(
  '../frontend/src/components/AgentViewArtifactViewer.js'
);

const pkg: ViewArtifactPackage = {
  manifest: {
    kind: 'relay.agentView',
    schemaVersion: 1,
    title: 'qa static dashboard',
    description: 'agent-authored static evidence view',
    entry: 'index.html',
    authoring: { actorId: 'agent-alpha', harness: 'hermes' },
    createdAt: '2026-06-10T01:02:03Z',
    updatedAt: '2026-06-10T01:12:13Z',
    scope: { repo: 'relay-ide', taskRefs: [{ kind: 'github-issue', id: '830' }] },
    sources: [
      {
        label: 'issue 830',
        url: 'https://github.com/donovan-yohan/relay-ide/issues/830',
        kind: 'github-issue',
      },
      {
        label: 'design note',
        url: 'https://example.com/design',
        kind: 'doc',
      },
    ],
    capabilities: [],
    export: { policy: 'private' },
    revision: { id: 'rev-1' },
  },
  files: {
    'index.html': '<!doctype html><html><head><title>x</title></head><body><main>safe view</main></body></html>',
    'style.css': 'main { color: #111; }',
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderViewer() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(AgentViewArtifactViewer, {
        artifactId: 'view-artifact-1',
        onClose: vi.fn(),
      })
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mocks.fetchAgentViewArtifactPackage.mockResolvedValue(pkg);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  mocks.fetchAgentViewArtifactPackage.mockReset();
});

describe('AgentViewArtifactViewer', () => {
  it('renders view html only in a locked-down srcDoc iframe', async () => {
    await renderViewer();

    expect(mocks.fetchAgentViewArtifactPackage).toHaveBeenCalledWith(
      'view-artifact-1'
    );
    const iframe = container!.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute('sandbox')).toBe('');
    expect(iframe!.getAttribute('src')).toBeNull();
    expect(iframe!.getAttribute('srcdoc')).toContain('safe view');
    expect(iframe!.getAttribute('srcdoc')).toContain(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
    expect(container!.innerHTML).not.toContain('allow-scripts');
    expect(container!.innerHTML).not.toContain('allow-same-origin');
    expect(iframe!.getAttributeNames()).not.toContain('allow');
  });

  it('shows provenance title, agent, revision, timestamps, and source links', async () => {
    await renderViewer();

    const provenance = container!.querySelector(
      '.agent-view-artifact-viewer__provenance'
    );
    expect(provenance).toBeTruthy();
    const text = provenance!.textContent ?? '';
    expect(text).toContain('qa static dashboard');
    expect(text).toContain('agent-alpha · hermes');
    expect(text).toContain('rev rev-1');
    expect(text).toContain('2026-06-10T01:02:03Z');
    expect(text).toContain('2026-06-10T01:12:13Z');

    const links = Array.from(
      provenance!.querySelectorAll<HTMLAnchorElement>('a')
    );
    expect(links.map((link) => link.textContent)).toEqual([
      'issue 830',
      'design note',
    ]);
    expect(links[0]!.href).toBe(
      'https://github.com/donovan-yohan/relay-ide/issues/830'
    );
    expect(links[1]!.href).toBe('https://example.com/design');
  });
});
