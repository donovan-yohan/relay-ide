import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactKindIcon,
  buildArtifactPaletteResults,
  fetchArtifactPaletteResults,
} from '../frontend/src/lib/command-palette-artifact-results.js';
import type { PipelineHandoffArtifactEnvelope } from '../frontend/src/lib/pipeline-handoff-timeline.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';

const NOW = '2026-07-01T00:00:00Z';

function envelope(
  overrides: Partial<PipelineHandoffArtifactEnvelope['metadata']> = {}
): PipelineHandoffArtifactEnvelope {
  return {
    metadata: {
      id: 'pipeline-handoff:artifact:aaaaaaaa',
      workContextId: 'wc:alpha',
      taskRef: { kind: 'github-issue', id: '1065' },
      kind: 'report',
      title: 'Router artifact search handoff',
      summary: 'router and CLI/API support for artifact search',
      visibility: 'private',
      capturedAt: NOW,
      payloadKind: 'pipeline-handoff-artifact',
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 42,
      ...overrides,
    },
  };
}

function makeTopic(overrides: Partial<WorkspaceTopic> = {}): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:alpha',
    workspaceId: 'workspace:alpha',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'Frontend lane', description: 'chat-first surface' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: { nodeId: 'devbox', repoPath: '/repo/relay' },
    linkedRefs: {},
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mockFetch(response: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('artifactKindIcon', () => {
  it('renders a distinct glyph per artifact kind', () => {
    expect(artifactKindIcon('diff')).not.toBe(artifactKindIcon('screenshot'));
    expect(artifactKindIcon('file')).toBe(artifactKindIcon(undefined));
  });
});

describe('buildArtifactPaletteResults', () => {
  it('maps title, id, and the linked topic sublabel when a topic links the WorkContext', () => {
    const topic = makeTopic({ linkedRefs: { workContextIds: ['wc:alpha'] } });
    const results = buildArtifactPaletteResults([envelope()], [topic]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'artifact',
      id: 'artifact-pipeline-handoff:artifact:aaaaaaaa',
      label: 'Router artifact search handoff',
      sublabel: 'Frontend lane · report',
    });
  });

  it('falls back to the workContextId as sublabel when no topic links it', () => {
    const results = buildArtifactPaletteResults([envelope()], []);
    expect(results[0]?.sublabel).toBe('wc:alpha · report');
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      envelope({ id: `pipeline-handoff:artifact:${i}` })
    );
    expect(buildArtifactPaletteResults(many, [], 5)).toHaveLength(5);
  });
});

describe('fetchArtifactPaletteResults', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns [] without fetching for an empty query', async () => {
    const fetchMock = mockFetch({ artifacts: [] });
    const results = await fetchArtifactPaletteResults('   ');
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests the hub-wide search endpoint with the query and maps results', async () => {
    const fetchMock = mockFetch({ artifacts: [envelope()] });
    const results = await fetchArtifactPaletteResults('router');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/work-context-artifacts?');
    expect(url).toContain('q=router');
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('Router artifact search handoff');
  });

  it('propagates HTTP errors from the search endpoint', async () => {
    mockFetch({ error: { code: 'FORBIDDEN' } }, false, 403);
    await expect(fetchArtifactPaletteResults('router')).rejects.toThrow();
  });
});
