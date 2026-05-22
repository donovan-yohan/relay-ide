import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffPlan,
  type HandoffConflict,
  type HandoffRequiredGrant,
  type HandoffSnapshotGroup,
  type HandoffTransferMode,
} from '../../../shared/handoff.js';
export const HANDOFF_CANONICAL_COPY =
  'handoff restarts or continues this work on the hub with the same workcontext. it transfers selected working state and starts a new hub-side session. it does not migrate the live local process.';

export type HandoffFixtureKey =
  | 'clean'
  | 'conflicts'
  | 'grants-required'
  | 'stale-source'
  | 'offline-hub'
  | 'non-git-snapshot'
  | 'summary-only-agent-continuation';

export type HandoffSourceSessionOutcome =
  | 'left running locally'
  | 'stop can be requested after launch'
  | 'source is stale; refresh required'
  | 'summary only; live process remains local';

export interface HandoffAgentContinuationPreview {
  mode: 'full-workcontext' | 'summary-only' | 'terminal-only';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
}

export interface HandoffPlanFixture {
  key: HandoffFixtureKey;
  label: string;
  status: 'ready' | 'blocked' | 'needs-grants' | 'stale' | 'offline';
  statusCopy: string;
  confirmLabel: string;
  confirmDisabledReason: string;
  plan: HandoffPlan;
  sourceSessionOutcome: HandoffSourceSessionOutcome;
  agentContinuation: HandoffAgentContinuationPreview;
  collapsedGroups: HandoffSnapshotGroup[];
}

const NOW = '2026-05-22T03:00:00.000Z';
const SOURCE_NODE = 'local';
const HUB_NODE = 'hub';
const SOURCE_CWD = '/Users/dev/relay-ide/.worktrees/692-handoff-ui-dry-run';
const DESTINATION_CWD = '/srv/relay/workspaces/relay-ide/692-handoff-ui-dry-run';
const WORK_CONTEXT_ID = 'wc:issue-692';
const REQUEST_ID = 'handoff-request:fixture';

function conflict(code: HandoffConflict['code'], message: string): HandoffConflict {
  return { code, message, nodeId: HUB_NODE };
}

function grant(leg: HandoffRequiredGrant['leg'], capability: HandoffRequiredGrant['capability']): HandoffRequiredGrant {
  return {
    leg,
    nodeId: leg === 'source-read' ? SOURCE_NODE : HUB_NODE,
    capability,
    decision: 'requiresConfirmation',
    scope: { kind: 'repo', repoIds: ['github.com/donovan-yohan/relay-ide'] },
  };
}

function basePlan(overrides: Partial<HandoffPlan> = {}): HandoffPlan {
  const transferMode = overrides.transferMode ?? 'tracked-patch';
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: 'handoff-plan:clean',
    requestId: REQUEST_ID,
    createdAt: NOW,
    source: {
      nodeId: SOURCE_NODE,
      sessionId: 'sess-local-692',
      globalSessionId: 'local:sess-local-692',
      workContextId: WORK_CONTEXT_ID,
      cwd: SOURCE_CWD,
      disposition: 'left-running',
      durabilityState: 'running-attached',
    },
    route: {
      sourceNodeId: SOURCE_NODE,
      destinationNodeId: HUB_NODE,
      workContextId: WORK_CONTEXT_ID,
    },
    transferMode,
    includedGroups: transferMode === 'metadata-only' ? ['source-summary'] : ['tracked-patch', 'staged-metadata'],
    excludedGroups: ['excluded-secret', 'excluded-cache'],
    fileCount: transferMode === 'metadata-only' ? 0 : 12,
    byteCount: transferMode === 'metadata-only' ? 0 : 18432,
    destinationProposal: {
      nodeId: HUB_NODE,
      cwd: DESTINATION_CWD,
      repoInstanceId: 'repo-instance:hub:relay-ide',
      worktreeInstanceId: 'worktree-instance:hub:relay-ide:692',
      branchName: 'feat/692-handoff-ui-dry-run',
      action: 'create-worktree',
      sourceCwd: SOURCE_CWD,
      sourceNodeId: SOURCE_NODE,
      summary: 'create a hub worktree from nightly, then apply selected working state',
    },
    pathMappings: [
      {
        kind: 'patch',
        source: { nodeId: SOURCE_NODE, path: SOURCE_CWD },
        destination: { nodeId: HUB_NODE, path: DESTINATION_CWD, mode: 'create' },
        bytes: 16384,
        sha256: 'sha256:tracked-fixture',
        summary: 'tracked patch for frontend handoff dry-run surface',
      },
      {
        kind: 'file',
        source: { nodeId: SOURCE_NODE, path: `${SOURCE_CWD}/notes/handoff-plan.md` },
        destination: { nodeId: HUB_NODE, path: `${DESTINATION_CWD}/notes/handoff-plan.md`, mode: 'create' },
        bytes: 2048,
        sha256: 'sha256:approved-untracked-fixture',
        summary: 'operator-approved untracked handoff notes',
      },
    ],
    conflicts: [],
    requiredGrants: [],
    launchPreview: {
      nodeId: HUB_NODE,
      cwd: DESTINATION_CWD,
      runtime: {
        kind: 'agent',
        providerId: 'claude',
        commandSummary: 'start a new hub-side agent session from the transferred workcontext',
        requiredCapabilities: ['session:create:agent', 'rpc:fs:write', 'rpc:git:write'],
      },
      summary: 'start a new hub-side claude session with the same workcontext after transfer',
      workContextId: WORK_CONTEXT_ID,
    },
    ...overrides,
  };
}

