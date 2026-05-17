import { describe, expect, it } from 'vitest';

import { createBenchId } from '../shared/bench.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import { createInstanceId, createProjectId } from '../shared/project.js';
import { createWorkspaceId } from '../shared/workspace.js';
import {
  WORK_CONTEXT_SCHEMA_VERSION,
  createWorkContextPrivacyMetadata,
  isWorkContext,
  type WorkContext,
} from '../shared/work-context.js';

const now = '2026-05-17T07:00:00.000Z';

function basePrivacy() {
  return createWorkContextPrivacyMetadata({
    classification: 'internal',
    retention: 'project',
    rawPayloadStored: false,
  });
}

function redactedPrivacy() {
  return createWorkContextPrivacyMetadata({
    classification: 'sensitive',
    retention: 'audit',
    rawPayloadStored: false,
    redaction: {
      redacted: true,
      strategy: 'summary',
      classes: ['path', 'payload'],
      hashSha256: 'sha256:abc123',
      preview: 'redacted summary only',
    },
  });
}

function baseContext(overrides: Partial<WorkContext>): WorkContext {
  return {
    schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
    id: 'wc:test',
    createdAt: now,
    updatedAt: now,
    source: 'vitest',
    anchors: {},
    actors: [],
    tasks: [],
    artifacts: [],
    auditRefs: [],
    capabilityGrants: [],
    privacy: basePrivacy(),
    ...overrides,
  };
}

