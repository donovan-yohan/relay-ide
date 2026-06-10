import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionAvailability,
  type RelayActionDescriptor,
} from '../../../../shared/action-descriptor.js';
import {
  gatewayError,
  gatewayOk,
  type RelayCliGatewayEnvelope,
  type RelayCliGatewayError,
  type RelayCliGatewayErrorCode,
} from '../../../../shared/cli-gateway-contract.js';
import { normalizeGatewayErrorCode } from '../../../../shared/cli-gateway-runtime.js';
import type { RepoInstanceId, WorktreeInstanceId } from '../../../../shared/identity.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';
import type { SessionSummary } from '../types.js';
import {
  ConfirmationRequiredError,
  HttpError,
  createWorktree as createWorktreeApi,
  deleteWorktree as deleteWorktreeApi,
  launchWorkspaceSession as launchWorkspaceSessionApi,
} from '../api.js';

const WORKTREES_CREATE_COMMAND = relayCommandDefinition('worktrees.create');
const WORKTREES_DELETE_COMMAND = relayCommandDefinition('worktrees.delete');
const WORKTREES_ARCHIVE_COMMAND = relayCommandDefinition('worktrees.archive');
const WORKSPACES_LAUNCH_COMMAND = relayCommandDefinition('workspaces.launch');

// All four verbs project to the same execution surfaces (mirrors session-lifecycle.ts).
const LIFECYCLE_SURFACES = ['cli', 'agent', 'web', 'command-center'] as const;

// Optional fields permit explicit `undefined` to satisfy exactOptionalPropertyTypes
// at call sites that resolve repo/worktree/workspace identity conditionally.
// Inputs take explicit repoPath/worktreePath/workspaceId — the bridge never reads
// browser active-repo state so it stays usable from any surface.
export interface WorktreeCreateActionInput {
  repoPath: string;
  branch?: string | undefined;
  repoInstanceId?: RepoInstanceId | string | undefined;
  confirmationToken?: string | undefined;
}

export interface WorktreeDeleteActionInput {
  worktreePath: string;
  repoPath: string;
  benchId?: WorktreeInstanceId | string | undefined;
  /**
   * Force past fail-closed dirty/active-session gates. The DELETE /worktrees
   * route is force-only (no challenge token round-trip); the DeleteWorktreeDialog
   * status-check → user-confirm → force-delete flow lives entirely in the UI.
   */
  force?: boolean | undefined;
  confirmationToken?: string | undefined;
}

export interface WorktreeArchiveActionInput {
  worktreePath: string;
  repoPath: string;
  benchId?: WorktreeInstanceId | string | undefined;
  force?: boolean | undefined;
  confirmationToken?: string | undefined;
}