function fixture(
  key: HandoffFixtureKey,
  overrides: Partial<HandoffPlanFixture> & { plan?: HandoffPlan }
): HandoffPlanFixture {
  return {
    key,
    label: key.replaceAll('-', ' '),
    status: 'ready',
    statusCopy: 'fixture dry run only; #691 live execute wiring is unavailable',
    confirmLabel: 'start on hub',
    confirmDisabledReason: 'live handoff execute is unavailable until #691 lands',
    plan: overrides.plan ?? basePlan({ id: `handoff-plan:${key}` }),
    sourceSessionOutcome: 'left running locally',
    agentContinuation: {
      mode: 'full-workcontext',
      confidence: 'high',
      summary: 'continue with workcontext summary, selected patch state, and task refs',
    },
    collapsedGroups: ['tracked-patch', 'approved-untracked'],
    ...overrides,
  };
}

export const HANDOFF_PLAN_FIXTURES: Record<HandoffFixtureKey, HandoffPlanFixture> = {
  clean: fixture('clean', {
    statusCopy: 'clean plan; live confirm remains disabled in fixture mode',
  }),
  conflicts: fixture('conflicts', {
    status: 'blocked',
    statusCopy: 'destination has conflicts; resolve before starting hub session',
    confirmDisabledReason: 'blocked: destination conflict and untracked collision',
    plan: basePlan({
      id: 'handoff-plan:conflicts',
      conflicts: [
        conflict('DESTINATION_CONFLICT', 'destination worktree already changed frontend/src/App.tsx'),
        conflict('UNTRACKED_COLLISION', 'untracked notes/handoff-plan.md already exists on hub'),
      ],
    }),
  }),
  'grants-required': fixture('grants-required', {
    status: 'needs-grants',
    statusCopy: 'additional grants are required before the dry run can execute',
    confirmDisabledReason: 'blocked: source read and destination write grants required',
    plan: basePlan({
      id: 'handoff-plan:grants-required',
      requiredGrants: [
        grant('source-read', 'session:read'),
        grant('destination-write', 'rpc:fs:write'),
        grant('destination-session-create', 'session:create:agent'),
      ],
    }),
  }),
  'stale-source': fixture('stale-source', {
    status: 'stale',
    statusCopy: 'source read model is stale; refresh local session state first',
    confirmDisabledReason: 'blocked: source session is stale',
    sourceSessionOutcome: 'source is stale; refresh required',
    plan: basePlan({
      id: 'handoff-plan:stale-source',
      source: {
        nodeId: SOURCE_NODE,
        sessionId: 'sess-local-692',
        globalSessionId: 'local:sess-local-692',
        workContextId: WORK_CONTEXT_ID,
        cwd: SOURCE_CWD,
        disposition: 'stale-source',
        durabilityState: 'stale-node',
      },
      conflicts: [conflict('STALE_SOURCE', 'source session freshness is older than the latest workcontext event')],
    }),
  }),
  'offline-hub': fixture('offline-hub', {
    status: 'offline',
    statusCopy: 'hub node is offline; plan is readable but cannot start',
    confirmDisabledReason: 'blocked: destination hub is offline',
    plan: basePlan({
      id: 'handoff-plan:offline-hub',
      destinationProposal: {
        nodeId: HUB_NODE,
        cwd: DESTINATION_CWD,
        action: 'create-worktree',
        sourceCwd: SOURCE_CWD,
        sourceNodeId: SOURCE_NODE,
        summary: 'hub inventory is last-known only; wait for node heartbeat',
      },
      conflicts: [conflict('DESTINATION_UNAVAILABLE', 'hub node has no fresh heartbeat')],
    }),
  }),
  'non-git-snapshot': fixture('non-git-snapshot', {
    statusCopy: 'directory snapshot uses approved files and metadata only; no git assumptions',
    plan: basePlan({
      id: 'handoff-plan:non-git-snapshot',
      transferMode: 'approved-untracked-files',
      includedGroups: ['approved-untracked', 'source-summary'],
      excludedGroups: ['excluded-secret', 'excluded-cache'],
      destinationProposal: {
        nodeId: HUB_NODE,
        cwd: '/srv/relay/scratch/design-spike',
        action: 'use-cwd',
        sourceCwd: '/Users/dev/design-spike',
        sourceNodeId: SOURCE_NODE,
        summary: 'copy approved directory files into a hub scratch cwd; no repo badge or git actions',
      },
      pathMappings: [
        {
          kind: 'directory',
          source: { nodeId: SOURCE_NODE, path: '/Users/dev/design-spike' },
          destination: { nodeId: HUB_NODE, path: '/srv/relay/scratch/design-spike', mode: 'create' },
          bytes: 8192,
          summary: 'approved non-git snapshot contents',
        },
      ],
    }),
  }),
  'summary-only-agent-continuation': fixture('summary-only-agent-continuation', {
    statusCopy: 'agent continuation is summary-only; no raw transcript or live process migration',
    sourceSessionOutcome: 'summary only; live process remains local',
    agentContinuation: {
      mode: 'summary-only',
      confidence: 'medium',
      summary: 'continue from bounded workcontext summary and task refs; raw transcript and provider auth stay local',
    },
    plan: basePlan({
      id: 'handoff-plan:summary-only-agent-continuation',
      transferMode: 'metadata-only',
      includedGroups: ['source-summary'],
      excludedGroups: ['excluded-secret', 'excluded-cache'],
      fileCount: 0,
      byteCount: 0,
      pathMappings: [],
      launchPreview: {
        nodeId: HUB_NODE,
        cwd: DESTINATION_CWD,
        runtime: {
          kind: 'agent',
          providerId: 'hermes',
          commandSummary: 'start a fresh hub-side agent with workcontext summary only',
          requiredCapabilities: ['session:create:agent'],
        },
        summary: 'start a new hub-side agent from summary only; no raw transcript sync',
        workContextId: WORK_CONTEXT_ID,
      },
    }),
  }),
};

export const DEFAULT_HANDOFF_FIXTURE_KEY: HandoffFixtureKey = 'clean';
export const HANDOFF_FIXTURE_ORDER: HandoffFixtureKey[] = [
  'clean',
  'conflicts',
  'grants-required',
  'stale-source',
  'offline-hub',
  'non-git-snapshot',
  'summary-only-agent-continuation',
];

export function getHandoffPlanFixture(key: HandoffFixtureKey = DEFAULT_HANDOFF_FIXTURE_KEY): HandoffPlanFixture {
  return HANDOFF_PLAN_FIXTURES[key];
}

export function fixtureTransferModeLabel(mode: HandoffTransferMode): string {
  return mode.replaceAll('-', ' ');
}
