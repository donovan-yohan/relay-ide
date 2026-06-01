import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import { EnvironmentPicker } from '../EnvironmentPicker.js';
import { estimateTerminalDimensions } from '../../lib/utils.js';
import { useConfigStore } from '../../lib/stores/config.js';
import { useUiStore } from '../../lib/stores/ui.js';
import { createAgentSession } from '../../lib/session-utils.js';
import { fetchHubNodes, fetchRepoInventory } from '../../lib/api.js';
import {
  cleanCwd,
  defaultRemoteCwd,
  rememberRemoteCwd,
} from '../../lib/remote-node-cwd.js';
import {
  buildEnvironmentOptions,
  firstDegradedReasonMessage,
} from '../../lib/environment-options.js';
import type {
  AgentType,
  AggregatedRepoInventoryGroup,
  AggregatedRepoInventoryResponse,
  FrameworkInfo,
  RepoInventoryRepoInstance,
  RepoInventoryWorktreeInstance,
} from '../../lib/types.js';
import type {
  HubNodeSummary,
  NodeCapabilityStatus,
} from '../../../../shared/relay-node-protocol.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  type NodeId,
} from '../../../../shared/identity.js';
import type { EnvironmentOption } from '../../../../shared/environment-option.js';
import { pickDefaultEnvironment } from '../../../../shared/safe-defaults.js';
import type { SessionLane } from '../../../../shared/session-lane.js';
import './CustomizeSessionDialog.css';

export interface CustomizeSessionDialogHandle {
  open(
    workspace: { name: string; path: string; isGitRepo?: boolean },
    worktreePath?: string | null,
    preselectedFramework?: AgentType
  ): Promise<void>;
  close(): void;
}

interface Props {
  onSessionCreated?: (sessionId: string) => void;
}

type SessionLaunchMode = 'pty' | 'web';

