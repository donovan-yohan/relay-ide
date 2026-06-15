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
} from '../../../../shared/cli-gateway-contract.js';
import { normalizeGatewayErrorCode } from '../../../../shared/cli-gateway-runtime.js';
import type { RepoInstanceId } from '../../../../shared/identity.js';
import {
  relayCommandDefinition,
  type RelayCommandDefinition,
} from '../../../../shared/relay-command-manifest.js';
import type { SessionSummary } from '../types.js';
import {
  ConfirmationRequiredError,
  ConflictError,
  HttpError,
  createSession as createSessionApi,
  type CreateSessionBody,
} from '../api.js';
import {
  executeWorktreeCreateAction,
  type WorktreeCreateActionInput,
  type WorktreeCreateActionResult,
} from './workspace-lifecycle.js';

const TICKETS_START_WORK_COMMAND = relayCommandDefinition('tickets.startWork');
const BRANCHES_OPEN_SESSION_COMMAND = relayCommandDefinition(
  'branches.openSession'
);

// Both composite verbs project to the same execution surfaces as the other
// lifecycle bridges (mirrors workspace-lifecycle.ts / session-lifecycle.ts).
const LIFECYCLE_SURFACES = ['cli', 'agent', 'web', 'command-center'] as const;

// PROMPT_HANDOFF_UNSUPPORTED is the contract reasonCode the gateway uses when a
// caller asks for typed prompt delivery (`requireTypedDelivery: true`) on a
// prompt mode the surface cannot honor. The bridge surfaces it as an UNSUPPORTED
// gateway error rather than silently degrading to a raw PTY keystroke injection.
const PROMPT_HANDOFF_UNSUPPORTED = 'PROMPT_HANDOFF_UNSUPPORTED';

// The frozen one-shot typed prompt path: the server delivers `initialPrompt` on
// session create once the agent reaches `waiting-for-input` (server/sessions.ts).
// This is the contract's promptHandoff method for the initial-prompt mode.
const INITIAL_PROMPT_METHOD = 'sessions.create.initialPrompt';

// -------------------------------------------------------------------------
// Typed inputs
//
// Optional fields permit explicit `undefined` to satisfy
// exactOptionalPropertyTypes at call sites that resolve ticket/repo/branch/pr
// identity conditionally. Inputs mirror the frozen workflowCommandInputSchema
// sub-shapes (cli-gateway-contract.ts) so callers can pass the same envelope to
// the local bridge or, later, to a routed node RPC without reshaping.
// -------------------------------------------------------------------------

export interface StartWorkTicketInput {
  source: string;
  id: string;
  title?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
}

export interface StartWorkRepoInput {
  repoPath: string;
  nodeId?: string | undefined;
  workspaceId?: string | undefined;
  repoIdentity?: string | undefined;
  repoInstanceId?: RepoInstanceId | string | undefined;
}

export interface StartWorkBranchInput {
  name: string;
  base?: string | undefined;
  remote?: string | undefined;
  url?: string | undefined;
}

export interface StartWorkPrInput {
  number?: number | undefined;
  head?: string | undefined;
  url?: string | undefined;
  base?: string | undefined;
  title?: string | undefined;
}

export type StartWorkWorktreeMode =
  | 'reuse-existing'
  | 'create-if-missing'
  | 'reject-if-missing';

export interface StartWorkWorktreeInput {
  mode?: StartWorkWorktreeMode | undefined;
  worktreePath?: string | undefined;
  allowDirty?: boolean | undefined;
  allowConflicted?: boolean | undefined;
}

export interface StartWorkSessionInput {
  type?: 'agent' | 'terminal' | undefined;
  mode?: 'pty' | 'web' | undefined;
  agent?: string | undefined;
  yolo?: boolean | undefined;
  terminalBackend?: 'relay-pty' | 'tmux-compat' | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  workContextId?: string | undefined;
}

export type StartWorkPromptMode = 'none' | 'initial-prompt' | 'unsupported';

export interface StartWorkPromptInput {
  mode?: StartWorkPromptMode | undefined;
  prompt?: string | undefined;
  requireTypedDelivery?: boolean | undefined;
}