export interface WorkspaceLaunchActionInput {
  workspaceId: string;
  agent?: string | undefined;
  yolo?: boolean | undefined;
  terminalBackend?: 'relay-pty' | 'tmux-compat' | undefined;
  claudeArgs?: string[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
}

export interface WorktreeCreateActionData {
  branchName: string;
  mountainName?: string;
  worktreePath: string;
  existing?: boolean;
}

export interface WorktreeMutationActionData {
  ok: boolean;
  action: 'delete' | 'archive';
  branchDeleted: boolean;
  audit?: {
    repoPath?: string;
    worktreePath?: string;
    force?: boolean;
  };
}

// workspaces.launch returns the full SessionSummary (plus partial-launch
// warnings). The contract sessionDescriptorSchema has additionalProperties:true
// and required ['id','type','agent','mode','cwd','displayName','status'], so the
// whole summary passes through and downstream callers keep repoPath/warnings/etc.
export type WorkspaceLaunchActionData = SessionSummary & {
  warnings?: Array<{ repoPath: string; error: string }>;
};

export type WorktreeCreateActionResult =
  RelayCliGatewayEnvelope<WorktreeCreateActionData>;
export type WorktreeDeleteActionResult =
  RelayCliGatewayEnvelope<WorktreeMutationActionData>;
export type WorktreeArchiveActionResult =
  RelayCliGatewayEnvelope<WorktreeMutationActionData>;
export type WorkspaceLaunchActionResult =
  RelayCliGatewayEnvelope<WorkspaceLaunchActionData>;

// Executors take the typed input object so call sites can resolve repo/worktree
// identity once and pass it through. Defaults delegate to api.ts so the
// fetch/typed-HttpError path stays the single source of truth.
export type WorktreeCreateExecutor = (
  input: WorktreeCreateActionInput
) => Promise<{
  branchName: string;
  mountainName: string;
  worktreePath: string | null;
}>;
export type WorktreeDeleteExecutor = (
  input: WorktreeDeleteActionInput
) => Promise<void>;
export type WorktreeArchiveExecutor = (
  input: WorktreeArchiveActionInput
) => Promise<void>;
export type WorkspaceLaunchExecutor = (
  input: WorkspaceLaunchActionInput
) => Promise<WorkspaceLaunchActionData>;

// The DELETE /worktrees route is force-only and never emits a
// CONFIRMATION_REQUIRED challenge (per the wire investigation): its 409 blocking
// bodies are plain strings `{ error: 'active_sessions' | 'uncommitted_changes' }`.
// httpErrorFromResponse surfaces those plain strings on `error.code`, so the map
// is keyed on the plain-string reason as well as the structured reasonCode.
//   - uncommitted_changes -> CONFIRMATION_REQUIRED-equivalent (UI must confirm + force)
//   - active_sessions     -> SESSION_CONFLICT (kill/close sessions first, or force)
const REASON_CODE_TO_GATEWAY_CODE: Record<string, RelayCliGatewayErrorCode> = {
  uncommitted_changes: 'CONFIRMATION_REQUIRED',
  active_sessions: 'SESSION_CONFLICT',
  SESSION_CONFLICT: 'SESSION_CONFLICT',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
};

function commandCapabilityAvailability(
  command: RelayCommandDefinition,
  reason?: string
): RelayActionAvailability {
  return {
    state: reason ? 'unavailable' : 'available',
    ...(reason ? { reason } : {}),
    capabilityHints: command.capabilityHints,
  };
}

export function worktreeCreateActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    WORKTREES_CREATE_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(WORKTREES_CREATE_COMMAND, {
    availability,
    surfaces: LIFECYCLE_SURFACES,
  });
}

export function worktreeDeleteActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    WORKTREES_DELETE_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(WORKTREES_DELETE_COMMAND, {
    availability,
    surfaces: LIFECYCLE_SURFACES,
  });
}

export function worktreeArchiveActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    WORKTREES_ARCHIVE_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(WORKTREES_ARCHIVE_COMMAND, {
    availability,
    surfaces: LIFECYCLE_SURFACES,
  });
}

export function workspaceLaunchActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    WORKSPACES_LAUNCH_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(WORKSPACES_LAUNCH_COMMAND, {
    availability,
    surfaces: LIFECYCLE_SURFACES,
  });
}

interface WorktreeLifecycleAvailabilityInput {
  // UI gate: worktree lifecycle entry points live inside a workspace context,
  // so the definitions surface gates on an active workspace before a repo path.
  workspaceMissing?: boolean;
  repoMissing?: boolean;
  worktreeMissing?: boolean;
  nodeUnavailableReason?: string | null;
  // Matches rejectRemoteLifecycleWrite vocabulary: v1 repo/worktree lifecycle
  // writes are local-only; remote nodes fail closed as UNSUPPORTED.
  unsupportedRemoteReason?: string | null;
}

interface WorkspaceLifecycleAvailabilityInput {
  workspaceMissing?: boolean;
  nodeUnavailableReason?: string | null;
  unsupportedRemoteReason?: string | null;
}

function worktreeLifecycleUnavailableReason(
  input: WorktreeLifecycleAvailabilityInput,
  verb: string
): string | undefined {
  if (input.workspaceMissing) return `${verb} requires an active workspace`;
  if (input.repoMissing) return `${verb} requires a repo path`;
  if (input.worktreeMissing) return `${verb} requires an existing worktree`;
  if (input.nodeUnavailableReason) return input.nodeUnavailableReason;
  if (input.unsupportedRemoteReason) return input.unsupportedRemoteReason;
  return undefined;
}

export function worktreeCreateActionAvailability(
  input: WorktreeLifecycleAvailabilityInput
): RelayActionAvailability {
  // Create has no existing worktree to gate on — only the repo path matters.
  return commandCapabilityAvailability(
    WORKTREES_CREATE_COMMAND,
    worktreeLifecycleUnavailableReason(
      { ...input, worktreeMissing: false },
      'creating a worktree'
    )
  );
}