export interface SessionModeOption {
  value: SessionLaunchMode;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function isFrameworkAvailable(framework: FrameworkInfo): boolean {
  return framework.availability?.installed !== false;
}

export function isFrameworkWebAvailable(framework: FrameworkInfo): boolean {
  return framework.webAvailability?.available !== false;
}

export function selectLaunchAgent(
  frameworks: FrameworkInfo[],
  preferredAgent: AgentType
): AgentType {
  const preferred = frameworks.find((f) => f.id === preferredAgent);
  if (!preferred || isFrameworkAvailable(preferred)) return preferredAgent;
  return frameworks.find(isFrameworkAvailable)?.id ?? preferredAgent;
}

export function getSessionModeOptions(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionModeOption[] {
  const selectedFramework = frameworks.find((f) => f.id === selectedAgent);
  if (selectedFramework?.capabilities.supportsWebSessions === true) {
    const webAvailable = isFrameworkWebAvailable(selectedFramework);
    return [
      { value: 'pty', label: 'tui' },
      {
        value: 'web',
        label: webAvailable ? 'web' : 'web (unavailable)',
        ...(!webAvailable ? { disabled: true } : {}),
        ...(selectedFramework.webAvailability?.reason
          ? { reason: selectedFramework.webAvailability.reason }
          : {}),
      },
    ];
  }
  return [{ value: 'pty', label: 'tui' }];
}

export function defaultSessionModeForAgent(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionLaunchMode {
  const supportsWeb = getSessionModeOptions(frameworks, selectedAgent).some(
    (option) => option.value === 'web' && !option.disabled
  );
  return selectedAgent === 'hermes' && supportsWeb ? 'web' : 'pty';
}

type EnvironmentChoice = {
  value: string;
  label: string;
  disabled?: boolean;
  reason?: string;
};

export interface EnvironmentCheckoutChoice extends EnvironmentChoice {
  nodeId: NodeId;
  repoPath: string;
  worktreePath: string | null;
}

export interface EnvironmentPickerModel {
  showPicker: boolean;
  repoChoices: EnvironmentChoice[];
  nodeChoices: EnvironmentChoice[];
  checkoutChoices: EnvironmentCheckoutChoice[];
  selectedGroupId: string | null;
  selectedNodeId: NodeId;
  selectedCheckoutId: string | null;
  selectedNodeReason: string | null;
  resolved: {
    nodeId: NodeId;
    repoPath: string;
    worktreePath: string | null;
  };
}

export interface EnvironmentPickerInput {
  inventory: AggregatedRepoInventoryResponse | null;
  nodes: HubNodeSummary[];
  selectedAgent: AgentType;
  selectedGroupId: string | null;
  selectedNodeId: NodeId | null;
  selectedCheckoutId: string | null;
  fallbackWorkspace: { name: string; path: string; isGitRepo?: boolean };
  fallbackWorktreePath: string | null;
  sessionType?: 'agent' | 'terminal';
}

const CHECKOUT_ROOT_PREFIX = 'repo:';
const CHECKOUT_WORKTREE_PREFIX = 'worktree:';

// Stable timestamp used as `generatedAt` for picker options when the
// inventory snapshot hasn't loaded yet. Pinned to a fixed value (rather
// than `new Date().toISOString()`) so the picker doesn't churn referential
// equality on every render — the inventory's real `generatedAt` replaces
// it as soon as `/hub/repo-inventory` resolves.
const PICKER_FALLBACK_GENERATED_AT = '1970-01-01T00:00:00.000Z';

function syntheticLocalNode(selectedAgent: AgentType): HubNodeSummary {
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    identity: {
      nodeId: DEFAULT_LOCAL_NODE_ID,
      displayName: 'local',
      hostname: 'local',
      createdAt: '',
      pairedAt: '',
    },
    displayName: 'local',
    hostname: 'local',
    platform: 'local',
    arch: 'unknown',
    relayVersion: 'local',
    protocolVersion: 'local',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    trust: {
      state: 'trusted',
      level: 'privileged-local-user',
      warning: '',
    },
    credentialState: 'active',
    credential: {
      credentialId: 'local',
      issuedAt: '',
      state: 'active',
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: 'local',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 8, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      terminalBackends: {
        'relay-pty': 'available',
        'tmux-compat': 'available',
      },
      worktrees: 'available',
      agents: { [selectedAgent]: 'available' },
      serviceManager: 'local',
      wsl: false,
    },
    createdAt: '',
    pairedAt: '',
    lastSeenAt: '',
    credentialId: 'local',
  };
}

function fallbackGroupFor(
  workspace: { name: string; path: string; isGitRepo?: boolean },
  worktreePath: string | null
): AggregatedRepoInventoryGroup {
  const repoInstanceId = `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(workspace.path)}`;
  // Only include worktree entries for git repos — non-git directories have no branches
  const isGit = workspace.isGitRepo !== false;
  const worktrees =
    isGit && worktreePath
      ? [
          {
            worktreeInstanceId: `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(worktreePath)}`,
            localPath: worktreePath,
            branchName: null,
            displayName: worktreePath.split('/').pop() || worktreePath,
          } satisfies RepoInventoryWorktreeInstance,
        ]
      : [];
  return {
    groupId: repoInstanceId,
    repoIdentity: null,
    displayName: workspace.name,
    selectedRemote: null,
    remotes: [],
    warnings: [],
    instances: [
      {
        repoInstanceId,
        nodeId: DEFAULT_LOCAL_NODE_ID,
        localPath: workspace.path,
        name: workspace.name,
        isGitRepo: isGit,
        defaultBranch: null,
        currentBranch: null,
        repoIdentity: null,
        selectedRemote: null,
        remotes: [],
        repoIdentityWarnings: [],
        worktrees,
        reportedAt: '',
      },
    ],
    identityDebug: {
      groupedBy: 'repoInstanceId',
      repoIdentity: null,
      instanceCount: 1,
      nodeIds: [DEFAULT_LOCAL_NODE_ID],
    },
  };
}

function findGroupForPath(
  groups: AggregatedRepoInventoryGroup[],
  path: string
): AggregatedRepoInventoryGroup | undefined {
  return groups.find((group) =>
    group.instances.some(
      (instance) =>
        instance.localPath === path ||
        instance.worktrees.some((worktree) => worktree.localPath === path)
    )
  );
}

function labelForRepo(group: AggregatedRepoInventoryGroup): string {
  if (group.repoIdentity) return `${group.displayName} — ${group.repoIdentity}`;
  // If every instance in the group is a non-git directory, label it accordingly
  const allNonGit =
    group.instances.length > 0 &&
    group.instances.every((inst) => !inst.isGitRepo);
  if (allNonGit) return `${group.displayName} — non-git directory`;
  return `${group.displayName} — unidentified repo`;
}

function capabilityProblem(
  capability: NodeCapabilityStatus | undefined,
  name: string
): string | null {
  if (capability === undefined) return `${name} capability unknown`;
  if (capability === 'available') return null;
  return `${name} ${capability}`;
}

function terminalBackendProblem(node: HubNodeSummary): string | null {
  const relayPty = node.capabilities.terminalBackends?.['relay-pty'] ?? 'unknown';
  const tmuxCompat =
    node.capabilities.terminalBackends?.['tmux-compat'] ??
    node.capabilities.core.tmux;
  if (relayPty === 'available' || tmuxCompat === 'available') return null;
  return `terminal backend unavailable on ${node.displayName} (relay-pty ${relayPty}, tmux-compat ${tmuxCompat})`;
}

export function nodeShellBlockReason(
  node: HubNodeSummary | null
): string | null {
  if (!node) return 'node availability unknown';
  if (node.status === 'offline') return 'node is offline';
  if (node.status === 'stale') return 'heartbeat is stale';
  if (node.status === 'revoked') return 'node is revoked';
  const versionState = node.version?.state;
  if (versionState === 'incompatible') return 'node protocol is incompatible';
  if (versionState === 'version-skew') return 'node has version skew';
  const shellProblem = capabilityProblem(node.capabilities.core.shell, 'shell');
  if (shellProblem) return shellProblem;
  const backendProblem = terminalBackendProblem(node);
  if (backendProblem) return backendProblem;
  return null;
}

export function nodeAgentBlockReason(
  node: HubNodeSummary | null,
  agent: AgentType
): string | null {
  const shellReason = nodeShellBlockReason(node);
  if (shellReason) return shellReason;
  if (!node) return null;
  const agentProblem = capabilityProblem(
    node.capabilities.agents[agent],
    agent
  );
  return agentProblem ? `${agentProblem} on ${node.displayName}` : null;
}

function nodeBlockReason(
  node: HubNodeSummary | null,
  selectedAgent: AgentType
): string | null {
  return nodeAgentBlockReason(node, selectedAgent);
}

function uniqueInstancesByNode(
  instances: RepoInventoryRepoInstance[]
): RepoInventoryRepoInstance[] {
  const seen = new Set<NodeId>();
  return instances.filter((instance) => {
    if (seen.has(instance.nodeId)) return false;
    seen.add(instance.nodeId);
    return true;
  });
}

function checkoutChoicesFor(
  instances: RepoInventoryRepoInstance[],
  disabledReason: string | null
): EnvironmentCheckoutChoice[] {
  const disabled = disabledReason
    ? { disabled: true, reason: disabledReason }
    : {};
  return instances.flatMap((instance) => [
    {
      value: `${CHECKOUT_ROOT_PREFIX}${instance.repoInstanceId}`,
      label: `default — ${instance.localPath}`,
      nodeId: instance.nodeId,
      repoPath: instance.localPath,
      worktreePath: null,
      ...disabled,
    },
    ...instance.worktrees.map((worktree) => ({
      value: `${CHECKOUT_WORKTREE_PREFIX}${worktree.worktreeInstanceId}`,
      label: `${worktree.branchName ?? worktree.displayName ?? 'worktree'} — ${worktree.localPath}`,
      nodeId: instance.nodeId,
      repoPath: instance.localPath,
      worktreePath: worktree.localPath,
      ...disabled,
    })),
  ]);
}

function environmentGroupsFor(
  input: EnvironmentPickerInput
): AggregatedRepoInventoryGroup[] {
  return input.inventory?.groups.length
    ? input.inventory.groups
    : [fallbackGroupFor(input.fallbackWorkspace, input.fallbackWorktreePath)];
}

function selectedEnvironmentGroup(
  groups: AggregatedRepoInventoryGroup[],
  input: EnvironmentPickerInput
): AggregatedRepoInventoryGroup {
  return (
    groups.find((group) => group.groupId === input.selectedGroupId) ??
    findGroupForPath(
      groups,
      input.fallbackWorktreePath ?? input.fallbackWorkspace.path
    ) ??
    groups[0]!
  );
}

function nodeMapFor(
  input: EnvironmentPickerInput
): Map<NodeId, HubNodeSummary> {
  const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
  if (!nodeById.has(DEFAULT_LOCAL_NODE_ID)) {
    nodeById.set(
      DEFAULT_LOCAL_NODE_ID,
      syntheticLocalNode(input.selectedAgent)
    );
  }
  return nodeById;
}

function nodeLabel(nodeId: NodeId, node: HubNodeSummary | null): string {
  if (nodeId === DEFAULT_LOCAL_NODE_ID) return node?.displayName ?? 'local';
  return node?.displayName ?? nodeId;
}

function nodeChoiceIdsFor(
  selectedGroup: AggregatedRepoInventoryGroup,
  nodes: HubNodeSummary[]
): NodeId[] {
  return [
    ...uniqueInstancesByNode(selectedGroup.instances).map(
      (instance) => instance.nodeId
    ),
    ...nodes.map((node) => node.nodeId),
  ];
}

function nodeChoicesFor(
  selectedGroup: AggregatedRepoInventoryGroup,
  input: EnvironmentPickerInput,
  nodeById: Map<NodeId, HubNodeSummary>,
  sessionType: 'agent' | 'terminal' = 'agent'
): EnvironmentChoice[] {
  const seenNodeChoices = new Set<NodeId>();
  return nodeChoiceIdsFor(selectedGroup, input.nodes).flatMap((nodeId) => {
    if (seenNodeChoices.has(nodeId)) return [];
    seenNodeChoices.add(nodeId);
    const node = nodeById.get(nodeId) ?? null;
    const reason =
      sessionType === 'terminal'
        ? nodeShellBlockReason(node)
        : nodeBlockReason(node, input.selectedAgent);
    return [
      {
        value: nodeId,
        label: nodeLabel(nodeId, node),
        ...(reason ? { disabled: true, reason } : {}),
      },
    ];
  });
}

function selectedNodeChoiceFor(
  nodeChoices: EnvironmentChoice[],
  selectedNodeId: NodeId | null
): EnvironmentChoice | undefined {
  const explicit = nodeChoices.find(
    (choice) => choice.value === selectedNodeId
  );
  const firstEnabled = nodeChoices.find((choice) => !choice.disabled);
  if (explicit && (!explicit.disabled || !firstEnabled)) return explicit;
  return firstEnabled ?? explicit ?? nodeChoices[0];
}

function selectedCheckoutFor(
  checkoutChoices: EnvironmentCheckoutChoice[],
  input: EnvironmentPickerInput
): EnvironmentCheckoutChoice | undefined {
  return (
    checkoutChoices.find(
      (choice) => choice.value === input.selectedCheckoutId && !choice.disabled
    ) ??
    checkoutChoices.find(
      (choice) =>
        !choice.disabled && choice.worktreePath === input.fallbackWorktreePath
    ) ??
    checkoutChoices.find(
      (choice) =>
        !choice.disabled &&
        !choice.worktreePath &&
        choice.repoPath === input.fallbackWorkspace.path
    ) ??
    checkoutChoices.find((choice) => !choice.disabled) ??
    checkoutChoices[0]
  );
}

function resolveEnvironment(
  selectedNodeId: NodeId,
  selectedCheckout: EnvironmentCheckoutChoice | undefined,
  input: EnvironmentPickerInput
): EnvironmentPickerModel['resolved'] {
  if (selectedNodeId !== DEFAULT_LOCAL_NODE_ID) {
    return {
      nodeId: selectedNodeId,
      repoPath: selectedCheckout?.repoPath ?? '',
      worktreePath: selectedCheckout?.worktreePath ?? null,
    };
  }
  if (selectedCheckout) {
    return {
      nodeId: selectedCheckout.nodeId,
      repoPath: selectedCheckout.repoPath,
      worktreePath: selectedCheckout.worktreePath,
    };
  }
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    repoPath: input.fallbackWorkspace.path,
    worktreePath: input.fallbackWorktreePath,
  };
}

function shouldShowEnvironmentPicker(
  groups: AggregatedRepoInventoryGroup[],
  nodeChoices: EnvironmentChoice[],
  checkoutChoices: EnvironmentCheckoutChoice[],
  selectedNodeReason: string | null
): boolean {
  return (
    groups.length > 1 ||
    nodeChoices.length > 1 ||
    checkoutChoices.length > 1 ||
    Boolean(selectedNodeReason)
  );
}

export function buildEnvironmentPickerModel(
  input: EnvironmentPickerInput
): EnvironmentPickerModel {
  const sessionType = input.sessionType ?? 'agent';
  const groups = environmentGroupsFor(input);
  const selectedGroup = selectedEnvironmentGroup(groups, input);
  const nodeById = nodeMapFor(input);
  const nodeChoices = nodeChoicesFor(
    selectedGroup,
    input,
    nodeById,
    sessionType
  );
  const selectedNodeChoice = selectedNodeChoiceFor(
    nodeChoices,
    input.selectedNodeId
  );
  const selectedNodeId = selectedNodeChoice?.value ?? DEFAULT_LOCAL_NODE_ID;
  const selectedNodeReason = selectedNodeChoice?.reason ?? null;
  const selectedNodeInstances = selectedGroup.instances.filter(
    (instance) => instance.nodeId === selectedNodeId
  );
  const checkoutChoices = checkoutChoicesFor(
    selectedNodeInstances,
    selectedNodeReason
  );
  const selectedCheckout = selectedCheckoutFor(checkoutChoices, input);

  return {
    showPicker: shouldShowEnvironmentPicker(
      groups,
      nodeChoices,
      checkoutChoices,
      selectedNodeReason
    ),
    repoChoices: groups.map((group) => ({
      value: group.groupId,
      label: labelForRepo(group),
    })),
    nodeChoices,
    checkoutChoices,
    selectedGroupId: selectedGroup.groupId,
    selectedNodeId,
    selectedCheckoutId: selectedCheckout?.value ?? null,
    selectedNodeReason,
    resolved: resolveEnvironment(selectedNodeId, selectedCheckout, input),
  };
}

type DialogSessionType = 'agent' | 'terminal';

interface FormState {
  claudeArgsInput: string;
  selectedAgent: AgentType;
  sessionMode: SessionLaunchMode;
  yoloMode: boolean;
  continueExisting: boolean;
  dialogSessionType: DialogSessionType;
}

function defaultForm(): FormState {
  return {
    claudeArgsInput: '',
    selectedAgent: 'claude',
    sessionMode: 'pty',
    yoloMode: false,
    continueExisting: false,
    dialogSessionType: 'agent',
  };
}

export function getSessionModeOptionsForType(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType,
  dialogSessionType: DialogSessionType
): SessionModeOption[] {
  if (dialogSessionType === 'terminal') {
    return [{ value: 'pty', label: 'shell' }];
  }
  return getSessionModeOptions(frameworks, selectedAgent);
}

async function createSessionFromForm(
  environment: EnvironmentPickerModel['resolved'],
  form: FormState,
  sessionLane: SessionLane,
  remoteCwd?: string
) {
  const remoteNodeSelected = environment.nodeId !== DEFAULT_LOCAL_NODE_ID;
  const { cols, rows } = estimateTerminalDimensions(
    useUiStore.getState().terminalFontSize
  );

  if (form.dialogSessionType === 'terminal') {
    const baseOptions = {
      nodeId: environment.nodeId,
      type: 'terminal' as const,
      mode: 'pty' as const,
      sessionLane,
      cols,
      rows,
    };
    if (remoteNodeSelected) {
      return createAgentSession({
        ...baseOptions,
        cwd: cleanCwd(remoteCwd),
      });
    }
    return createAgentSession({
      ...baseOptions,
      repoPath: environment.repoPath || undefined,
      cwd: environment.repoPath || undefined,
    });
  }

  const claudeArgs = form.claudeArgsInput.trim().split(/\s+/).filter(Boolean);
  const sessionMode: SessionLaunchMode = remoteNodeSelected
    ? 'pty'
    : form.sessionMode;
  const baseOptions = {
    nodeId: environment.nodeId,
    type: 'agent' as const,
    mode: sessionMode,
    continue: form.continueExisting,
    yolo: form.yoloMode,
    claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
    agent: form.selectedAgent,
    sessionLane,
    cols,
    rows,
  };
  if (remoteNodeSelected) {
    return createAgentSession({
      ...baseOptions,
      cwd: cleanCwd(remoteCwd),
    });
  }
  return createAgentSession({
    ...baseOptions,
    repoPath: environment.repoPath,
    worktreePath: environment.worktreePath,
  });
}

interface BodyProps {
  workspaceName: string;
  form: FormState;
  environmentModel: EnvironmentPickerModel;
  selectedRemoteNode: HubNodeSummary | null;
  remoteCwd: string;
  /** Candidate `EnvironmentOption`s built from inventory + nodes (#629). */
  environmentOptions: EnvironmentOption[];
  /** Currently-selected option id in the new picker (#627). */
  selectedEnvironmentOptionId: string | null;
  /** Typed degraded reason chip shown when selection is stale/offline (#629). */
  selectedOptionDegradedMessage: string | null;
  onPickerSelect: (option: EnvironmentOption) => void;
  onFormChange: (patch: Partial<FormState>) => void;
  onEnvironmentChange: (patch: Partial<EnvironmentSelection>) => void;
  onRemoteCwdChange: (cwd: string) => void;
  onDialogSessionTypeChange: (t: DialogSessionType) => void;
}

interface EnvironmentSelection {
  selectedGroupId: string | null;
  selectedNodeId: NodeId | null;
  selectedCheckoutId: string | null;
}

function CustomizeSessionBody({
  workspaceName,
  form,
  environmentModel,
  selectedRemoteNode,
  remoteCwd,
  environmentOptions,
  selectedEnvironmentOptionId,
  selectedOptionDegradedMessage,
  onPickerSelect,
  onFormChange,
  onEnvironmentChange,
  onRemoteCwdChange,
  onDialogSessionTypeChange,
}: BodyProps) {
  const frameworks = useConfigStore((state) => state.frameworks);
  const frameworkOptions =
    frameworks.length > 0
      ? frameworks
      : [
          {
            id: form.selectedAgent,
            displayName: form.selectedAgent,
            command: form.selectedAgent,
            capabilities: {
              supportsContinue: false,
              supportsYolo: false,
              supportsHooks: false,
              supportsTelemetry: false,
              supportsWebSessions: false,
            },
            eventSource: 'parser',
          } satisfies FrameworkInfo,
        ];

  const isTerminal = form.dialogSessionType === 'terminal';
  const remoteNodeSelected =
    environmentModel.selectedNodeId !== DEFAULT_LOCAL_NODE_ID;
  const modeOptions = isTerminal
    ? ([{ value: 'pty', label: 'shell' }] satisfies SessionModeOption[])
    : remoteNodeSelected
      ? ([{ value: 'pty', label: 'tui' }] satisfies SessionModeOption[])
      : getSessionModeOptions(frameworkOptions, form.selectedAgent);
  const selectedFramework = frameworkOptions.find(
    (framework) => framework.id === form.selectedAgent
  );
  const selectedUnavailable =
    !isTerminal &&
    selectedFramework &&
    !isFrameworkAvailable(selectedFramework);
  const selectedWebUnavailable =
    !isTerminal &&
    selectedFramework &&
    form.sessionMode === 'web' &&
    !isFrameworkWebAvailable(selectedFramework);
  const remoteNodeLabel =
    selectedRemoteNode?.displayName ?? environmentModel.selectedNodeId;
  const remoteHomeDir = cleanCwd(selectedRemoteNode?.homeDir);

  return (
    <div className="customize-session-body-fields">
      <div className="customize-session-dialog-field">
        <label
          className="customize-session-dialog-label"
          htmlFor="cs-session-type"
        >
          mode
        </label>
        <select
          id="cs-session-type"
          className="customize-session-dialog-select"
          data-track="dialog.customize-session.session-type"
          value={form.dialogSessionType}
          onChange={(e) => {
            const next = e.currentTarget.value as DialogSessionType;
            onDialogSessionTypeChange(next);
          }}
        >
          <option value="agent">agent</option>
          <option value="terminal">terminal</option>
        </select>
      </div>
      {workspaceName && (
        <p className="customize-session-workspace-name">— {workspaceName}</p>
      )}
      {environmentOptions.length > 0 && (
        <section
          className="customize-session-env-picker"
          aria-label="environment options"
          data-testid="customize-session-env-picker"
        >
          <div className="customize-session-environment-copy">
            choose an environment. stale or offline picks block launch — pick
            another node instead of falling through to a different machine.
          </div>
          <EnvironmentPicker
            options={environmentOptions}
            {...(selectedEnvironmentOptionId
              ? { selectedOptionId: selectedEnvironmentOptionId }
              : {})}
            onSelect={onPickerSelect}
            autoFocusSearch={false}
          />
          {selectedOptionDegradedMessage && (
            <div
              className="customize-session-degraded-chip"
              role="status"
              data-testid="customize-session-degraded-chip"
            >
              launch blocked: {selectedOptionDegradedMessage}
            </div>
          )}
        </section>
      )}
      {(environmentModel.showPicker || remoteNodeSelected) && (
        <section
          className="customize-session-environment-picker"
          aria-label="environment picker"
        >
          <div className="customize-session-environment-copy">
            choose execution node, then directory or git checkout on that node.
            agents are configured separately below.
          </div>
          {environmentModel.repoChoices.length > 1 && (
            <div className="customize-session-dialog-field">
              <label
                className="customize-session-dialog-label"
                htmlFor="cs-repo"
              >
                project
              </label>
              <select
                id="cs-repo"
                className="customize-session-dialog-select"
                data-track="dialog.customize-session.repo"
                value={environmentModel.selectedGroupId ?? ''}
                onChange={(e) =>
                  onEnvironmentChange({
                    selectedGroupId: e.currentTarget.value,
                    selectedNodeId: null,
                    selectedCheckoutId: null,
                  })
                }
              >
                {environmentModel.repoChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(environmentModel.nodeChoices.length > 1 ||
            environmentModel.selectedNodeReason) && (
            <div className="customize-session-dialog-field">
              <label
                className="customize-session-dialog-label"
                htmlFor="cs-node"
              >
                execution node
              </label>
              <select
                id="cs-node"
                className="customize-session-dialog-select"
                data-track="dialog.customize-session.node"
                value={environmentModel.selectedNodeId}
                onChange={(e) =>
                  onEnvironmentChange({
                    selectedNodeId: e.currentTarget.value,
                    selectedCheckoutId: null,
                  })
                }
              >
                {environmentModel.nodeChoices.map((choice) => (
                  <option
                    key={choice.value}
                    value={choice.value}
                    disabled={choice.disabled}
                  >
                    {choice.label}
                    {choice.reason ? ` — ${choice.reason}` : ''}
                  </option>
                ))}
              </select>
              {environmentModel.selectedNodeReason && (
                <div className="customize-session-field-note">
                  {environmentModel.selectedNodeReason}
                </div>
              )}
            </div>
          )}
          {remoteNodeSelected && (
            <div className="customize-session-dialog-field">
              <label
                className="customize-session-dialog-label"
                htmlFor="cs-remote-cwd"
              >
                cwd on {remoteNodeLabel}
              </label>
              <input
                id="cs-remote-cwd"
                type="text"
                className="customize-session-dialog-input"
                data-track="dialog.customize-session.remote-cwd"
                placeholder={remoteHomeDir || 'absolute path on remote node'}
                value={remoteCwd}
                onChange={(e) => onRemoteCwdChange(e.currentTarget.value)}
                autoComplete="off"
              />
              <div className="customize-session-field-note">
                remote sessions start directly in this node-local directory.
              </div>
            </div>
          )}
          {!remoteNodeSelected &&
            environmentModel.checkoutChoices.length > 1 && (
              <div className="customize-session-dialog-field">
                <label
                  className="customize-session-dialog-label"
                  htmlFor="cs-checkout"
                >
                  node-local checkout
                </label>
                <select
                  id="cs-checkout"
                  className="customize-session-dialog-select"
                  data-track="dialog.customize-session.checkout"
                  value={environmentModel.selectedCheckoutId ?? ''}
                  onChange={(e) =>
                    onEnvironmentChange({
                      selectedCheckoutId: e.currentTarget.value,
                    })
                  }
                >
                  {environmentModel.checkoutChoices.map((choice) => (
                    <option
                      key={choice.value}
                      value={choice.value}
                      disabled={choice.disabled}
                    >
                      {choice.label}
                      {choice.reason ? ` — ${choice.reason}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
        </section>
      )}
      {!isTerminal && (
        <AgentOnlyFields
          form={form}
          frameworkOptions={frameworkOptions}
          modeOptions={modeOptions}
          selectedFramework={selectedFramework}
          selectedUnavailable={!!selectedUnavailable}
          selectedWebUnavailable={!!selectedWebUnavailable}
          onFormChange={onFormChange}
        />
      )}
    </div>
  );
}

interface AgentOnlyFieldsProps {
  form: FormState;
  frameworkOptions: FrameworkInfo[];
  modeOptions: SessionModeOption[];
  selectedFramework: FrameworkInfo | undefined;
  selectedUnavailable: boolean;
  selectedWebUnavailable: boolean;
  onFormChange: (patch: Partial<FormState>) => void;
}

function AgentOnlyFields({
  form,
  frameworkOptions,
  modeOptions,
  selectedFramework,
  selectedUnavailable,
  selectedWebUnavailable,
  onFormChange,
}: AgentOnlyFieldsProps) {
  return (
    <>
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-agent">
          agent
        </label>
        <select
          id="cs-agent"
          className="customize-session-dialog-select"
          data-track="dialog.customize-session.agent"
          value={form.selectedAgent}
          onChange={(e) => {
            const selectedAgent = e.currentTarget.value as AgentType;
            onFormChange({
              selectedAgent,
              sessionMode: defaultSessionModeForAgent(
                frameworkOptions,
                selectedAgent
              ),
            });
          }}
        >
          {frameworkOptions.map((framework) => (
            <option
              key={framework.id}
              value={framework.id}
              disabled={!isFrameworkAvailable(framework)}
            >
              {framework.displayName}
              {!isFrameworkAvailable(framework) ? ' (not installed)' : ''}
            </option>
          ))}
        </select>
        {selectedUnavailable && selectedFramework && (
          <div className="customize-session-field-note">
            {selectedFramework.availability?.reason ??
              `${selectedFramework.displayName} is not installed`}
          </div>
        )}
      </div>
      {modeOptions.length > 1 && (
        <div className="customize-session-dialog-field">
          <label className="customize-session-dialog-label" htmlFor="cs-mode">
            interface
          </label>
          <select
            id="cs-mode"
            className="customize-session-dialog-select"
            data-track="dialog.customize-session.mode"
            value={form.sessionMode}
            onChange={(e) =>
              onFormChange({
                sessionMode: e.currentTarget.value as SessionLaunchMode,
              })
            }
          >
            {modeOptions.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>
          {selectedWebUnavailable && selectedFramework && (
            <div className="customize-session-field-note">
              {selectedFramework.webAvailability?.reason ??
                `${selectedFramework.displayName} web runtime is not available`}
            </div>
          )}
        </div>
      )}
      <TuiCheckbox
        checked={form.continueExisting}
        onChange={(checked) => onFormChange({ continueExisting: checked })}
      >
        continue existing session
      </TuiCheckbox>
      <TuiCheckbox
        checked={form.yoloMode}
        onChange={(checked) => onFormChange({ yoloMode: checked })}
      >
        yolo mode (skip permission checks)
      </TuiCheckbox>
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-args">
          extra args (optional)
        </label>
        <input
          id="cs-args"
          type="text"
          className="customize-session-dialog-input"
          placeholder="e.g. --verbose"
          value={form.claudeArgsInput}
          onChange={(e) =>
            onFormChange({ claudeArgsInput: e.currentTarget.value })
          }
          autoComplete="off"
        />
      </div>
    </>
  );
}

function validateAgentFramework(
  frameworks: FrameworkInfo[],
  form: FormState
): string | null {
  if (form.dialogSessionType !== 'agent') return null;
  const selectedFramework = frameworks.find((f) => f.id === form.selectedAgent);
  if (selectedFramework && !isFrameworkAvailable(selectedFramework)) {
    return (
      selectedFramework.availability?.reason ??
      `${selectedFramework.displayName} is not installed`
    );
  }
  if (
    selectedFramework &&
    form.sessionMode === 'web' &&
    !isFrameworkWebAvailable(selectedFramework)
  ) {
    return (
      selectedFramework.webAvailability?.reason ??
      `${selectedFramework.displayName} web runtime is not available`
    );
  }
  return null;
}

/**
 * Map an `EnvironmentOption` (selected via the new #627 picker) back to the
 * legacy `EnvironmentSelection` shape this dialog already uses to drive
 * `buildEnvironmentPickerModel` resolution. Keeping the resolution layer
 * unchanged means the existing session-launch payload tests stay valid; the
 * new picker is purely a richer UI on top.
 *
 * - Group id comes from the inventory groups list (matched by `repoIdentity`
 *   when present, or by `groupId` containing the option's `repoInstanceId`).
 * - Checkout id encodes whether the user picked the repo root
 *   (`repo:<repoInstanceId>`) or a worktree (`worktree:<worktreeInstanceId>`),
 *   mirroring `CHECKOUT_ROOT_PREFIX` / `CHECKOUT_WORKTREE_PREFIX` above.
 */
export function environmentSelectionFromOption(
  option: EnvironmentOption,
  inventory: AggregatedRepoInventoryResponse | null
): EnvironmentSelection {
  let selectedGroupId: string | null = null;
  if (option.repoInstance && inventory) {
    const matching = inventory.groups.find((group) =>
      group.instances.some(
        (instance) =>
          instance.repoInstanceId === option.repoInstance!.repoInstanceId
      )
    );
    selectedGroupId = matching?.groupId ?? null;
  }
  let selectedCheckoutId: string | null = null;
  if (option.bench) {
    selectedCheckoutId = `${CHECKOUT_WORKTREE_PREFIX}${option.bench.worktreeInstanceId}`;
  } else if (option.repoInstance) {
    selectedCheckoutId = `${CHECKOUT_ROOT_PREFIX}${option.repoInstance.repoInstanceId}`;
  }
  return {
    selectedGroupId,
    selectedNodeId: option.node.nodeId,
    selectedCheckoutId,
  };
}

const CustomizeSessionDialog = forwardRef<CustomizeSessionDialogHandle, Props>(
  function CustomizeSessionDialog({ onSessionCreated }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const openRequestIdRef = useRef(0);
    const queryClient = useQueryClient();
    const [workspacePath, setWorkspacePath] = useState('');
    const [worktreePath, setWorktreePath] = useState<string | null>(null);
    const [workspaceName, setWorkspaceName] = useState('');
    const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = useState<
      boolean | undefined
    >(undefined);
    const [form, setForm] = useState<FormState>(defaultForm());
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [inventory, setInventory] =
      useState<AggregatedRepoInventoryResponse | null>(null);
    const [nodes, setNodes] = useState<HubNodeSummary[]>([]);
    const [remoteCwd, setRemoteCwd] = useState('');
    const [environmentSelection, setEnvironmentSelection] =
      useState<EnvironmentSelection>({
        selectedGroupId: null,
        selectedNodeId: null,
        selectedCheckoutId: null,
      });
    const frameworks = useConfigStore((state) => state.frameworks);

    const environmentModel = useMemo(
      () =>
        buildEnvironmentPickerModel({
          inventory,
          nodes,
          selectedAgent: form.selectedAgent,
          selectedGroupId: environmentSelection.selectedGroupId,
          selectedNodeId: environmentSelection.selectedNodeId,
          selectedCheckoutId: environmentSelection.selectedCheckoutId,
          fallbackWorkspace: {
            name: workspaceName,
            path: workspacePath,
            ...(workspaceIsGitRepo !== undefined
              ? { isGitRepo: workspaceIsGitRepo }
              : {}),
          },
          fallbackWorktreePath: worktreePath,
          sessionType: form.dialogSessionType,
        }),
      [
        inventory,
        nodes,
        form.selectedAgent,
        form.dialogSessionType,
        environmentSelection.selectedGroupId,
        environmentSelection.selectedNodeId,
        environmentSelection.selectedCheckoutId,
        workspaceName,
        workspacePath,
        workspaceIsGitRepo,
        worktreePath,
      ]
    );

    // EnvironmentOption[] for the new #627 picker. Derived from the same
    // inventory + nodes data the legacy `environmentModel` consumes, then fed
    // into `pickDefaultEnvironment` (#628) for initial selection. Both paths
    // stay in sync because the picker's `onSelect` patches
    // `environmentSelection`, which `environmentModel` already memoises on.
    const environmentOptions = useMemo<EnvironmentOption[]>(() => {
      if (!workspacePath) return [];
      return buildEnvironmentOptions({
        inventory,
        nodes,
        selectedAgent: form.selectedAgent,
        sessionType: form.dialogSessionType,
        fallbackWorkspace: {
          name: workspaceName,
          path: workspacePath,
          ...(workspaceIsGitRepo !== undefined
            ? { isGitRepo: workspaceIsGitRepo }
            : {}),
        },
        fallbackWorktreePath: worktreePath,
        // Use the inventory's `generatedAt` so options refresh in lockstep
        // with inventory snapshots. When inventory has not loaded yet, fall
        // back to a stable epoch marker so the option still satisfies
        // `isEnvironmentOption` (which requires a non-empty string) without
        // injecting `new Date()` into a memo — non-determinism inside
        // `useMemo` would mint a new timestamp on every render and trip the
        // referential-equality guards downstream (Gemini PR #647 review,
        // matches the same critique on PR #646).
        generatedAt: inventory?.generatedAt ?? PICKER_FALLBACK_GENERATED_AT,
      });
    }, [
      inventory,
      nodes,
      form.selectedAgent,
      form.dialogSessionType,
      workspaceName,
      workspacePath,
      workspaceIsGitRepo,
      worktreePath,
    ]);

    // Track the picker's selected option id. Initial selection comes from
    // `pickDefaultEnvironment` once options are loaded; subsequent changes
    // come from the user clicking the picker.
    const [selectedOptionId, setSelectedOptionId] = useState<string | null>(
      null
    );

    useEffect(() => {
      // Apply safe-defaults whenever the candidate list changes (after
      // inventory/nodes load, or after agent/session-type toggles change
      // which capabilities are required). Do NOT re-pick if the user has
      // already selected an option still present in candidates — that would
      // silently undo their choice on every refetch.
      if (environmentOptions.length === 0) {
        setSelectedOptionId(null);
        return;
      }
      if (
        selectedOptionId &&
        environmentOptions.some((opt) => opt.id === selectedOptionId)
      ) {
        return;
      }
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: [],
        candidates: environmentOptions,
      });
      if (result.kind === 'ok') {
        setSelectedOptionId(result.option.id);
        setEnvironmentSelection(
          environmentSelectionFromOption(result.option, inventory)
        );
      } else {
        // No fresh candidate. Surface the first option so the picker still
        // shows something; the launch button gating below will block submit
        // with the typed reason.
        const first = environmentOptions[0]!;
        setSelectedOptionId(first.id);
        setEnvironmentSelection(
          environmentSelectionFromOption(first, inventory)
        );
      }
    }, [environmentOptions, inventory, selectedOptionId]);

    const selectedEnvironmentOption = useMemo<EnvironmentOption | null>(() => {
      if (!selectedOptionId) return null;
      return (
        environmentOptions.find((opt) => opt.id === selectedOptionId) ?? null
      );
    }, [environmentOptions, selectedOptionId]);

    const selectedOptionDegradedMessage =
      selectedEnvironmentOption &&
      selectedEnvironmentOption.freshness !== 'fresh'
        ? (firstDegradedReasonMessage(
            selectedEnvironmentOption.degradedReasons
          ) ?? `selected environment is ${selectedEnvironmentOption.freshness}`)
        : null;

    const handlePickerSelect = useCallback(
      (option: EnvironmentOption) => {
        setSelectedOptionId(option.id);
        setEnvironmentSelection(
          environmentSelectionFromOption(option, inventory)
        );
      },
      [inventory]
    );

    const remoteNodeSelected =
      environmentModel.selectedNodeId !== DEFAULT_LOCAL_NODE_ID;
    const selectedRemoteNode = remoteNodeSelected
      ? (nodes.find(
          (node) => node.nodeId === environmentModel.selectedNodeId
        ) ?? null)
      : null;
    const selectedRemoteHome = cleanCwd(selectedRemoteNode?.homeDir);

    useEffect(() => {
      return queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] !== 'hub-nodes') return;
        const nextNodes = event.query.state.data;
        if (Array.isArray(nextNodes)) {
          setNodes(nextNodes as HubNodeSummary[]);
        }
      });
    }, [queryClient]);

    useEffect(() => {
      if (!remoteNodeSelected) {
        setRemoteCwd('');
        return;
      }
      setRemoteCwd(
        defaultRemoteCwd(selectedRemoteHome, environmentModel.selectedNodeId)
      );
    }, [
      environmentModel.selectedNodeId,
      remoteNodeSelected,
      selectedRemoteHome,
    ]);

    useImperativeHandle(ref, () => ({
      async open(
        workspace: { name: string; path: string; isGitRepo?: boolean },
        nextWorktreePath?: string | null,
        preselectedFramework?: AgentType
      ) {
        const requestId = ++openRequestIdRef.current;
        setError(null);
        setForm(defaultForm());
        setInventory(null);
        setNodes([]);
        setRemoteCwd('');
        setEnvironmentSelection({
          selectedGroupId: null,
          selectedNodeId: null,
          selectedCheckoutId: null,
        });
        setWorkspacePath(workspace.path);
        setWorktreePath(nextWorktreePath ?? null);
        setWorkspaceName(workspace.name);
        setWorkspaceIsGitRepo(workspace.isGitRepo);
        const [inventoryResult, nodesResult] = await Promise.allSettled([
          fetchRepoInventory(),
          fetchHubNodes(),
        ]);
        if (requestId !== openRequestIdRef.current) return;
        await useConfigStore.getState().refreshConfig();
        if (requestId !== openRequestIdRef.current) return;
        if (inventoryResult.status === 'fulfilled') {
          setInventory(inventoryResult.value);
        }
        if (nodesResult.status === 'fulfilled') {
          queryClient.setQueryData(['hub-nodes'], nodesResult.value);
          setNodes(nodesResult.value);
        }
        const config = useConfigStore.getState();
        const selectedAgent = selectLaunchAgent(
          config.frameworks,
          preselectedFramework ?? (config.defaultAgent as AgentType)
        );
        setForm({
          claudeArgsInput: '',
          selectedAgent,
          sessionMode: defaultSessionModeForAgent(
            config.frameworks,
            selectedAgent
          ),
          yoloMode: config.defaultYolo,
          continueExisting: config.defaultContinue,
          dialogSessionType: 'agent',
        });
        shellRef.current?.open();
      },
      close() {
        shellRef.current?.close();
      },
    }));

    async function handleSubmit(
      remoteCwdOverride?: string,
      rememberCwd = true
    ) {
      if (!workspacePath || creating) return;
      const frameworkError = validateAgentFramework(frameworks, form);
      if (frameworkError) {
        setError(frameworkError);
        return;
      }
      if (environmentModel.selectedNodeReason) {
        setError(environmentModel.selectedNodeReason);
        return;
      }
      // #629: block launch when the selected environment is stale/offline.
      // Never silently switch to a different node — surface the typed reason
      // and require the user to pick another option (or wait for recovery).
      if (selectedOptionDegradedMessage) {
        setError(selectedOptionDegradedMessage);
        return;
      }
      const cwdForRemote = remoteNodeSelected
        ? cleanCwd(remoteCwdOverride ?? remoteCwd)
        : undefined;
      if (remoteNodeSelected && !cwdForRemote) {
        setError('cwd is required for remote node sessions');
        return;
      }
      setCreating(true);
      setError(null);
      const sessionLane: SessionLane = remoteNodeSelected
        ? rememberCwd
          ? 'remote-cwd'
          : 'remote-home'
        : 'local-repo';
      try {
        const { session, error: submitError } = await createSessionFromForm(
          environmentModel.resolved,
          form,
          sessionLane,
          cwdForRemote
        );
        if (submitError && !session) {
          setError(
            submitError instanceof Error
              ? submitError.message
              : 'Failed to create session'
          );
          return;
        }
        if (remoteNodeSelected && cwdForRemote && rememberCwd) {
          rememberRemoteCwd(environmentModel.selectedNodeId, cwdForRemote);
        }
        shellRef.current?.close();
        if (session?.id) onSessionCreated?.(session.id);
      } finally {
        setCreating(false);
      }
    }

    const footer = (
      <div className="customize-session-footer-row">
        <TuiButton
          variant="ghost"
          onClick={() => shellRef.current?.close()}
          disabled={creating}
        >
          Cancel
        </TuiButton>
        {remoteNodeSelected && (
          <TuiButton
            variant="ghost"
            data-track="dialog.customize-session.start-in-home"
            onClick={() => void handleSubmit(selectedRemoteHome, false)}
            disabled={
              !workspacePath ||
              !selectedRemoteHome ||
              Boolean(environmentModel.selectedNodeReason) ||
              Boolean(selectedOptionDegradedMessage) ||
              creating
            }
          >
            Start in Home
          </TuiButton>
        )}
        <TuiButton
          variant="primary"
          data-track="dialog.customize-session.create"
          onClick={() => void handleSubmit()}
          disabled={
            !workspacePath ||
            Boolean(environmentModel.selectedNodeReason) ||
            Boolean(selectedOptionDegradedMessage) ||
            (remoteNodeSelected && !cleanCwd(remoteCwd)) ||
            creating ||
            (form.dialogSessionType === 'agent' &&
              frameworks.some(
                (framework) =>
                  framework.id === form.selectedAgent &&
                  (!isFrameworkAvailable(framework) ||
                    (form.sessionMode === 'web' &&
                      !isFrameworkWebAvailable(framework)))
              ))
          }
        >
          {creating ? 'Creating...' : 'Start Session'}
        </TuiButton>
      </div>
    );

    return (
      <DialogShell
        ref={shellRef}
        width="480px"
        title="Customize Session"
        footer={footer}
      >
        {error && (
          <div className="customize-session-error" role="alert">
            {error}
          </div>
        )}
        <CustomizeSessionBody
          workspaceName={workspaceName}
          form={form}
          environmentModel={environmentModel}
          selectedRemoteNode={selectedRemoteNode}
          remoteCwd={remoteCwd}
          environmentOptions={environmentOptions}
          selectedEnvironmentOptionId={selectedOptionId}
          selectedOptionDegradedMessage={selectedOptionDegradedMessage}
          onPickerSelect={handlePickerSelect}
          onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onEnvironmentChange={(patch) =>
            setEnvironmentSelection((selection) => ({ ...selection, ...patch }))
          }
          onRemoteCwdChange={setRemoteCwd}
          onDialogSessionTypeChange={(t) =>
            setForm((f) => ({ ...f, dialogSessionType: t }))
          }
        />
      </DialogShell>
    );
  }
);

export default CustomizeSessionDialog;