export interface TicketStartWorkActionInput {
  ticket: StartWorkTicketInput;
  repo: StartWorkRepoInput;
  branch?: StartWorkBranchInput | undefined;
  worktree?: StartWorkWorktreeInput | undefined;
  session?: StartWorkSessionInput | undefined;
  prompt?: StartWorkPromptInput | undefined;
  /**
   * Store-state fast-path hint. When the caller already resolved an existing
   * worktree for this branch/repo from the sessions store (the legacy handler
   * lookup), it passes the path here so the bridge skips the worktree create.
   * See the store-vs-server reuse divergence note below.
   */
  existingWorktreePath?: string | null | undefined;
}

export interface BranchOpenSessionActionInput {
  repo: StartWorkRepoInput;
  branch?: StartWorkBranchInput | undefined;
  pr?: StartWorkPrInput | undefined;
  worktree?: StartWorkWorktreeInput | undefined;
  session?: StartWorkSessionInput | undefined;
  prompt?: StartWorkPromptInput | undefined;
  ticket?: StartWorkTicketInput | undefined;
  /**
   * Store-state fast-path hint (see TicketStartWorkActionInput.existingWorktreePath).
   */
  existingWorktreePath?: string | null | undefined;
}

// -------------------------------------------------------------------------
// Output projection types
//
// The bridge projects createSession (+ optional worktree create) results into
// the frozen workflowCommandOutputSchema shape. `session` passes the full
// SessionSummary through (sessionDescriptorSchema is additionalProperties:true);
// the `created`/`reused`/`promptHandoff` envelopes are bridge-owned.
// -------------------------------------------------------------------------

export interface StartWorkCreatedFlags {
  session: boolean;
  worktree: boolean;
}

export interface StartWorkReusedFlags {
  session: boolean;
  worktree: boolean;
}

export interface StartWorkPromptHandoff {
  delivered: boolean;
  method?: string;
}

export interface WorkflowCommandActionData {
  session: SessionSummary;
  nodeId: string;
  repo: Record<string, unknown>;
  worktree: { dirty: boolean; conflicted: boolean; [key: string]: unknown };
  branch: Record<string, unknown>;
  pr?: Record<string, unknown>;
  workContextId?: string;
  created: StartWorkCreatedFlags;
  reused: StartWorkReusedFlags;
  promptHandoff: StartWorkPromptHandoff;
  controlHandoff: Record<string, unknown>;
}

export type TicketStartWorkActionResult =
  RelayCliGatewayEnvelope<WorkflowCommandActionData>;
export type BranchOpenSessionActionResult =
  RelayCliGatewayEnvelope<WorkflowCommandActionData>;

// -------------------------------------------------------------------------
// Injectable deps
//
// Composite executors take an injectable deps bag so tests can compose without
// vi.mock at this layer (mirrors workspace-lifecycle's executor injection).
// Defaults delegate to executeWorktreeCreateAction + api createSession so the
// fetch/typed-HttpError path stays the single source of truth.
// -------------------------------------------------------------------------

export type CreateWorktreeDep = (
  input: WorktreeCreateActionInput
) => Promise<WorktreeCreateActionResult>;
export type CreateSessionDep = (
  body: CreateSessionBody
) => Promise<SessionSummary>;

export interface StartWorkDeps {
  createWorktree?: CreateWorktreeDep;
  createSession?: CreateSessionDep;
}

const defaultCreateWorktree: CreateWorktreeDep = (input) =>
  executeWorktreeCreateAction(input);
const defaultCreateSession: CreateSessionDep = (body) => createSessionApi(body);

// -------------------------------------------------------------------------
// Command-definition getters + descriptor factories
// -------------------------------------------------------------------------

export function ticketsStartWorkCommandDefinition(): RelayCommandDefinition {
  return TICKETS_START_WORK_COMMAND;
}

export function branchesOpenSessionCommandDefinition(): RelayCommandDefinition {
  return BRANCHES_OPEN_SESSION_COMMAND;
}

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

export function ticketStartWorkActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    TICKETS_START_WORK_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(TICKETS_START_WORK_COMMAND, {
    availability,
    surfaces: LIFECYCLE_SURFACES,
  });
}

