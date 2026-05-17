import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HERMES_METADATA_EVENT_INGESTION_RECOMMENDATION,
  ingestHermesMetadataEventCandidate,
  isHermesMetadataEvent,
  validateHermesMetadataEvent,
  type HermesMetadataEvent,
} from '../shared/hermes-metadata-events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'hermes-metadata-events');

function loadFixture(filename: string): HermesMetadataEvent {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, filename), 'utf-8')
  ) as HermesMetadataEvent;
}

function cloneFixture(fixture: HermesMetadataEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

describe('Hermes metadata event ingestion spike contract', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((file) =>
    file.endsWith('.json')
  );

  for (const fixtureFile of fixtureFiles) {
    it(`accepts bounded fixture ${fixtureFile}`, () => {
      const fixture = loadFixture(fixtureFile);
      const result = ingestHermesMetadataEventCandidate(fixture);

      expect(result.accepted).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.event?.privacy.rawPayloadStored).toBe(false);
      expect(result.recommendation).toBe(
        HERMES_METADATA_EVENT_INGESTION_RECOMMENDATION
      );
    });
  }

  it('captures lifecycle status, task refs, node/cwd/repo/worktree anchors, artifacts, and privacy metadata', () => {
    const fixture = loadFixture('session-lifecycle-started.json');

    expect(isHermesMetadataEvent(fixture)).toBe(true);
    expect(fixture.eventKind).toBe('session.lifecycle');
    expect(fixture.status).toBe('started');
    expect(fixture.workContext.taskRefs.map((task) => task.kind)).toEqual([
      'github-issue',
      'kanban-task',
    ]);
    expect(fixture.workContext.anchors.session?.cwd).toContain(
      '.worktrees/556-hermes-event-ingestion'
    );
    expect(fixture.workContext.anchors.repo?.ownerRepo).toBe(
      'donovan-yohan/relay-ide'
    );
    expect(fixture.workContext.anchors.worktree?.branchName).toBe(
      'spike/556-hermes-event-ingestion'
    );
    expect(fixture.artifacts[0]?.privacy.rawPayloadStored).toBe(false);
    expect(fixture.privacy.redaction.classes).toContain('payload');
  });

  it('requires tool.summary events to carry compact tool metadata only', () => {
    const fixture = loadFixture('tool-summary.json');
    const result = ingestHermesMetadataEventCandidate(fixture);

    expect(result.accepted).toBe(true);
    expect(result.event?.tool).toMatchObject({
      name: 'terminal',
      category: 'terminal',
      status: 'succeeded',
    });
    expect(result.event?.tool?.summary).toContain('pass/fail status only');
  });

  it('requires child-session.linked events to carry parent/child session refs', () => {
    const fixture = loadFixture('child-session-linked.json');
    const withoutChildren = cloneFixture(fixture);
    delete withoutChildren.childSessions;

    expect(ingestHermesMetadataEventCandidate(fixture).accepted).toBe(true);
    expect(validateHermesMetadataEvent(withoutChildren)).toContain(
      'child-session.linked events require childSessions'
    );
  });

  it('requires artifact.recorded events to carry artifact refs instead of inline blobs', () => {
    const fixture = loadFixture('artifact-recorded.json');
    const withoutArtifacts = cloneFixture(fixture);
    withoutArtifacts.artifacts = [];

    expect(ingestHermesMetadataEventCandidate(fixture).accepted).toBe(true);
    expect(validateHermesMetadataEvent(withoutArtifacts)).toContain(
      'artifact.recorded events require artifacts'
    );
  });

  it('rejects raw environment-shaped payloads by default', () => {
    const fixture = cloneFixture(loadFixture('session-lifecycle-started.json'));
    fixture.env = { OPENAI_API_KEY: 'sk-nope' };

    const result = ingestHermesMetadataEventCandidate(fixture);

    expect(result.accepted).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'raw/secret/transcript-shaped payload key rejected: $.env'
    );
  });

  it('rejects secret-shaped payloads nested under otherwise valid metadata', () => {
    const fixture = cloneFixture(loadFixture('tool-summary.json'));
    fixture.tool = {
      ...(fixture.tool as Record<string, unknown>),
      authorization: 'Bearer nope',
    };

    const result = ingestHermesMetadataEventCandidate(fixture);

    expect(result.accepted).toBe(false);
    expect(result.errors.join('\n')).toContain('$.tool.authorization');
  });

  it('rejects transcript/message-shaped payloads even when an artifact calls itself a ref', () => {
    const fixture = cloneFixture(loadFixture('artifact-recorded.json'));
    fixture.artifacts = [
      ...((fixture.artifacts as unknown[]) ?? []),
      {
        id: 'artifact:bad-transcript',
        kind: 'transcript-ref',
        summary: 'not enough, this still inlines messages',
        messages: [{ role: 'user', content: 'full transcript goes here' }],
        privacy: {
          classification: 'sensitive',
          retention: 'audit',
          rawPayloadStored: false,
          redaction: {
            redacted: true,
            strategy: 'summary',
            classes: ['transcript'],
          },
        },
      },
    ];

    const result = ingestHermesMetadataEventCandidate(fixture);

    expect(result.accepted).toBe(false);
    expect(result.errors.join('\n')).toContain('$.artifacts[2].messages');
  });

  it('rejects events that explicitly store raw payloads', () => {
    const fixture = cloneFixture(loadFixture('session-lifecycle-started.json'));
    fixture.privacy = {
      ...(fixture.privacy as Record<string, unknown>),
      rawPayloadStored: true,
    };

    const result = ingestHermesMetadataEventCandidate(fixture);

    expect(result.accepted).toBe(false);
    expect(result.errors).toContain(
      'privacy must be valid and rawPayloadStored=false'
    );
  });
});
