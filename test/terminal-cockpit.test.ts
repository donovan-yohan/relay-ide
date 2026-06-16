import { describe, expect, it } from 'vitest';

import type { WorkContextPrivacyMetadata } from '../shared/work-context.js';
import {
  buildTerminalCockpitDetail,
  buildTerminalCockpitView,
  renderTerminalCockpit,
  renderTerminalCockpitDetail,
  type TerminalCockpitActiveGroupInput,
} from '../shared/terminal-cockpit.js';

const privacy: WorkContextPrivacyMetadata = {
  classification: 'internal',
  retention: 'project',
  rawPayloadStored: false,
  redaction: { redacted: false, strategy: 'none', classes: [] },
};

function group(
  id: string,
  overrides: Partial<TerminalCockpitActiveGroupInput> = {}
): TerminalCockpitActiveGroupInput {
  return {
    id,
    context: {
      id,
      title: `Work ${id}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: [
        {
          kind: 'github-issue',
          id: '934',
          title: 'Terminal cockpit',
          status: 'in-progress',
        },
      ],
      artifacts: [
        {
          id: `artifact-${id}`,
          kind: 'report',
          title: `status ${id}`,
          summary: 'bounded status evidence',
          uri: `artifact-ref-${id}`,
          producedAt: '2026-01-01T00:05:00.000Z',
          privacy,
        },
      ],
    },
    node: { nodeId: 'local', status: 'online' },
    staleReadModel: false,
    sessions: [
      {
        id: `session-${id}`,
        nodeId: 'local',
        globalSessionId: `local:session-${id}`,
        type: 'agent',
        mode: 'pty',
        agent: 'codex',
        displayName: `Session ${id}`,
        status: 'active',
        agentState: 'processing',
        durability: 'running-attached',
        controlMode: 'co-driven',
        controlFreshness: 'fresh',
        activeActors: [{ kind: 'agent', id: 'codex', displayName: 'Codex' }],
        lastActivity: '2026-01-01T00:01:00.000Z',
        associatedAt: '2026-01-01T00:00:00.000Z',
        cwd: '/repo',
        live: true,
      },
    ],
    ...overrides,
  };
}

describe('terminal cockpit view', () => {
  it('orders operator-needed sessions before offline/stale/error/running work', () => {
    const view = buildTerminalCockpitView({
      generatedAt: '2026-01-01T00:10:00.000Z',
      groups: [
        group('running', {
          sessions: [
            {
              ...group('running').sessions[0]!,
              id: 'running-session',
              agentState: 'processing',
            },
          ],
        }),
        group('offline', {
          node: { nodeId: 'node-off', status: 'offline' },
          sessions: [
            {
              ...group('offline').sessions[0]!,
              id: 'offline-session',
              live: false,
              durability: 'stale-node',
            },
          ],
        }),
        group('permission', {
          sessions: [
            {
              ...group('permission').sessions[0]!,
              id: 'permission-session',
              agentState: 'permission-prompt',
              durability: 'permission-needed',
              lastActivity: '2026-01-01T00:02:00.000Z',
            },
          ],
        }),
        group('error', {
          sessions: [
            {
              ...group('error').sessions[0]!,
              id: 'error-session',
              agentState: 'error',
              durability: 'error',
            },
          ],
        }),
      ],
    });

    expect(view.items.map((item) => item.workContext.id)).toEqual([
      'permission',
      'offline',
      'error',
      'running',
    ]);
    expect(view.next?.attention.label).toBe('needs approval');
    expect(view.next?.workContext.taskRefs[0]).toMatchObject({
      kind: 'github-issue',
      id: '934',
      status: 'in-progress',
    });
    expect(view.next?.workContext.artifacts).toMatchObject({
      count: 1,
      latest: [{ title: 'status permission' }],
    });
  });

  it('preserves stale/offline last-known context while disabling live controls with reasons', () => {
    const view = buildTerminalCockpitView({
      groups: [
        group('stale-work', {
          node: {
            nodeId: 'remote-1',
            status: 'stale',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
          },
          staleReadModel: true,
          sessions: [
            {
              ...group('stale-work').sessions[0]!,
              id: 'stale-session',
              nodeId: 'remote-1',
              globalSessionId: 'remote-1:stale-session',
              live: false,
              durability: 'stale-node',
              controlFreshness: 'stale',
            },
          ],
        }),
      ],
    });

    const item = view.items[0]!;
    expect(item.workContext.id).toBe('stale-work');
    expect(item.node).toMatchObject({
      id: 'remote-1',
      status: 'stale',
      freshness: 'stale',
    });
    expect(item.actions.attach).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('stale node'),
    });
    expect(item.actions.smallInput).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('stale node'),
    });
    expect(item.actions.destructive).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('outside the terminal cockpit MVP'),
    });
  });

  it('renders a bounded terminal screen with why/node/durability/control/task/action context', () => {
    const view = buildTerminalCockpitView({
      generatedAt: '2026-01-01T00:10:00.000Z',
      groups: [
        group('render', {
          sessions: [
            {
              ...group('render').sessions[0]!,
              agentState: 'waiting-for-input',
              durability: 'running-attached',
            },
          ],
        }),
      ],
    });

    const screen = renderTerminalCockpit(view);
    expect(screen).toContain('Relay terminal cockpit');
    expect(screen).toContain('why: waiting-for-input');
    expect(screen).toContain('node: local (online; freshness=fresh)');
    expect(screen).toContain('durability=running-attached');
    expect(screen).toContain('control: mode=co-driven freshness=fresh');
    expect(screen).toContain('task: github-issue:934 (in-progress)');
    expect(screen).toContain('artifacts: 1 latest=status render');
    expect(screen).toContain('relay-ide v1 sessions attach --id local:session-render --json');
  });

  it('builds selected WorkContext detail with status/evidence/inbox/attach command hints', () => {
    const detail = buildTerminalCockpitDetail({
      generatedAt: '2026-01-01T00:10:00.000Z',
      workContextId: 'selected',
      groups: [group('other'), group('selected')],
    });

    expect(detail?.selector.workContextId).toBe('selected');
    expect(detail?.item.workContext.id).toBe('selected');
    expect(detail?.actionHints.status.map((hint) => hint.command)).toContain(
      'relay-ide v1 work-contexts resume --id selected --json'
    );
    expect(detail?.actionHints.evidence.map((hint) => hint.command)).toEqual(
      expect.arrayContaining([
        'relay-ide v1 work-context-artifacts list --work-context-id selected --json',
        'relay-ide v1 handoff-artifacts list --work-context-id selected --json',
        'relay-ide v1 work-context-artifacts show --id artifact-selected --json',
        'relay-ide v1 work-context-artifacts export --id artifact-selected --json',
        'relay-ide v1 artifacts read --ref artifact-ref-selected --json',
      ])
    );
    expect(detail?.actionHints.inbox.map((hint) => hint.command)).toContain(
      'relay-ide v1 sessions interventions --id local:session-selected --json'
    );
    expect(detail?.actionHints.attach).toMatchObject({
      id: 'sessions.attach',
      enabled: true,
      command: 'relay-ide v1 sessions attach --id local:session-selected --json',
      safety: 'attach',
    });

    const screen = renderTerminalCockpitDetail(detail!);
    expect(screen).toContain('Relay terminal cockpit detail');
    expect(screen).toContain('Commands');
    expect(screen).toContain('status:');
    expect(screen).toContain('evidence:');
    expect(screen).toContain('inbox/interventions:');
    expect(screen).toContain('live controls:');
  });

  it('keeps stale detail attach hints disabled with explicit reasons', () => {
    const detail = buildTerminalCockpitDetail({
      workContextId: 'stale-detail',
      groups: [
        group('stale-detail', {
          node: { nodeId: 'remote-2', status: 'stale' },
          staleReadModel: true,
          sessions: [
            {
              ...group('stale-detail').sessions[0]!,
              nodeId: 'remote-2',
              globalSessionId: 'remote-2:stale-detail-session',
              live: false,
              durability: 'stale-node',
            },
          ],
        }),
      ],
    });

    expect(detail?.actionHints.attach).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('stale node'),
    });
    expect(detail?.actionHints.liveControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sessions.input',
          enabled: false,
          disabledReason: expect.stringContaining('stale node'),
        }),
        expect.objectContaining({
          id: 'sessions.kill',
          enabled: false,
          disabledReason: expect.stringContaining('destructive controls'),
        }),
      ])
    );
  });
});