export function worktreeDeleteActionAvailability(
  input: WorktreeLifecycleAvailabilityInput
): RelayActionAvailability {
  return commandCapabilityAvailability(
    WORKTREES_DELETE_COMMAND,
    worktreeLifecycleUnavailableReason(input, 'deleting a worktree')
  );
}

export function worktreeArchiveActionAvailability(
  input: WorktreeLifecycleAvailabilityInput
): RelayActionAvailability {
  return commandCapabilityAvailability(
    WORKTREES_ARCHIVE_COMMAND,
    worktreeLifecycleUnavailableReason(input, 'archiving a worktree')
  );
}

export function workspaceLaunchActionAvailability(
  input: WorkspaceLifecycleAvailabilityInput
): RelayActionAvailability {
  let reason: string | undefined;
  if (input.workspaceMissing) reason = 'launching a workspace requires a workspace';
  else if (input.nodeUnavailableReason) reason = input.nodeUnavailableReason;
  else if (input.unsupportedRemoteReason) reason = input.unsupportedRemoteReason;
  return commandCapabilityAvailability(WORKSPACES_LAUNCH_COMMAND, reason);
}

export function worktreesCreateCommandDefinition(): RelayCommandDefinition {
  return WORKTREES_CREATE_COMMAND;
}

export function worktreesDeleteCommandDefinition(): RelayCommandDefinition {
  return WORKTREES_DELETE_COMMAND;
}

export function worktreesArchiveCommandDefinition(): RelayCommandDefinition {
  return WORKTREES_ARCHIVE_COMMAND;
}

export function workspacesLaunchCommandDefinition(): RelayCommandDefinition {
  return WORKSPACES_LAUNCH_COMMAND;
}

function reasonCodeFromError(error: HttpError): string | undefined {
  const reasonCode = error.details?.['reasonCode'];
  if (typeof reasonCode === 'string') return reasonCode;
  // The DELETE /worktrees plain-string error bodies surface on `error.code`.
  return typeof error.code === 'string' ? error.code : undefined;
}

function gatewayCodeForHttpError(error: HttpError): RelayCliGatewayErrorCode {
  const reasonCode = reasonCodeFromError(error);
  const mapped = reasonCode ? REASON_CODE_TO_GATEWAY_CODE[reasonCode] : undefined;
  if (mapped) return mapped;
  return normalizeGatewayErrorCode(error.status, {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details,
  });
}

function errorFromUnknown(
  error: unknown,
  fallbackReasonCode: string,
  fallbackMessage: string
): RelayCliGatewayError {
  if (error instanceof ConfirmationRequiredError) {
    return {
      code: 'CONFIRMATION_REQUIRED',
      message: error.message,
      retryable: true,
      details: {
        reasonCode: error.challenge.reasonCode,
        challengeId: error.challenge.challengeId,
        requiredBits: error.challenge.requiredBits,
        expiresAt: error.challenge.expiresAt,
      },
    };
  }

  if (error instanceof HttpError) {
    const reasonCode =
      reasonCodeFromError(error) ?? error.code ?? fallbackReasonCode;
    return {
      code: gatewayCodeForHttpError(error),
      message: error.message,
      retryable: error.retryable ?? error.status >= 500,
      details: { reasonCode, ...(error.details ?? {}) },
    };
  }

  if (error instanceof Error) {
    return {
      code: 'UPSTREAM_ERROR',
      message: error.message,
      retryable: true,
      details: { reasonCode: fallbackReasonCode },
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: fallbackMessage,
    retryable: true,
    details: { reasonCode: fallbackReasonCode },
  };
}

const defaultCreateExecutor: WorktreeCreateExecutor = (input) =>
  createWorktreeApi(input.repoPath, input.branch);
const defaultDeleteExecutor: WorktreeDeleteExecutor = (input) =>
  deleteWorktreeApi(input.worktreePath, input.repoPath, input.force);
// Archive removal bridges to the SAME force-only DELETE /worktrees disk path as
// delete, but is branch-PRESERVING: the gateway worktrees.archive verb reports
// action: 'archive' with branchDeleted: false. The route treats a missing
// deleteBranch flag as `true` (deleteBranch !== false), so the executor MUST
// pass `false` explicitly — otherwise the branch is silently deleted while the
// envelope claims branchDeleted: false. The typed WorktreeArchiveActionInput
// itself carries no deleteBranch field; the preserve-branch contract is encoded
// here in the api call and in the archive envelope.
const defaultArchiveExecutor: WorktreeArchiveExecutor = (input) =>
  deleteWorktreeApi(input.worktreePath, input.repoPath, input.force, false);
const defaultLaunchExecutor: WorkspaceLaunchExecutor = (input) =>
  launchWorkspaceSessionApi(input.workspaceId, {
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.yolo !== undefined ? { yolo: input.yolo } : {}),
    ...(input.terminalBackend !== undefined
      ? { terminalBackend: input.terminalBackend }
      : {}),
    ...(input.claudeArgs !== undefined ? { claudeArgs: input.claudeArgs } : {}),
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
  });

