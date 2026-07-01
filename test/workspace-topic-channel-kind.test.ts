import { describe, expect, it } from 'vitest';
import {
  applyWorkspaceTopicUpdate,
  buildWorkspaceTopicRecord,
  parseWorkspaceTopicCreateInput,
  parseWorkspaceTopicUpdateInput,
  WorkspaceTopicValidationError,
} from '../shared/workspace-topics.js';

const NOW = '2026-07-01T00:00:00Z';

describe('workspace topic channelKind', () => {
  it('parses and persists a valid channelKind onto display.kind', () => {
    const create = parseWorkspaceTopicCreateInput({
      workspaceId: 'ws:a',
      title: 'Ops room',
      channelKind: 'ops',
    });
    expect(create.channelKind).toBe('ops');
    const record = buildWorkspaceTopicRecord({ create, now: NOW });
    expect(record.display.kind).toBe('ops');
  });

  it('omits display.kind when no channelKind is given', () => {
    const create = parseWorkspaceTopicCreateInput({
      workspaceId: 'ws:a',
      title: 'Plain topic',
    });
    expect(create.channelKind).toBeUndefined();
    expect(buildWorkspaceTopicRecord({ create, now: NOW }).display.kind).toBe(
      undefined
    );
  });

  it('rejects an invalid channelKind', () => {
    expect(() =>
      parseWorkspaceTopicCreateInput({
        workspaceId: 'ws:a',
        title: 'Bad',
        channelKind: 'nonsense',
      })
    ).toThrow(WorkspaceTopicValidationError);
  });

  it('update sets and clears display.kind', () => {
    const base = buildWorkspaceTopicRecord({
      create: parseWorkspaceTopicCreateInput({
        workspaceId: 'ws:a',
        title: 'T',
        channelKind: 'research',
      }),
      now: NOW,
    });
    expect(base.display.kind).toBe('research');

    const setJournal = applyWorkspaceTopicUpdate({
      topic: base,
      patch: parseWorkspaceTopicUpdateInput({ channelKind: 'journal' }),
      now: NOW,
    });
    expect(setJournal.display.kind).toBe('journal');

    const cleared = applyWorkspaceTopicUpdate({
      topic: setJournal,
      patch: parseWorkspaceTopicUpdateInput({ channelKind: null }),
      now: NOW,
    });
    expect(cleared.display.kind).toBeUndefined();
  });
});
