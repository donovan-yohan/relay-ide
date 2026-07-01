import { describe, expect, it } from 'vitest';
import {
  buildTopicPaletteResults,
  recentTopicPaletteResults,
} from '../frontend/src/lib/command-palette-topic-results.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';

const NOW = '2026-07-01T00:00:00Z';

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

describe('buildTopicPaletteResults', () => {
  it('matches on title, description, repo path, and node', () => {
    const topic = makeTopic();
    expect(buildTopicPaletteResults('frontend', [topic])).toHaveLength(1);
    expect(buildTopicPaletteResults('chat-first', [topic])).toHaveLength(1);
    expect(buildTopicPaletteResults('/repo/relay', [topic])).toHaveLength(1);
    expect(buildTopicPaletteResults('devbox', [topic])).toHaveLength(1);
    expect(buildTopicPaletteResults('nomatch', [topic])).toHaveLength(0);
  });

  it('renders a topic-prefixed id, title label, and repo sublabel', () => {
    const results = buildTopicPaletteResults('frontend', [makeTopic()]);
    expect(results[0]).toMatchObject({
      type: 'topic',
      id: 'topic-topic:alpha',
      label: 'Frontend lane',
      sublabel: '/repo/relay',
    });
  });

  it('falls back to the workspace id as sublabel when there is no repo', () => {
    const topic = makeTopic({ routingDefaults: {} });
    expect(buildTopicPaletteResults('frontend', [topic])[0]?.sublabel).toBe(
      'workspace:alpha'
    );
  });

  it('excludes archived topics and respects the limit', () => {
    const archived = makeTopic({ id: 'topic:old', status: 'archived' });
    expect(buildTopicPaletteResults('frontend', [archived])).toHaveLength(0);

    const many = Array.from({ length: 8 }, (_, i) =>
      makeTopic({ id: `topic:${i}` })
    );
    expect(buildTopicPaletteResults('frontend', many, 5)).toHaveLength(5);
  });
});

describe('recentTopicPaletteResults', () => {
  it('returns active topics in order, up to the limit', () => {
    const topics = [
      makeTopic({ id: 'topic:1', display: { title: 'One' } }),
      makeTopic({
        id: 'topic:2',
        display: { title: 'Two' },
        status: 'archived',
      }),
      makeTopic({ id: 'topic:3', display: { title: 'Three' } }),
    ];
    const results = recentTopicPaletteResults(topics, 5);
    expect(results.map((r) => r.label)).toEqual(['One', 'Three']);
  });
});