export function branchOpenSessionActionDescriptor(
  availability: RelayActionAvailability = commandCapabilityAvailability(
    BRANCHES_OPEN_SESSION_COMMAND
  )
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(
    BRANCHES_OPEN_SESSION_COMMAND,
    {
      availability,
      surfaces: LIFECYCLE_SURFACES,
    }
  );
}

// -------------------------------------------------------------------------
// Availability helpers
// -------------------------------------------------------------------------

interface StartWorkAvailabilityInput {
  // UI gate: start-work entry points (StartWorkModal, PR/dashboard rows) live
  // inside a workspace context, so the definitions surface gates on an active
  // workspace before resolving a repo path (mirrors worktree lifecycle).
  workspaceMissing?: boolean;
  repoMissing?: boolean;
  // branches.openSession requires a branch OR a pr target (anyOf in the contract
  // input schema). tickets.startWork additionally requires a ticket but always
  // resolves a branch, so this gate is shared.
  branchOrPrMissing?: boolean;
  ticketMissing?: boolean;
  nodeUnavailableReason?: string | null;
  // v1 start-work writes are local-only; remote nodes fail closed as UNSUPPORTED
  // (mirrors rejectRemoteLifecycleWrite vocabulary used by worktree writes).
  unsupportedRemoteReason?: string | null;
}

export function repoMissing(input: { repo?: { repoPath?: string } }): boolean {
  return !input.repo?.repoPath;
}

export function branchOrPrMissing(input: {
  branch?: { name?: string };
  pr?: { number?: number; head?: string };
}): boolean {
  const hasBranch = Boolean(input.branch?.name);
  const hasPr = Boolean(
    input.pr && (input.pr.number !== undefined || input.pr.head)
  );
  return !hasBranch && !hasPr;
}

export function nodeUnavailableReason(input: {
  repo?: { nodeId?: string };
  nodeOnline?: boolean;
}): string | null {
  if (input.nodeOnline === false) {
    return input.repo?.nodeId
      ? `node ${input.repo.nodeId} is offline`
      : 'node is offline';
  }
  return null;
}

export function unsupportedRemoteReason(input: {
  repo?: { nodeId?: string };
  localNodeId?: string;
}): string | null {
  const { nodeId } = input.repo ?? {};
  if (!nodeId) return null;
  if (input.localNodeId && nodeId === input.localNodeId) return null;
  return 'start-work is local-only in v1; remote node start-work is unsupported until routed node worktree capabilities exist';
}

function ticketStartWorkUnavailableReason(
  input: StartWorkAvailabilityInput
): string | undefined {
  if (input.workspaceMissing)
    return 'starting ticket work requires an active workspace';
  if (input.ticketMissing) return 'starting ticket work requires a ticket';
  if (input.repoMissing) return 'starting ticket work requires a repo path';
  if (input.branchOrPrMissing) return 'starting ticket work requires a branch';
  if (input.nodeUnavailableReason) return input.nodeUnavailableReason;
  if (input.unsupportedRemoteReason) return input.unsupportedRemoteReason;
  return undefined;
}

function branchOpenSessionUnavailableReason(
  input: StartWorkAvailabilityInput
): string | undefined {
  if (input.workspaceMissing)
    return 'opening a branch session requires an active workspace';
  if (input.repoMissing) return 'opening a branch session requires a repo path';
  if (input.branchOrPrMissing)
    return 'opening a branch session requires a branch or PR target';
  if (input.nodeUnavailableReason) return input.nodeUnavailableReason;
  if (input.unsupportedRemoteReason) return input.unsupportedRemoteReason;
  return undefined;
}

export function ticketStartWorkActionAvailability(
  input: StartWorkAvailabilityInput
): RelayActionAvailability {
  return commandCapabilityAvailability(
    TICKETS_START_WORK_COMMAND,
    ticketStartWorkUnavailableReason(input)
  );
}

export function branchOpenSessionActionAvailability(
  input: StartWorkAvailabilityInput
): RelayActionAvailability {
  return commandCapabilityAvailability(
    BRANCHES_OPEN_SESSION_COMMAND,
    branchOpenSessionUnavailableReason(input)
  );
}

