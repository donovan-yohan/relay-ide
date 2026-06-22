import type { CommandCenterNoMatchReason } from '../../../shared/command-center-resolver.js';

export type CommandCenterResolverGoldenCase = {
  id: string;
  utterance: string;
  providerOutput: unknown;
  expected:
    | { kind: 'execute_command'; commandId: string }
    | { kind: 'open_ui'; commandId: string; actionId: string }
    | { kind: 'ask_followup'; commandId?: string; questionIncludes: string }
    | {
        kind: 'explain';
        citations: readonly string[];
        relatedCommandIds: readonly string[];
      }
    | { kind: 'no_match'; reason: CommandCenterNoMatchReason };
};

export const COMMAND_CENTER_RESOLVER_GOLDEN_CASES: readonly CommandCenterResolverGoldenCase[] =
  [
    {
      id: 'open-ui-sessions-list',
      utterance: 'open the sessions list in command center',
      providerOutput: {
        kind: 'open_ui',
        commandId: 'sessions.list',
        args: {},
        confidence: 0.91,
        sideEffect: 'read',
        requiresConfirmation: false,
        scopeKinds: ['session'],
        capabilityHints: ['session:read'],
        surfaces: ['web', 'command-center'],
        ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
      },
      expected: {
        kind: 'open_ui',
        commandId: 'sessions.list',
        actionId: 'gateway.sessions.list',
      },
    },
    {
      id: 'schema-driven-followup-session-id',
      utterance: 'show me that session details page',
      providerOutput: {
        kind: 'ask_followup',
        commandId: 'sessions.get',
        question: 'Which session id should Relay inspect?',
        confidence: 0.78,
        rationale: 'sessions.get requires an id in its descriptor schema',
      },
      expected: {
        kind: 'ask_followup',
        commandId: 'sessions.get',
        questionIncludes: 'session id',
      },
    },
    {
      id: 'docs-backed-explain-sessions-list',
      utterance: 'what can the sessions list command do?',
      providerOutput: {
        kind: 'explain',
        message:
          'sessions.list is a stable Relay gateway command described by the shared manifest; it reads bounded session descriptors and is surfaced through Command Center metadata rather than private browser handlers.',
        confidence: 0.86,
        citations: [
          'cli-gateway-command-taxonomy',
          'cli-gateway-scoped-read-commands',
          'frontend-action-contract-parity',
        ],
        relatedCommandIds: ['sessions.list'],
        relatedActionIds: ['gateway.sessions.list'],
      },
      expected: {
        kind: 'explain',
        citations: [
          'cli-gateway-command-taxonomy',
          'cli-gateway-scoped-read-commands',
          'frontend-action-contract-parity',
        ],
        relatedCommandIds: ['sessions.list'],
      },
    },
    {
      id: 'read-only-execute-sessions-list',
      utterance: 'list relay sessions',
      providerOutput: {
        kind: 'execute_command',
        commandId: 'sessions.list',
        args: {},
        confidence: 0.93,
        sideEffect: 'read',
        requiresConfirmation: false,
        scopeKinds: ['session'],
        capabilityHints: ['session:read'],
        surfaces: ['web', 'command-center'],
        ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
      },
      expected: { kind: 'execute_command', commandId: 'sessions.list' },
    },
    {
      id: 'low-confidence-no-match',
      utterance: 'maybe something with relay stuff',
      providerOutput: {
        kind: 'execute_command',
        commandId: 'sessions.list',
        args: {},
        confidence: 0.24,
      },
      expected: { kind: 'no_match', reason: 'low-confidence' },
    },
    {
      id: 'provider-declared-no-match',
      utterance: 'order pizza from the command center',
      providerOutput: {
        kind: 'no_match',
        reason: 'not a Relay command',
        confidence: 0.12,
      },
      expected: { kind: 'no_match', reason: 'provider-no-match' },
    },
    {
      id: 'malformed-provider-output',
      utterance: 'show sessions',
      providerOutput: 'sessions.list',
      expected: { kind: 'no_match', reason: 'malformed-output' },
    },
    {
      id: 'policy-blocked-write-proposal',
      utterance: 'rename the current session to ship it',
      providerOutput: {
        kind: 'execute_command',
        commandId: 'sessions.rename',
        args: { repoId: 'repo-1' },
        confidence: 0.94,
        sideEffect: 'write',
        requiresConfirmation: false,
      },
      expected: { kind: 'no_match', reason: 'unsafe-command' },
    },
    {
      id: 'policy-blocked-destructive-proposal',
      utterance: 'kill the active relay session',
      providerOutput: {
        kind: 'execute_command',
        commandId: 'sessions.kill',
        args: { repoId: 'repo-1' },
        confidence: 0.97,
        sideEffect: 'destructive',
        requiresConfirmation: true,
      },
      expected: { kind: 'no_match', reason: 'unsafe-command' },
    },
    {
      id: 'policy-blocked-provider-escalation',
      utterance: 'launch a provider agent and run the fix',
      providerOutput: {
        kind: 'execute_command',
        commandId: 'provider.launch',
        args: { provider: 'claude' },
        confidence: 0.96,
      },
      expected: { kind: 'no_match', reason: 'unknown-command' },
    },
  ];