describe('work-context contract', () => {
  it('accepts a local repo/worktree-backed context with task, artifacts, audit, and capability refs', () => {
    const repoPath = '/repos/relay-ide';
    const worktreePath = '/repos/relay-ide/.worktrees/554-workcontext-schema';
    const repoIdentity = 'github.com/donovan-yohan/relay-ide';
    const workspaceId = createWorkspaceId('relay');
    const projectId = createProjectId({ kind: 'repo', remote: repoIdentity });
    const instanceId = createInstanceId(projectId, DEFAULT_LOCAL_NODE_ID);
    const benchId = createBenchId(instanceId, worktreePath);
    const sessionId = 'session-local-1';

    const context = baseContext({
      id: 'wc:local-repo',
      title: 'Implement WorkContext contract',
      anchors: {
        node: { nodeId: DEFAULT_LOCAL_NODE_ID, kind: 'local', online: true },
        session: {
          nodeId: DEFAULT_LOCAL_NODE_ID,
          sessionId,
          globalSessionId: createGlobalSessionId(
            DEFAULT_LOCAL_NODE_ID,
            sessionId
          ),
          tabId: 'tab-local-1',
          tabKind: 'agent',
          cwd: worktreePath,
        },
        project: { workspaceId, projectId, instanceId, benchId },
        repo: {
          repoIdentity,
          repoInstanceId: createRepoInstanceId(DEFAULT_LOCAL_NODE_ID, repoPath),
          ownerRepo: 'donovan-yohan/relay-ide',
          remoteUrl: 'git@github.com:donovan-yohan/relay-ide.git',
          localPath: repoPath,
          branchName: 'feature/554-workcontext-schema',
        },
        worktree: {
          worktreeInstanceId: createWorktreeInstanceId(
            DEFAULT_LOCAL_NODE_ID,
            worktreePath
          ),
          localPath: worktreePath,
          branchName: 'feature/554-workcontext-schema',
        },
      },
      actors: [
        { kind: 'human', id: 'operator', displayName: 'Operator' },
        {
          kind: 'agent',
          id: 'kani-backend',
          displayName: 'Kani backend',
          providerId: 'hermes',
          nodeId: DEFAULT_LOCAL_NODE_ID,
          sessionId,
        },
      ],
      tasks: [
        {
          kind: 'github-issue',
          id: '554',
          title: '#552: define WorkContext shared schema contract',
          url: 'https://github.com/donovan-yohan/relay-ide/issues/554',
          parentRef: '552',
          status: 'in-progress',
        },
        { kind: 'kanban-task', id: 't_4892c8ff', status: 'running' },
      ],
      artifacts: [
        {
          id: 'artifact:contract-diff',
          kind: 'diff',
          title: 'WorkContext schema diff',
          path: 'shared/work-context.ts',
          mediaType: 'text/x-diff',
          producedByActorId: 'kani-backend',
          producedAt: now,
          summary: 'Contract source only; no raw transcript or Hermes DB copy.',
          privacy: redactedPrivacy(),
        },
      ],
      auditRefs: [
        {
          id: 'audit:acl-check-1',
          eventId: 'evt-capability-1',
          type: 'capability.resolve',
          occurredAt: now,
          actorId: 'kani-backend',
          correlationId: 'wc:local-repo',
          chainHash: 'sha256:def456',
          logRef: 'audit-log:event:evt-capability-1',
          privacy: redactedPrivacy(),
        },
      ],
      capabilityGrants: [
        {
          id: 'grant:session-read',
          ref: 'acl:local:1.0',
          capability: 'session:read',
          capabilities: ['session:read', 'rpc:git:read'],
          decision: 'allow',
          policyClass: 'read-only',
          scope: { kind: 'repo', repoIds: [repoIdentity] },
          actorId: 'kani-backend',
          auditEventId: 'audit:acl-check-1',
          privacy: basePrivacy(),
        },
      ],
    });

    expect(isWorkContext(context)).toBe(true);
    expect(context.anchors.repo?.repoIdentity).toBe(repoIdentity);
    expect(context.anchors.worktree?.localPath).toBe(worktreePath);
    expect(context.privacy.rawPayloadStored).toBe(false);
  });

  it('accepts a remote-node context without requiring a hub-local repo path', () => {
    const nodeId = 'mac-mini';
    const sessionId = 'remote-session-1';
    const projectId = createProjectId({ kind: 'node', nodeId });
    const instanceId = createInstanceId(projectId, nodeId);
    const benchId = createBenchId(instanceId, '/Users/dev/scratch');

    const context = baseContext({
      id: 'wc:remote-node',
      anchors: {
        node: { nodeId, kind: 'remote', displayName: 'Mac mini', online: true },
        session: {
          nodeId,
          sessionId,
          globalSessionId: createGlobalSessionId(nodeId, sessionId),
          tabId: 'tab-remote-1',
          tabKind: 'terminal',
          cwd: '/Users/dev/scratch',
        },
        project: { projectId, instanceId, benchId },
      },
      actors: [
        { kind: 'node', id: nodeId, displayName: 'Mac mini', nodeId },
        { kind: 'human', id: 'operator' },
      ],
      tasks: [{ kind: 'external', id: 'remote-maintenance' }],
      artifacts: [
        {
          id: 'artifact:remote-log-ref',
          kind: 'log-ref',
          title: 'Remote session log pointer',
          uri: 'relay-node://mac-mini/logs/session/remote-session-1',
          summary: 'Reference only; raw log remains on the node.',
          privacy: redactedPrivacy(),
        },
      ],
      capabilityGrants: [
        {
          id: 'grant:remote-terminal',
          ref: 'acl:mac-mini:1.0',
          capabilities: ['session:create:terminal', 'session:attach'],
          decision: 'requiresConfirmation',
          policyClass: 'exec',
          scope: { kind: 'node' },
          privacy: redactedPrivacy(),
        },
      ],
    });

    expect(isWorkContext(context)).toBe(true);
    expect(context.anchors.repo).toBeUndefined();
    expect(context.anchors.session?.nodeId).toBe(nodeId);
  });

  it('accepts a free non-git context with no repo/project/bench decoration', () => {
    const context = baseContext({
      id: 'wc:free-non-git',
      anchors: {
        node: { nodeId: DEFAULT_LOCAL_NODE_ID, kind: 'local' },
        session: {
          nodeId: DEFAULT_LOCAL_NODE_ID,
          sessionId: 'free-shell',
          globalSessionId: createGlobalSessionId(
            DEFAULT_LOCAL_NODE_ID,
            'free-shell'
          ),
          tabKind: 'terminal',
          cwd: '/tmp',
        },
      },
      actors: [{ kind: 'human', id: 'operator' }],
      artifacts: [
        {
          id: 'artifact:command-summary',
          kind: 'command-output-ref',
          summary: 'Only a command-output pointer/summary is stored.',
          privacy: createWorkContextPrivacyMetadata({ retention: 'ephemeral' }),
        },
      ],
    });

    expect(isWorkContext(context)).toBe(true);
    expect(context.anchors.repo).toBeUndefined();
    expect(context.anchors.worktree).toBeUndefined();
    expect(context.anchors.project).toBeUndefined();
  });

  it('rejects capability grant scopes with malformed string arrays', () => {
    const context = baseContext({
      id: 'wc:bad-capability-scope',
      capabilityGrants: [
        {
          id: 'grant:bad-scope',
          ref: 'acl:local:1.0',
          capability: 'rpc:git:read',
          policyClass: 'read-only',
          scope: { kind: 'repo', repoIds: [42] },
          privacy: basePrivacy(),
        } as unknown as WorkContext['capabilityGrants'][number],
      ],
    });

    expect(isWorkContext(context)).toBe(false);
  });

  it('rejects artifact shapes that try to inline raw transcripts/logs/content blobs', () => {
    const context = baseContext({
      id: 'wc:bad-raw-payload',
      artifacts: [
        {
          id: 'artifact:bad-transcript',
          kind: 'transcript-ref',
          summary: 'This should be a pointer, not an inline transcript.',
          privacy: redactedPrivacy(),
          rawContent: 'full terminal scrollback goes here',
        } as unknown as WorkContext['artifacts'][number],
      ],
    });

    expect(isWorkContext(context)).toBe(false);
  });
});
