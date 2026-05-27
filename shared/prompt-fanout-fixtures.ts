import {
  PROMPT_FANOUT_RUN_SCHEMA_VERSION,
  type PromptFanoutRun,
  type PromptFanoutTarget,
  type PromptFanoutTargetResult,
} from './prompt-fanout-run.js';

export type PromptFanoutFixtureKey =
  | 'all-success'
  | 'mixed-success-failure'
  | 'denied-target'
  | 'timeout'
  | 'empty-no-eligible-targets'
  | 'loading';

const now = '2026-05-21T12:00:00.000Z';

const TARGET_CLAUDE_LOCAL = 'target:claude-local';
const TARGET_CODEX_NIGHTLY = 'target:codex-nightly';
const TARGET_HERMES_REVIEW = 'target:hermes-review';
const TARGET_OPENCODE_MOBILE = 'target:opencode-mobile';

const baseTargets: PromptFanoutTarget[] = [
  {
    id: TARGET_CLAUDE_LOCAL,
    label: 'claude local session',
    actorRef: {
      kind: 'actor',
      id: 'actor:claude-local',
      displayName: 'claude',
      runtime: 'claude',
      providerId: 'claude-code',
    },
    sessionRef: {
      nodeId: 'local-devbox',
      sessionId: 'sess-claude-001',
      tabKind: 'agent',
      cwd: '/workspace/relay-ide',
    },
    nodeLabel: 'devbox',
    selected: true,
    eligible: true,
  },
  {
    id: TARGET_CODEX_NIGHTLY,
    label: 'codex nightly worktree',
    actorRef: {
      kind: 'actor',
      id: 'actor:codex-nightly',
      displayName: 'codex',
      runtime: 'codex',
      providerId: 'openai-codex',
    },
    sessionRef: {
      nodeId: 'local-devbox',
      sessionId: 'sess-codex-002',
      tabKind: 'agent',
      cwd: '/workspace/relay-ide/.worktrees/nightly',
    },
    nodeLabel: 'devbox',
    selected: true,
    eligible: true,
  },
  {
    id: TARGET_HERMES_REVIEW,
    label: 'hermes review lane',
    actorRef: {
      kind: 'actor',
      id: 'actor:hermes-review',
      displayName: 'hermes reviewer',
      runtime: 'hermes',
      providerId: 'hermes-agent',
    },
    sessionRef: {
      nodeId: 'remote-mac',
      sessionId: 'sess-hermes-003',
      tabKind: 'agent',
      cwd: '/workspace/relay-ide-review',
    },
    nodeLabel: 'remote mac',
    selected: false,
    eligible: true,
  },
  {
    id: TARGET_OPENCODE_MOBILE,
    label: 'opencode mobile smoke',
    actorRef: {
      kind: 'actor',
      id: 'actor:opencode-mobile',
      displayName: 'opencode',
      runtime: 'opencode',
      providerId: 'opencode',
    },
    sessionRef: {
      nodeId: 'tablet-node',
      sessionId: 'sess-opencode-004',
      tabKind: 'agent',
      cwd: '/workspace/mobile',
    },
    nodeLabel: 'tablet',
    selected: false,
    eligible: false,
    deniedReason: 'node grants do not allow prompt fanout dry-run preview',
  },
];