// -------------------------------------------------------------------------
// Error mapping
//
// Reuses the workspace-lifecycle mapping shape with one start-work-specific
// addition: SESSION_CONFLICT. The server's sessions.create returns a 409
// carrying a sessionId when a session already exists for this branch/repo. The
// api layer surfaces that as ConflictError(sessionId). This is *success/focus-
// existing* semantics, not a failure — but the composite executor cannot return
// an ok envelope (there is no fresh SessionSummary to project). Instead it emits
// a typed SESSION_CONFLICT error with `details.sessionId` and `retryable:false`
// so the UI handler can distinguish it from a real failure and focus the
// existing session (preserving StartWorkModal's onSessionCreated(sessionId)
// behavior). Callers MUST treat SESSION_CONFLICT + details.sessionId as
// focus-existing, never as a hard error.
//
// STORE-VS-SERVER REUSE DIVERGENCE: there are two independent reuse lookups.
//   1. Store fast-path (caller side): the legacy handler scans the sessions
//      store for an existing session/worktree by branchName+repoPath and, on a
//      hit, focuses it (or passes existingWorktreePath to skip the create). This
//      is a client-only optimization over possibly-stale store state.
//   2. Server authority (this layer): sessions.create independently 409s with a
//      sessionId when the *server* already owns a session for the branch/repo.
//      This is the authoritative reuse signal and may fire even when the store
//      fast-path missed (store lag, multi-tab, federated). Both paths converge
//      on focus-existing; the server 409 is the source of truth.
// -------------------------------------------------------------------------

