import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import DialogShell, { type DialogShellHandle } from './DialogShell.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
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
import type { SessionLane } from '../../../../shared/session-lane.js';
import './CustomizeSessionDialog.css';

export interface CustomizeSessionDialogHandle {
  open(
    workspace: { name: string; path: string },
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
  fallbackWorkspace: { name: string; path: string };
  fallbackWorktreePath: string | null;
}

const CHECKOUT_ROOT_PREFIX = 'repo:';
const CHECKOUT_WORKTREE_PREFIX = 'worktree:';

function syntheticLocalNode(selectedAgent: AgentType): HubNodeSummary {
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
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
  workspace: { name: string; path: string },
  worktreePath: string | null
): AggregatedRepoInventoryGroup {
  const repoInstanceId = `${DEFAULT_LOCAL_NODE_ID}:${encodeURIComponent(workspace.path)}`;
  const worktrees = worktreePath
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
        isGitRepo: true,
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
  return group.repoIdentity
    ? `${group.displayName} — ${group.repoIdentity}`
    : `${group.displayName} — unidentified repo`;
}

function capabilityProblem(
  capability: NodeCapabilityStatus | undefined,
  name: string
): string | null {
  if (capability === undefined) return `${name} capability unknown`;
  if (capability === 'available') return null;
  return `${name} ${capability}`;
}

function nodeBlockReason(
  node: HubNodeSummary | null,
  selectedAgent: AgentType
): string | null {
  if (!node) return 'node availability unknown';
  if (node.status === 'offline') return 'node is offline';
  if (node.status === 'stale') return 'heartbeat is stale';
  if (node.status === 'revoked') return 'node is revoked';
  const shellProblem = capabilityProblem(node.capabilities.core.shell, 'shell');
  if (shellProblem) return shellProblem;
  const tmuxProblem = capabilityProblem(node.capabilities.core.tmux, 'tmux');
  if (tmuxProblem) return `${tmuxProblem} on ${node.displayName}`;
  const agentProblem = capabilityProblem(
    node.capabilities.agents[selectedAgent],
    selectedAgent
  );
  return agentProblem ? `${agentProblem} on ${node.displayName}` : null;
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

function nodeMapFor(input: EnvironmentPickerInput): Map<NodeId, HubNodeSummary> {
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
  nodeById: Map<NodeId, HubNodeSummary>
): EnvironmentChoice[] {
  const seenNodeChoices = new Set<NodeId>();
  return nodeChoiceIdsFor(selectedGroup, input.nodes).flatMap((nodeId) => {
    if (seenNodeChoices.has(nodeId)) return [];
    seenNodeChoices.add(nodeId);
    const node = nodeById.get(nodeId) ?? null;
    const reason = nodeBlockReason(node, input.selectedAgent);
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
  const explicit = nodeChoices.find((choice) => choice.value === selectedNodeId);
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
  const groups = environmentGroupsFor(input);
  const selectedGroup = selectedEnvironmentGroup(groups, input);
  const nodeById = nodeMapFor(input);
  const nodeChoices = nodeChoicesFor(selectedGroup, input, nodeById);
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

interface FormState {
  claudeArgsInput: string;
  selectedAgent: AgentType;
  sessionMode: SessionLaunchMode;
  yoloMode: boolean;
  continueExisting: boolean;
}

function defaultForm(): FormState {
  return {
    claudeArgsInput: '',
    selectedAgent: 'claude',
    sessionMode: 'pty',
    yoloMode: false,
    continueExisting: false,
  };
}

async function createSessionFromForm(
  environment: EnvironmentPickerModel['resolved'],
  form: FormState,
  sessionLane: SessionLane,
  remoteCwd?: string
) {
  const claudeArgs = form.claudeArgsInput.trim().split(/\s+/).filter(Boolean);
  const { cols, rows } = estimateTerminalDimensions(
    useUiStore.getState().terminalFontSize
  );
  const baseOptions = {
    nodeId: environment.nodeId,
    type: 'agent' as const,
    mode: form.sessionMode,
    continue: form.continueExisting,
    yolo: form.yoloMode,
    claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
    agent: form.selectedAgent,
    sessionLane,
    cols,
    rows,
  };
  if (environment.nodeId !== DEFAULT_LOCAL_NODE_ID) {
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
  onFormChange: (patch: Partial<FormState>) => void;
  onEnvironmentChange: (patch: Partial<EnvironmentSelection>) => void;
  onRemoteCwdChange: (cwd: string) => void;
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
  onFormChange,
  onEnvironmentChange,
  onRemoteCwdChange,
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

  const modeOptions = getSessionModeOptions(
    frameworkOptions,
    form.selectedAgent
  );
  const selectedFramework = frameworkOptions.find(
    (framework) => framework.id === form.selectedAgent
  );
  const selectedUnavailable =
    selectedFramework && !isFrameworkAvailable(selectedFramework);
  const selectedWebUnavailable =
    selectedFramework &&
    form.sessionMode === 'web' &&
    !isFrameworkWebAvailable(selectedFramework);
  const remoteNodeSelected =
    environmentModel.selectedNodeId !== DEFAULT_LOCAL_NODE_ID;
  const remoteNodeLabel =
    selectedRemoteNode?.displayName ?? environmentModel.selectedNodeId;
  const remoteHomeDir = cleanCwd(selectedRemoteNode?.homeDir);

  return (
    <div className="customize-session-body-fields">
      {workspaceName && (
        <p className="customize-session-workspace-name">— {workspaceName}</p>
      )}
      {(environmentModel.showPicker || remoteNodeSelected) && (
        <section
          className="customize-session-environment-picker"
          aria-label="environment picker"
        >
          <div className="customize-session-environment-copy">
            choose repo identity, execution node, then node-local checkout. no
            live cross-host pty migration or automatic filesystem sync.
          </div>
          {environmentModel.repoChoices.length > 1 && (
            <div className="customize-session-dialog-field">
              <label
                className="customize-session-dialog-label"
                htmlFor="cs-repo"
              >
                repo identity
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
      <div className="customize-session-dialog-field">
        <label className="customize-session-dialog-label" htmlFor="cs-agent">
          coding agent
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
        {selectedUnavailable && (
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
          {selectedWebUnavailable && (
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
    </div>
  );
}

const CustomizeSessionDialog = forwardRef<CustomizeSessionDialogHandle, Props>(
  function CustomizeSessionDialog({ onSessionCreated }, ref) {
    const shellRef = useRef<DialogShellHandle>(null);
    const openRequestIdRef = useRef(0);
    const [workspacePath, setWorkspacePath] = useState('');
    const [worktreePath, setWorktreePath] = useState<string | null>(null);
    const [workspaceName, setWorkspaceName] = useState('');
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
          fallbackWorkspace: { name: workspaceName, path: workspacePath },
          fallbackWorktreePath: worktreePath,
        }),
      [
        inventory,
        nodes,
        form.selectedAgent,
        environmentSelection.selectedGroupId,
        environmentSelection.selectedNodeId,
        environmentSelection.selectedCheckoutId,
        workspaceName,
        workspacePath,
        worktreePath,
      ]
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
        workspace: { name: string; path: string },
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
      const selectedFramework = frameworks.find(
        (framework) => framework.id === form.selectedAgent
      );
      if (selectedFramework && !isFrameworkAvailable(selectedFramework)) {
        setError(
          selectedFramework.availability?.reason ??
            `${selectedFramework.displayName} is not installed`
        );
        return;
      }
      if (
        selectedFramework &&
        form.sessionMode === 'web' &&
        !isFrameworkWebAvailable(selectedFramework)
      ) {
        setError(
          selectedFramework.webAvailability?.reason ??
            `${selectedFramework.displayName} web runtime is not available`
        );
        return;
      }
      if (environmentModel.selectedNodeReason) {
        setError(environmentModel.selectedNodeReason);
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
            (remoteNodeSelected && !cleanCwd(remoteCwd)) ||
            creating ||
            frameworks.some(
              (framework) =>
                framework.id === form.selectedAgent &&
                (!isFrameworkAvailable(framework) ||
                  (form.sessionMode === 'web' &&
                    !isFrameworkWebAvailable(framework)))
            )
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
          onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onEnvironmentChange={(patch) =>
            setEnvironmentSelection((selection) => ({ ...selection, ...patch }))
          }
          onRemoteCwdChange={setRemoteCwd}
        />
      </DialogShell>
    );
  }
);

export default CustomizeSessionDialog;