export async function executeWorktreeCreateAction(
  input: WorktreeCreateActionInput,
  createWorktree: WorktreeCreateExecutor = defaultCreateExecutor
): Promise<WorktreeCreateActionResult> {
  try {
    const created = await createWorktree(input);
    // The contract output requires a non-empty string worktreePath; the legacy
    // api type is `string | null` but a successful create always returns a path.
    // Fail closed if it is null rather than coercing to '' — an empty string is
    // a contract-violating, meaningless path the backend would reject downstream.
    if (!created.worktreePath) {
      throw new Error('worktree create returned no worktree path');
    }
    return gatewayOk('worktrees.create', {
      branchName: created.branchName,
      mountainName: created.mountainName,
      worktreePath: created.worktreePath,
    });
  } catch (rawError) {
    return gatewayError(
      'worktrees.create',
      errorFromUnknown(
        rawError,
        'WORKTREE_CREATE_FAILED',
        'failed to create worktree'
      )
    );
  }
}

export async function executeWorktreeDeleteAction(
  input: WorktreeDeleteActionInput,
  deleteWorktree: WorktreeDeleteExecutor = defaultDeleteExecutor
): Promise<WorktreeDeleteActionResult> {
  try {
    await deleteWorktree(input);
    // DELETE returns no body; project the destructive-delete envelope from the
    // request target. Delete is branch-DELETING (branchDeleted: true).
    return gatewayOk('worktrees.delete', {
      ok: true,
      action: 'delete',
      branchDeleted: true,
      audit: {
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        force: input.force ?? false,
      },
    });
  } catch (rawError) {
    return gatewayError(
      'worktrees.delete',
      errorFromUnknown(
        rawError,
        'WORKTREE_DELETE_FAILED',
        'failed to delete worktree'
      )
    );
  }
}

export async function executeWorktreeArchiveAction(
  input: WorktreeArchiveActionInput,
  archiveWorktree: WorktreeArchiveExecutor = defaultArchiveExecutor
): Promise<WorktreeArchiveActionResult> {
  try {
    await archiveWorktree(input);
    // Archive is branch-PRESERVING (deliberate behavior change vs delete):
    // action: 'archive', branchDeleted: false. The executor must NOT request
    // branch deletion.
    return gatewayOk('worktrees.archive', {
      ok: true,
      action: 'archive',
      branchDeleted: false,
      audit: {
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        force: input.force ?? false,
      },
    });
  } catch (rawError) {
    return gatewayError(
      'worktrees.archive',
      errorFromUnknown(
        rawError,
        'WORKTREE_ARCHIVE_FAILED',
        'failed to archive worktree'
      )
    );
  }
}

export async function executeWorkspaceLaunchAction(
  input: WorkspaceLaunchActionInput,
  launchWorkspaceSession: WorkspaceLaunchExecutor = defaultLaunchExecutor
): Promise<WorkspaceLaunchActionResult> {
  try {
    const session = await launchWorkspaceSession(input);
    // Pass the full SessionSummary through unchanged so downstream consumers keep
    // repoPath/worktreePath/warnings/etc. (sessionDescriptorSchema is open).
    return gatewayOk('workspaces.launch', session);
  } catch (rawError) {
    return gatewayError(
      'workspaces.launch',
      errorFromUnknown(
        rawError,
        'WORKSPACE_LAUNCH_FAILED',
        'failed to launch workspace session'
      )
    );
  }
}