function prompt(title: string, bodyPreview: string) {
  return {
    id: `prompt:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    summary: 'compare implementation plan quality across selected agent sessions',
    bodyPreview,
    authorActorId: 'actor:operator',
    createdAt: now,
    tokenEstimate: 420,
    dryRun: true,
    source: 'fixture' as const,
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

type PromptFanoutTargetResultOverride = Partial<
  Omit<PromptFanoutTargetResult, 'response' | 'startedAt' | 'completedAt' | 'durationMs'>
> & {
  response?: PromptFanoutTargetResult['response'] | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
};

function result(
  targetId: string,
  status: PromptFanoutTargetResult['status'],
  summary: string,
  overrides: PromptFanoutTargetResultOverride = {}
): PromptFanoutTargetResult {
  const base: PromptFanoutTargetResult = {
    targetId,
    status,
    startedAt: '2026-05-21T12:00:05.000Z',
    completedAt: '2026-05-21T12:01:30.000Z',
    durationMs: 85_000,
  };
  if (status === 'succeeded') {
    base.response = {
      summary,
      excerpt: summary,
      normalizedAt: '2026-05-21T12:01:30.000Z',
      tokenCount: 260,
    };
  }
  return stripUndefined({ ...base, ...overrides }) as PromptFanoutTargetResult;
}

function makeRun(
  id: string,
  state: PromptFanoutRun['state'],
  allTargets: PromptFanoutTarget[],
  selectedTargetIds: string[],
  results: PromptFanoutTargetResult[],
  errors: PromptFanoutRun['errors'] = []
): PromptFanoutRun {
  return stripUndefined({
    schemaVersion: PROMPT_FANOUT_RUN_SCHEMA_VERSION,
    id,
    workContextId: 'wc:issue-705-prompt-fanout',
    state,
    prompt: prompt(
      'implementation comparison',
      'given the scoped issue, propose the safest workbench-only implementation plan.'
    ),
    allTargets,
    selectedTargetIds,
    results,
    errors,
    createdAt: now,
    updatedAt: '2026-05-21T12:01:45.000Z',
    startedAt: '2026-05-21T12:00:05.000Z',
    completedAt:
      state === 'running' || state === 'loading' ? undefined : '2026-05-21T12:01:45.000Z',
  }) as PromptFanoutRun;
}

export const promptFanoutRunFixtures: Record<
  PromptFanoutFixtureKey,
  PromptFanoutRun
> = {
  'all-success': makeRun(
    'pfr:all-success',
    'completed',
    baseTargets,
    [TARGET_CLAUDE_LOCAL, TARGET_CODEX_NIGHTLY],
    [
      result(
        TARGET_CLAUDE_LOCAL,
        'succeeded',
        'prefers a schema-first slice with source-level renderer tests and no live sends.'
      ),
      result(
        TARGET_CODEX_NIGHTLY,
        'succeeded',
        'recommends fixtures plus a dry-run audit event before any runtime integration.'
      ),
    ]
  ),
  'mixed-success-failure': makeRun(
    'pfr:mixed-success-failure',
    'partial-failure',
    baseTargets,
    [TARGET_CLAUDE_LOCAL, TARGET_CODEX_NIGHTLY],
    [
      result(
        TARGET_CLAUDE_LOCAL,
        'succeeded',
        'identifies explicit selected targets as the safety boundary.'
      ),
      result(TARGET_CODEX_NIGHTLY, 'failed', 'failed', {
        response: undefined,
        error: {
          code: 'MOCK_PROVIDER_ERROR',
          message: 'fixture provider returned a malformed response summary',
          retryable: true,
        },
      }),
    ],
    [
      {
        code: 'PARTIAL_FAILURE',
        message: 'one selected target failed; successful responses remain visible',
        retryable: true,
      },
    ]
  ),
  'denied-target': makeRun(
    'pfr:denied-target',
    'denied',
    baseTargets.map((target) =>
      target.id === TARGET_OPENCODE_MOBILE
        ? { ...target, selected: true }
        : target
    ),
    [TARGET_CLAUDE_LOCAL, TARGET_OPENCODE_MOBILE],
    [
      result(
        TARGET_CLAUDE_LOCAL,
        'succeeded',
        'safe target returned a normal response summary.'
      ),
      result(TARGET_OPENCODE_MOBILE, 'denied', 'denied', {
        response: undefined,
        error: {
          code: 'TARGET_DENIED',
          message: 'capability grant missing for this target',
          retryable: false,
        },
      }),
    ],
    [
      {
        code: 'TARGET_DENIED',
        message: 'one selected target was denied by capability policy',
        retryable: false,
      },
    ]
  ),
  timeout: makeRun(
    'pfr:timeout',
    'timeout',
    baseTargets,
    [TARGET_CLAUDE_LOCAL, TARGET_CODEX_NIGHTLY],
    [
      result(
        TARGET_CLAUDE_LOCAL,
        'succeeded',
        'completed before the timeout threshold.'
      ),
      result(TARGET_CODEX_NIGHTLY, 'timeout', 'timeout', {
        response: undefined,
        completedAt: '2026-05-21T12:03:05.000Z',
        durationMs: 180_000,
        error: {
          code: 'TARGET_TIMEOUT',
          message: 'target did not produce a normalized summary before timeout',
          retryable: true,
        },
      }),
    ],
    [
      {
        code: 'TARGET_TIMEOUT',
        message: 'one selected target timed out',
        retryable: true,
      },
    ]
  ),
  'empty-no-eligible-targets': makeRun(
    'pfr:empty-no-eligible-targets',
    'empty',
    baseTargets.map((target) => ({
      ...target,
      selected: false,
      eligible: false,
      deniedReason: 'no eligible dry-run target in this WorkContext fixture',
    })),
    [],
    []
  ),
  loading: makeRun(
    'pfr:loading',
    'loading',
    baseTargets,
    [TARGET_CLAUDE_LOCAL, TARGET_CODEX_NIGHTLY],
    [
      result(TARGET_CLAUDE_LOCAL, 'running', 'running', {
        response: undefined,
        completedAt: undefined,
        durationMs: undefined,
      }),
      result(TARGET_CODEX_NIGHTLY, 'queued', 'queued', {
        response: undefined,
        startedAt: undefined,
        completedAt: undefined,
        durationMs: undefined,
      }),
    ]
  ),
};

export function getPromptFanoutRunFixture(
  key: PromptFanoutFixtureKey = 'all-success'
): PromptFanoutRun {
  return promptFanoutRunFixtures[key];
}