function reasonCodeFromError(error: HttpError): string | undefined {
  const reasonCode = error.details?.['reasonCode'];
  if (typeof reasonCode === 'string') return reasonCode;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorFromUnknown(
  error: unknown,
  fallbackReasonCode: string,
  fallbackMessage: string
): RelayCliGatewayError {
  // Server-authoritative reuse: a 409 ConflictError is focus-existing, surfaced
  // as a typed SESSION_CONFLICT carrying the existing sessionId.
  if (error instanceof ConflictError) {
    return {
      code: 'SESSION_CONFLICT',
      message: 'a session already exists for this branch',
      retryable: false,
      details: {
        reasonCode: 'SESSION_CONFLICT',
        sessionId: error.sessionId,
      },
    };
  }

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
      code: normalizeGatewayErrorCode(error.status, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
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

// -------------------------------------------------------------------------
// Composite executor internals
// -------------------------------------------------------------------------

interface ResolvedWorktree {
  worktreePath: string | null;
  createdWorktree: boolean;
  reusedWorktree: boolean;
}

/**
 * Resolve the worktree to bind the session to.
 *
 * - existingWorktreePath (store fast-path) or worktree.worktreePath ->
 *   reuse-existing, no create call.
 * - worktree.mode 'create-if-missing' -> calls createWorktree.
 * - default (reuse-existing) with no resolved path -> session create binds to
 *   the repo (worktreePath:null) and lets the server resolve/derive.
 *
 * Throws the worktree error envelope's error as an HttpError-shaped failure so
 * the outer try/catch maps it uniformly. On a worktree create failure the
 * composite fails closed (mirrors worktree write fail-closed posture).
 */
async function resolveWorktree(
  repoPath: string,
  branchName: string | undefined,
  worktree: StartWorkWorktreeInput | undefined,
  existingWorktreePath: string | null | undefined,
  createWorktree: CreateWorktreeDep
): Promise<ResolvedWorktree> {
  const mode: StartWorkWorktreeMode = worktree?.mode ?? 'reuse-existing';
  const hintedPath = existingWorktreePath ?? worktree?.worktreePath ?? null;

  if (hintedPath) {
    return {
      worktreePath: hintedPath,
      createdWorktree: false,
      reusedWorktree: true,
    };
  }

  if (mode === 'create-if-missing') {
    const created = await createWorktree({
      repoPath,
      ...(branchName !== undefined ? { branch: branchName } : {}),
    });
    if (!created.ok) {
      // Fail closed: surface the worktree-create gateway error verbatim so the
      // composite verb reports the underlying reason (NODE_OFFLINE, UNSUPPORTED,
      // CONFIRMATION_REQUIRED, etc.) instead of an opaque session failure.
      throw new WorktreeCreateFailure(created.error);
    }
    return {
      worktreePath: created.data.worktreePath,
      createdWorktree: true,
      reusedWorktree: false,
    };
  }

  // reuse-existing / reject-if-missing with no resolved path: bind to repo and
  // let the server resolve. reject-if-missing semantics are enforced server-side
  // in the frozen verb; the local bridge does not synthesize a missing worktree.
  return {
    worktreePath: null,
    createdWorktree: false,
    reusedWorktree: false,
  };
}

// Carries a pre-mapped worktree-create gateway error through the composite's
// outer catch so the composite reports the worktree reason verbatim.
class WorktreeCreateFailure extends Error {
  gatewayError: RelayCliGatewayError;
  constructor(gatewayErr: RelayCliGatewayError) {
    super(gatewayErr.message);
    this.name = 'WorktreeCreateFailure';
    this.gatewayError = gatewayErr;
  }
}

interface ResolvedPrompt {
  initialPrompt?: string;
  promptHandoff: StartWorkPromptHandoff;
  // Set when prompt mode is 'unsupported' + requireTypedDelivery: the composite
  // must fail with UNSUPPORTED + PROMPT_HANDOFF_UNSUPPORTED before creating a
  // session (never degrade to raw PTY).
  unsupported?: RelayCliGatewayError;
}

function resolvePrompt(
  prompt: StartWorkPromptInput | undefined
): ResolvedPrompt {
  const mode: StartWorkPromptMode = prompt?.mode ?? 'none';

  if (mode === 'initial-prompt' && prompt?.prompt) {
    return {
      initialPrompt: prompt.prompt,
      promptHandoff: { delivered: true, method: INITIAL_PROMPT_METHOD },
    };
  }

  if (mode === 'unsupported' && prompt?.requireTypedDelivery) {
    return {
      promptHandoff: { delivered: false },
      unsupported: {
        code: 'UNSUPPORTED',
        message:
          'typed prompt delivery is required but this surface cannot deliver it',
        retryable: false,
        details: { reasonCode: PROMPT_HANDOFF_UNSUPPORTED },
      },
    };
  }

  // mode 'none' or 'unsupported' without requireTypedDelivery, or initial-prompt
  // with no prompt text: nothing delivered, no failure.
  return { promptHandoff: { delivered: false } };
}

function ticketContextFromInput(
  ticket: StartWorkTicketInput,
  repoPath: string,
  repoName: string
): CreateSessionBody['ticketContext'] {
  return {
    ticketId: ticket.id,
    title: ticket.title ?? '',
    ...(ticket.description !== undefined
      ? { description: ticket.description }
      : {}),
    url: ticket.url ?? '',
    // The legacy ticketContext type is github|jira; the contract ticket.source
    // is an open string. Narrow non-jira sources to github (the default agent
    // ticket origin) so the existing session ticketContext shape is preserved.
    source: ticket.source === 'jira' ? 'jira' : 'github',
    repoPath,
    repoName,
  };
}

function repoNameFromPath(repoPath: string): string {
  const segments = repoPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? repoPath;
}

function buildSessionBody(args: {
  repo: StartWorkRepoInput;
  branchName: string | undefined;
  worktreePath: string | null;
  createdWorktree: boolean;
  session: StartWorkSessionInput | undefined;
  ticketContext?: CreateSessionBody['ticketContext'];
  initialPrompt?: string;
}): CreateSessionBody {
  const { repo, branchName, worktreePath, createdWorktree, session } = args;
  return {
    repoPath: repo.repoPath,
    worktreePath,
    type: session?.type ?? 'agent',
    ...(repo.nodeId !== undefined ? { nodeId: repo.nodeId } : {}),
    ...(branchName !== undefined ? { branchName } : {}),
    ...(createdWorktree ? { newWorktree: true } : {}),
    ...(session?.mode !== undefined ? { mode: session.mode } : {}),
    ...(session?.agent !== undefined ? { agent: session.agent } : {}),
    ...(session?.yolo !== undefined ? { yolo: session.yolo } : {}),
    ...(session?.terminalBackend !== undefined
      ? { terminalBackend: session.terminalBackend }
      : {}),
    ...(session?.cols !== undefined ? { cols: session.cols } : {}),
    ...(session?.rows !== undefined ? { rows: session.rows } : {}),
    ...(args.ticketContext ? { ticketContext: args.ticketContext } : {}),
    ...(args.initialPrompt !== undefined
      ? { initialPrompt: args.initialPrompt }
      : {}),
  };
}

function repoOutput(repo: StartWorkRepoInput): Record<string, unknown> {
  return {
    repoPath: repo.repoPath,
    ...(repo.nodeId !== undefined ? { nodeId: repo.nodeId } : {}),
    ...(repo.workspaceId !== undefined ? { workspaceId: repo.workspaceId } : {}),
    ...(repo.repoIdentity !== undefined
      ? { repoIdentity: repo.repoIdentity }
      : {}),
    ...(repo.repoInstanceId !== undefined
      ? { repoInstanceId: repo.repoInstanceId }
      : {}),
  };
}

function branchOutput(
  branch: StartWorkBranchInput | undefined,
  session: SessionSummary
): Record<string, unknown> {
  const name = branch?.name ?? session.branchName;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(branch?.base !== undefined ? { base: branch.base } : {}),
    ...(branch?.remote !== undefined ? { remote: branch.remote } : {}),
    ...(branch?.url !== undefined ? { url: branch.url } : {}),
  };
}

function prOutput(pr: StartWorkPrInput): Record<string, unknown> {
  return {
    ...(pr.number !== undefined ? { number: pr.number } : {}),
    ...(pr.head !== undefined ? { head: pr.head } : {}),
    ...(pr.base !== undefined ? { base: pr.base } : {}),
    ...(pr.url !== undefined ? { url: pr.url } : {}),
    ...(pr.title !== undefined ? { title: pr.title } : {}),
  };
}

// Project the SessionSummary into a contract-valid session descriptor. The
// descriptor requires `mode` and `status`; SessionSummary leaves both optional,
// so default them (pty/active) rather than emit a contract-violating session.
function sessionForOutput(session: SessionSummary): SessionSummary {
  return {
    ...session,
    mode: session.mode ?? 'pty',
    status: session.status ?? 'active',
  };
}

function projectWorkflowOutput(args: {
  session: SessionSummary;
  repo: StartWorkRepoInput;
  branch: StartWorkBranchInput | undefined;
  pr: StartWorkPrInput | undefined;
  resolvedWorktree: ResolvedWorktree;
  worktreePolicy: StartWorkWorktreeInput | undefined;
  promptHandoff: StartWorkPromptHandoff;
  workContextId: string | undefined;
}): WorkflowCommandActionData {
  const { session, repo, branch, pr, resolvedWorktree } = args;
  return {
    session: sessionForOutput(session),
    nodeId: repo.nodeId ?? session.nodeId ?? 'local',
    repo: repoOutput(repo),
    worktree: {
      dirty: args.worktreePolicy?.allowDirty ?? false,
      conflicted: args.worktreePolicy?.allowConflicted ?? false,
      ...(resolvedWorktree.worktreePath
        ? { worktreePath: resolvedWorktree.worktreePath }
        : {}),
    },
    branch: branchOutput(branch, session),
    ...(pr ? { pr: prOutput(pr) } : {}),
    ...(args.workContextId ? { workContextId: args.workContextId } : {}),
    created: {
      session: true,
      worktree: resolvedWorktree.createdWorktree,
    },
    reused: {
      session: false,
      worktree: resolvedWorktree.reusedWorktree,
    },
    promptHandoff: args.promptHandoff,
    // controlHandoff stays empty in v1: controlMode is optional/default, no #859
    // regression. The frozen output schema requires the key but it is an open
    // object, so an empty object satisfies the contract.
    controlHandoff: {},
  };
}

// -------------------------------------------------------------------------
// Composite executors
// -------------------------------------------------------------------------

async function executeWorkflow(args: {
  command: 'tickets.startWork' | 'branches.openSession';
  repo: StartWorkRepoInput;
  branch: StartWorkBranchInput | undefined;
  pr: StartWorkPrInput | undefined;
  worktree: StartWorkWorktreeInput | undefined;
  session: StartWorkSessionInput | undefined;
  prompt: StartWorkPromptInput | undefined;
  ticket: StartWorkTicketInput | undefined;
  existingWorktreePath: string | null | undefined;
  fallbackReasonCode: string;
  fallbackMessage: string;
  deps: StartWorkDeps;
}): Promise<RelayCliGatewayEnvelope<WorkflowCommandActionData>> {
  const createWorktree = args.deps.createWorktree ?? defaultCreateWorktree;
  const createSession = args.deps.createSession ?? defaultCreateSession;

  try {
    if (!args.repo.repoPath) {
      return gatewayError(args.command, {
        code: 'INVALID_ARGUMENT',
        message: 'a repo path is required',
        retryable: false,
        details: { reasonCode: 'REPO_REQUIRED' },
      });
    }

    // Resolve prompt first: an unsupported+requireTypedDelivery prompt must fail
    // before any worktree/session side effect (never degrade to raw PTY).
    const resolvedPrompt = resolvePrompt(args.prompt);
    if (resolvedPrompt.unsupported) {
      return gatewayError(args.command, resolvedPrompt.unsupported);
    }

    const branchName = args.branch?.name ?? args.pr?.head;
    const resolvedBranch =
      branchName !== undefined
        ? { ...(args.branch ?? {}), name: branchName }
        : args.branch;
    const resolvedWorktree = await resolveWorktree(
      args.repo.repoPath,
      branchName,
      args.worktree,
      args.existingWorktreePath,
      createWorktree
    );

    const repoName = repoNameFromPath(args.repo.repoPath);
    const ticketContext = args.ticket
      ? ticketContextFromInput(args.ticket, args.repo.repoPath, repoName)
      : undefined;

    const body = buildSessionBody({
      repo: args.repo,
      branchName,
      worktreePath: resolvedWorktree.worktreePath,
      createdWorktree: resolvedWorktree.createdWorktree,
      session: args.session,
      ...(ticketContext ? { ticketContext } : {}),
      ...(resolvedPrompt.initialPrompt !== undefined
        ? { initialPrompt: resolvedPrompt.initialPrompt }
        : {}),
    });

    const session = await createSession(body);

    return gatewayOk(
      args.command,
      projectWorkflowOutput({
        session,
        repo: args.repo,
        branch: resolvedBranch,
        pr: args.pr,
        resolvedWorktree,
        worktreePolicy: args.worktree,
        promptHandoff: resolvedPrompt.promptHandoff,
        workContextId: args.session?.workContextId,
      })
    );
  } catch (rawError) {
    if (rawError instanceof WorktreeCreateFailure) {
      return gatewayError(args.command, rawError.gatewayError);
    }
    return gatewayError(
      args.command,
      errorFromUnknown(rawError, args.fallbackReasonCode, args.fallbackMessage)
    );
  }
}

export async function executeTicketStartWorkAction(
  input: TicketStartWorkActionInput,
  deps: StartWorkDeps = {}
): Promise<TicketStartWorkActionResult> {
  return executeWorkflow({
    command: 'tickets.startWork',
    repo: input.repo,
    branch: input.branch,
    pr: undefined,
    worktree: input.worktree,
    session: input.session,
    prompt: input.prompt,
    ticket: input.ticket,
    existingWorktreePath: input.existingWorktreePath,
    fallbackReasonCode: 'TICKET_START_WORK_FAILED',
    fallbackMessage: 'failed to start ticket work',
    deps,
  });
}

export async function executeBranchOpenSessionAction(
  input: BranchOpenSessionActionInput,
  deps: StartWorkDeps = {}
): Promise<BranchOpenSessionActionResult> {
  return executeWorkflow({
    command: 'branches.openSession',
    repo: input.repo,
    branch: input.branch,
    pr: input.pr,
    worktree: input.worktree,
    session: input.session,
    prompt: input.prompt,
    ticket: input.ticket,
    existingWorktreePath: input.existingWorktreePath,
    fallbackReasonCode: 'BRANCH_OPEN_SESSION_FAILED',
    fallbackMessage: 'failed to open branch session',
    deps,
  });
}
