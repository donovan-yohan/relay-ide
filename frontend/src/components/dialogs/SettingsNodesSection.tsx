import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HubNodeSummary } from '../../../../shared/relay-node-protocol.js';
import type {
  NodePairingRequestSummary,
  NodePairingTrustProfile,
} from '../../../../shared/node-pairing-requests.js';
import {
  NODE_PAIRING_TRUST_PROFILES,
  nodePairingCapabilityPosture,
} from '../../../../shared/node-pairing-requests.js';
import type { RelayCapabilityBit } from '../../../../shared/security-policy.js';
import {
  approveNodePairingRequest,
  clearHubNodeRotationFailure,
  createSession,
  denyNodePairingRequest,
  editNodePairingRequestAccess,
  fetchHubNodes,
  fetchNodePairingRequests,
  HttpError,
  revokeHubNode,
  rotateHubNodeCredential,
  type NodePairingAccessEditRequest,
} from '../../lib/api.js';
import TuiButton from '../TuiButton.js';
import { nodeShellBlockReason } from './CustomizeSessionDialog.js';
import './SettingsNodesSection.css';

const SECTION_ACTION_ID = 'settings.nodes';
const QUERY_NODES = ['hub-nodes'] as const;
const QUERY_PAIRING = ['node-pairing-requests', 'settings-nodes'] as const;
const SETTINGS_NODES_SEARCH_TERMS = [
  'nodes',
  'node',
  'pair',
  'pair device',
  'add node',
  'pending request',
  'device code',
  'rotate credential',
  'revoke',
  'offline',
  'stale',
  'remote',
];

const TRUST_PROFILE_LABELS: Record<NodePairingTrustProfile, string> = {
  'dev-workstation': 'dev workstation',
  'sandbox-runner': 'sandbox runner',
  'automation-runner': 'automation runner',
  'infra-prod-host': 'infra / prod host',
};

const TRUST_PROFILE_COPY: Record<
  NodePairingTrustProfile,
  { can: string; never: string; typeSummary: string }
> = {
  'dev-workstation': {
    typeSummary: 'personal machine for terminals, agents, repo work',
    can: 'launch terminal sessions, read/write approved repo roots, run git, launch configured agent CLIs',
    never: 'no access outside approved roots, no silent capability changes',
  },
  'sandbox-runner': {
    typeSummary: 'disposable workspace with narrower access',
    can: 'run bounded sessions and read approved roots; write/exec only when explicitly granted',
    never: 'no broad host access, no silent capability changes',
  },
  'automation-runner': {
    typeSummary: 'automation host for approved jobs and artifacts',
    can: 'run approved automation and publish artifacts',
    never:
      'no broad interactive shell by default, no silent capability changes',
  },
  'infra-prod-host': {
    typeSummary: 'high-risk host; approvals can require confirmation',
    can: 'perform explicitly approved actions with stricter confirmation where required',
    never: 'no silent prod access, no capability upgrades without re-approval',
  },
};

export type NodeAttentionGroup =
  | 'needs-attention'
  | 'degraded'
  | 'offline-stale'
  | 'online'
  | 'revoked';

interface NodeGroup {
  key: NodeAttentionGroup;
  label: string;
  nodes: HubNodeSummary[];
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function sectionClass(query: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return 'settings-dialog-section';
  const matches = SETTINGS_NODES_SEARCH_TERMS.some(
    (term) => term.includes(q) || q.includes(term)
  );
  return ['settings-dialog-section', matches ? '' : 'dimmed']
    .filter(Boolean)
    .join(' ');
}

function formatProfile(
  profile: NodePairingTrustProfile | string | undefined
): string {
  if (!profile) return 'not reported';
  return (
    TRUST_PROFILE_LABELS[profile as NodePairingTrustProfile] ??
    profile.replace(/-/g, ' ')
  );
}

function shortHandle(
  value: string | undefined,
  fallback = 'not reported'
): string {
  if (!value) return fallback;
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatDateDistance(
  value: string | undefined,
  now = Date.now()
): string {
  if (!value) return 'not reported';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'not reported';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatExpires(value: string): string {
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function sourceSignal(
  source:
    | NodePairingRequestSummary['sourceDiagnostics']
    | HubNodeSummary['sourceDiagnostics']
): string {
  if (!source) return 'source signal not reported';
  const parts = [source.state.replace(/-/g, ' ')];
  if (source.sourceFingerprint)
    parts.push(shortHandle(source.sourceFingerprint));
  if (source.displayHint) parts.push(source.displayHint);
  return parts.join(' · ');
}

function nodeCapabilityPosture(node: HubNodeSummary): string[] {
  const allowed = node.trust.policy?.allowed ?? [];
  if (allowed.length > 0) {
    return nodePairingCapabilityPosture(allowed as RelayCapabilityBit[]).slice(
      0,
      6
    );
  }
  const labels: string[] = [];
  if (node.capabilities.core.shell === 'available')
    labels.push('launch terminal sessions');
  if (node.capabilities.core.git === 'available') labels.push('run git');
  if (node.capabilities.terminalBackends?.['relay-pty'] === 'available')
    labels.push('attach/detach sessions');
  if (labels.length === 0) labels.push('capabilities not reported');
  return labels;
}

function nodeAllowedRoots(node: HubNodeSummary): string {
  const roots = node.trust.policy?.scope.pathPrefixes ?? [];
  return roots.length > 0
    ? roots.map((root) => shortHandle(root)).join(', ')
    : 'not reported';
}

function nodeHasSourceWarning(node: HubNodeSummary): boolean {
  return (
    node.sourceDiagnostics?.state === 'source-mismatch' ||
    node.sourceDiagnostics?.state === 'same-credential-multiple-sources' ||
    node.sourceDiagnostics?.state === 'strict-deny'
  );
}

function nodeHasDegradedSignal(node: HubNodeSummary): boolean {
  return (
    node.status === 'updating' ||
    node.version.state === 'version-skew' ||
    node.helperSkew?.category === 'minor-skew-warn' ||
    node.helperSkew?.category === 'major-skew-error' ||
    (node.degradedReasons?.length ?? 0) > 0 ||
    nodeHasSourceWarning(node)
  );
}

function degradedReason(node: HubNodeSummary): string {
  return (
    node.helperSkew?.message ??
    node.degradedReasons?.[0]?.description ??
    (nodeHasSourceWarning(node)
      ? 'source signal needs investigation'
      : 'node is reachable with degraded capability')
  );
}

function nodeLifecycle(node: HubNodeSummary): {
  group: NodeAttentionGroup;
  label: string;
  reason: string;
} {
  if (node.status === 'revoked' || node.credentialState === 'revoked') {
    return {
      group: 'revoked',
      label: 'revoked',
      reason:
        'active links closed, reconnect blocked. local files on the node are not deleted.',
    };
  }
  if (node.credentialState === 'rotation-failed') {
    return {
      group: 'needs-attention',
      label: 'rotation-degraded',
      reason:
        "credential rotation didn't complete; previous credential is still active.",
    };
  }
  if (node.credentialState === 'rotating') {
    return {
      group: 'needs-attention',
      label: 'rotating',
      reason:
        'rotating credential; old credential remains valid until the node confirms.',
    };
  }
  if (node.version.state === 'incompatible') {
    return {
      group: 'needs-attention',
      label: 're-pair required',
      reason:
        'protocol incompatible; run the pair command again after updating.',
    };
  }
  if (node.status === 'offline') {
    return {
      group: 'offline-stale',
      label: 'offline',
      reason: 'routed sessions unavailable until the node link is running.',
    };
  }
  if (node.status === 'stale') {
    return {
      group: 'offline-stale',
      label: 'stale',
      reason: 'heartbeat is stale; the node may have lost its link.',
    };
  }
  if (nodeHasDegradedSignal(node)) {
    return {
      group: 'degraded',
      label: 'degraded',
      reason: degradedReason(node),
    };
  }
  return { group: 'online', label: 'online', reason: 'ready for routed work' };
}

export function groupSettingsNodes(nodes: HubNodeSummary[]): NodeGroup[] {
  const grouped: Record<NodeAttentionGroup, HubNodeSummary[]> = {
    'needs-attention': [],
    degraded: [],
    'offline-stale': [],
    online: [],
    revoked: [],
  };
  for (const node of nodes) grouped[nodeLifecycle(node).group].push(node);
  const ordered: NodeGroup[] = [
    {
      key: 'needs-attention',
      label: 'needs attention',
      nodes: grouped['needs-attention'],
    },
    { key: 'degraded', label: 'degraded', nodes: grouped.degraded },
    {
      key: 'offline-stale',
      label: 'offline / stale',
      nodes: grouped['offline-stale'],
    },
    { key: 'online', label: 'online', nodes: grouped.online },
    { key: 'revoked', label: 'revoked / history', nodes: grouped.revoked },
  ];
  return ordered.filter((group) => group.nodes.length > 0);
}

interface MutationStatus {
  busyId: string | null;
  message: string;
  error: string;
}

interface PendingNodeRequestCardProps {
  request: NodePairingRequestSummary;
  mutationStatus?: MutationStatus;
  onApprove?: (
    request: NodePairingRequestSummary,
    edit?: NodePairingAccessEditRequest
  ) => void;
  onDeny?: (request: NodePairingRequestSummary) => void;
  onEdit?: (
    request: NodePairingRequestSummary,
    edit: NodePairingAccessEditRequest
  ) => void;
}

function requestTerminalCopy(request: NodePairingRequestSummary): string {
  if (request.state === 'pending')
    return `${request.displayName} wants to pair — expires in ${formatExpires(request.expiresAt)}`;
  if (request.state === 'approved')
    return request.credentialId
      ? `${request.displayName} paired`
      : `approved as ${request.displayName} — issuing credential`;
  if (request.state === 'denied')
    return 'pairing denied. the device was told no credential was issued.';
  return 'this pairing request expired. run the pair command again to get a fresh code.';
}

export function PendingNodeRequestCard({
  request,
  mutationStatus,
  onApprove,
  onDeny,
  onEdit,
}: PendingNodeRequestCardProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(request.displayName);
  const [profile, setProfile] = useState<NodePairingTrustProfile>(
    request.requestedProfile
  );
  const [rootsText, setRootsText] = useState(request.requestedRoots.join('\n'));
  const isPending = request.state === 'pending';
  const busy = mutationStatus?.busyId === request.requestId;
  const canApprove = isPending && !busy && Boolean(onApprove);
  const canDeny = isPending && !busy && Boolean(onDeny);
  const canEdit = isPending && !busy && Boolean(onEdit);
  const edit: NodePairingAccessEditRequest = {
    displayName: displayName.trim(),
    requestedProfile: profile,
    requestedRoots: rootsText
      .split('\n')
      .map((root) => root.trim())
      .filter(Boolean),
  };
  return (
    <article
      className={`settings-nodes-card request-${request.state}`}
      data-node-action-id="settings.nodes.pending-request"
    >
      <div className="settings-nodes-card__header">
        <div>
          <h4>{request.displayName} wants to pair</h4>
          <p>{requestTerminalCopy(request)}</p>
        </div>
        <span className={`settings-nodes-state state-${request.state}`}>
          {request.state}
        </span>
      </div>
      <div className="settings-nodes-grid">
        <span>platform</span>
        <b>
          {request.platform} · Relay {request.relayVersion}
        </b>
        <span>device code</span>
        <b>{request.deviceCode}</b>
        <span>source signal</span>
        <b>{sourceSignal(request.sourceDiagnostics)}</b>
        <span>requested profile</span>
        <b>{formatProfile(request.requestedProfile)}</b>
        <span>requested access</span>
        <b>{request.requestedCapabilities.join(', ') || 'not reported'}</b>
        <span>requested roots</span>
        <b>{request.requestedRoots.join(', ') || 'not reported'}</b>
        <span>key fp</span>
        <b>{shortHandle(request.publicKeyFingerprint)}</b>
      </div>
      <p className="settings-nodes-warning">
        approved nodes can execute code as the local OS user inside their
        allowed roots. approve only if you recognize this device.
      </p>
      {request.requiresExactOperationApproval && (
        <p className="settings-nodes-notice">
          higher-risk approval: this request can require exact-operation
          confirmation before a credential is issued.
        </p>
      )}
      {editing && isPending && (
        <div className="settings-nodes-edit-panel">
          <label>
            display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
            />
          </label>
          <label>
            trust profile
            <select
              value={profile}
              onChange={(e) =>
                setProfile(e.currentTarget.value as NodePairingTrustProfile)
              }
            >
              {NODE_PAIRING_TRUST_PROFILES.map((option) => (
                <option key={option} value={option}>
                  {formatProfile(option)}
                </option>
              ))}
            </select>
          </label>
          <label>
            allowed roots
            <textarea
              value={rootsText}
              onChange={(e) => setRootsText(e.currentTarget.value)}
              placeholder="~/code"
            />
          </label>
        </div>
      )}
      {mutationStatus?.message && busy && (
        <p className="settings-nodes-status-msg">{mutationStatus.message}</p>
      )}
      {mutationStatus?.error && busy && (
        <p className="settings-nodes-error-msg">{mutationStatus.error}</p>
      )}
      {isPending && (
        <div className="settings-nodes-actions">
          <TuiButton
            size="sm"
            variant="success"
            disabled={!canApprove}
            onClick={() => onApprove?.(request, editing ? edit : undefined)}
          >
            approve
          </TuiButton>
          <TuiButton
            size="sm"
            variant="danger"
            disabled={!canDeny}
            onClick={() => onDeny?.(request)}
          >
            deny
          </TuiButton>
          <TuiButton
            size="sm"
            variant="ghost"
            disabled={!canEdit}
            onClick={() =>
              editing ? onEdit?.(request, edit) : setEditing(true)
            }
          >
            {editing ? 'save access' : 'edit access'}
          </TuiButton>
          {editing && (
            <TuiButton
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              cancel
            </TuiButton>
          )}
        </div>
      )}
    </article>
  );
}

interface PairedNodeCardProps {
  node: HubNodeSummary;
  mutationStatus?: MutationStatus;
  onOpenTerminal?: (node: HubNodeSummary) => void;
  onRotate?: (node: HubNodeSummary) => void;
  onClearRotation?: (node: HubNodeSummary) => void;
  onRevoke?: (node: HubNodeSummary) => void;
}

export function PairedNodeCard({
  node,
  mutationStatus,
  onOpenTerminal,
  onRotate,
  onClearRotation,
  onRevoke,
}: PairedNodeCardProps): ReactElement {
  const lifecycle = nodeLifecycle(node);
  const shellBlock = nodeShellBlockReason(node);
  const canOpen =
    node.status === 'online' &&
    !shellBlock &&
    node.credentialState !== 'revoked';
  const busy = mutationStatus?.busyId === node.nodeId;
  const revoked =
    node.status === 'revoked' || node.credentialState === 'revoked';
  const canRevoke = !busy && !revoked && Boolean(onRevoke);
  const posture = nodeCapabilityPosture(node);
  return (
    <article
      className={`settings-nodes-card node-${lifecycle.group}`}
      data-node-action-id="settings.nodes.paired-node"
    >
      <div className="settings-nodes-card__header">
        <div>
          <h4>{node.displayName || node.nodeId}</h4>
          <p>{lifecycle.reason}</p>
        </div>
        <span className={`settings-nodes-state state-${lifecycle.group}`}>
          {lifecycle.label}
        </span>
      </div>
      <div className="settings-nodes-grid">
        <span>node id</span>
        <b>{shortHandle(node.nodeId)}</b>
        <span>trust profile</span>
        <b>{node.trust.tier ?? node.trust.level ?? 'not reported'}</b>
        <span>capability scope</span>
        <b>{posture.join(', ')}</b>
        <span>allowed roots</span>
        <b>{nodeAllowedRoots(node)}</b>
        <span>last seen</span>
        <b>{formatDateDistance(node.lastSeenAt)}</b>
        <span>source signal</span>
        <b>{sourceSignal(node.sourceDiagnostics)}</b>
        <span>credential</span>
        <b>
          {node.credentialState}
          {node.credentialRotation ? ` · ${node.credentialRotation.state}` : ''}
        </b>
        <span>service</span>
        <b>{node.capabilities.serviceManager || 'manual'}</b>
      </div>
      {(node.degradedReasons?.length ?? 0) > 0 && (
        <details className="settings-nodes-details">
          <summary>degraded reasons</summary>
          {node.degradedReasons!.map((reason) => (
            <p key={reason.code}>
              {reason.code}: {reason.description}
            </p>
          ))}
        </details>
      )}
      <details className="settings-nodes-details">
        <summary>install / service instructions</summary>
        <pre>{`to keep this node linked across reboots, install it as a service:\n  macOS:        relay-ide node install --hub <hub> --service launchd\n  linux:        relay-ide node install --hub <hub> --service systemd-user\n  wsl2 systemd: relay-ide node install --hub <hub> --service wsl-systemd\n  any platform: relay-ide node install --hub <hub> --service manual\n\nthen hold the link:\n  relay-ide node link --hub <hub>`}</pre>
      </details>
      {mutationStatus?.message && busy && (
        <p className="settings-nodes-status-msg">{mutationStatus.message}</p>
      )}
      {mutationStatus?.error && busy && (
        <p className="settings-nodes-error-msg">{mutationStatus.error}</p>
      )}
      <div className="settings-nodes-actions">
        <TuiButton
          size="sm"
          variant="primary"
          disabled={!canOpen || busy}
          tooltip={
            canOpen
              ? 'open terminal on this node'
              : (shellBlock ?? 'node unavailable')
          }
          onClick={() => onOpenTerminal?.(node)}
        >
          open terminal
        </TuiButton>
        <TuiButton
          size="sm"
          variant="info"
          disabled={busy || revoked}
          onClick={() => onRotate?.(node)}
        >
          rotate credential
        </TuiButton>
        {node.credentialState === 'rotation-failed' && (
          <TuiButton
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onClearRotation?.(node)}
          >
            clear rotation failure
          </TuiButton>
        )}
        <TuiButton
          size="sm"
          variant="danger"
          disabled={!canRevoke}
          tooltip={
            revoked
              ? 'node credential already revoked'
              : onRevoke
                ? 'revoke this node credential'
                : 'revoke handler unavailable'
          }
          onClick={() => onRevoke?.(node)}
        >
          revoke
        </TuiButton>
      </div>
      <p className="settings-nodes-notice">
        revoke: active links close immediately and reconnect is blocked. local
        files on that machine are not deleted. re-pairing requires operator
        approval before this node can connect again.
      </p>
    </article>
  );
}

function AddNodeWizard({
  requests,
}: {
  requests: NodePairingRequestSummary[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [profile, setProfile] =
    useState<NodePairingTrustProfile>('dev-workstation');
  const pending = requests.find((request) => request.state === 'pending');
  const command = 'relay-ide node pair <hub-url>';
  const steps = [
    'choose node type',
    'choose trust profile',
    'copy pair command',
    'incoming pairing request',
    'post-approval next action',
  ];
  if (!open) {
    return (
      <TuiButton
        variant="primary"
        onClick={() => setOpen(true)}
        data-node-action-id="settings.nodes.add-node"
      >
        add node
      </TuiButton>
    );
  }
  return (
    <div
      className="settings-nodes-wizard"
      data-node-action-id="settings.nodes.add-node-wizard"
    >
      <div className="settings-nodes-wizard__top">
        <h4>add node</h4>
        <TuiButton size="sm" variant="ghost" onClick={() => setOpen(false)}>
          close
        </TuiButton>
      </div>
      <ol className="settings-nodes-steps">
        {steps.map((label, index) => (
          <li key={label} className={index === step ? 'active' : ''}>
            {label}
          </li>
        ))}
      </ol>
      {step === 0 && (
        <div className="settings-nodes-profile-grid">
          {NODE_PAIRING_TRUST_PROFILES.map((option) => (
            <button
              key={option}
              type="button"
              className={profile === option ? 'selected' : ''}
              onClick={() => {
                setProfile(option);
                setStep(1);
              }}
            >
              <b>{formatProfile(option)}</b>
              <span>{TRUST_PROFILE_COPY[option].typeSummary}</span>
            </button>
          ))}
        </div>
      )}
      {step === 1 && (
        <div className="settings-nodes-copy-block">
          <p>
            <b>can:</b> {TRUST_PROFILE_COPY[profile].can}
          </p>
          <p>
            <b>never:</b> {TRUST_PROFILE_COPY[profile].never}
          </p>
          {profile === 'infra-prod-host' && (
            <p>
              approved actions on a prod host can still require a per-operation
              confirmation before they run.
            </p>
          )}
          <p>
            allowed roots are set when the incoming request is approved, so the
            pair command stays copy-safe.
          </p>
        </div>
      )}
      {step === 2 && (
        <div className="settings-nodes-copy-block">
          <p>
            run this on the device you want to pair. the command does not
            include a pair token.
          </p>
          <code>{command}</code>
          <pre>{`to keep this node linked across reboots, install it as a service:\n  relay-ide node install --hub <hub> --service <launchd|systemd-user|manual>`}</pre>
        </div>
      )}
      {step === 3 && (
        <div className="settings-nodes-copy-block">
          {pending ? (
            <>
              <p>incoming request detected:</p>
              <PendingNodeRequestCard request={pending} />
            </>
          ) : (
            <p>
              waiting for this device to check in. pending requests stay visible
              below if you close this wizard.
            </p>
          )}
        </div>
      )}
      {step === 4 && (
        <div className="settings-nodes-copy-block">
          <p>
            after approval, open a terminal only when the node link is online.
            if it is pair-only, start the link with:
          </p>
          <code>relay-ide node link --hub &lt;hub&gt;</code>
        </div>
      )}
      <div className="settings-nodes-actions">
        <TuiButton
          size="sm"
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}
        >
          back
        </TuiButton>
        <TuiButton
          size="sm"
          variant="primary"
          disabled={step === steps.length - 1}
          onClick={() =>
            setStep((value) => Math.min(steps.length - 1, value + 1))
          }
        >
          next
        </TuiButton>
      </div>
    </div>
  );
}

function SettingsNodesState({
  kind,
  children,
}: {
  kind?: 'error';
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={`settings-nodes-state-panel${kind === 'error' ? ' is-error' : ''}`}
    >
      {children}
    </div>
  );
}

export function SettingsNodesSection({
  searchQuery,
}: {
  searchQuery: string;
}): ReactElement {
  const queryClient = useQueryClient();
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutationRunRef = useRef(0);
  const [status, setStatus] = useState<MutationStatus>({
    busyId: null,
    message: '',
    error: '',
  });
  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);
  const nodesQuery = useQuery({
    queryKey: QUERY_NODES,
    queryFn: fetchHubNodes,
    staleTime: 10_000,
    retry: false,
  });
  const requestsQuery = useQuery({
    queryKey: QUERY_PAIRING,
    queryFn: () => fetchNodePairingRequests({ includeResolved: true }),
    staleTime: 5_000,
    retry: false,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: QUERY_NODES }),
      queryClient.invalidateQueries({ queryKey: QUERY_PAIRING }),
    ]);
  const mutation = useMutation({
    onMutate: () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      mutationRunRef.current += 1;
      return { runId: mutationRunRef.current };
    },
    mutationFn: async (action: {
      kind:
        | 'approve'
        | 'deny'
        | 'edit'
        | 'rotate'
        | 'clear'
        | 'open'
        | 'revoke';
      request?: NodePairingRequestSummary;
      node?: HubNodeSummary;
      edit?: NodePairingAccessEditRequest;
    }) => {
      setStatus({
        busyId: action.request?.requestId ?? action.node?.nodeId ?? null,
        message: '',
        error: '',
      });
      if (action.kind === 'approve' && action.request)
        return approveNodePairingRequest(
          action.request.requestId,
          action.edit ?? {}
        );
      if (action.kind === 'deny' && action.request)
        return denyNodePairingRequest(
          action.request.requestId,
          'denied from settings nodes'
        );
      if (action.kind === 'edit' && action.request && action.edit)
        return editNodePairingRequestAccess(
          action.request.requestId,
          action.edit
        );
      if (action.kind === 'rotate' && action.node)
        return rotateHubNodeCredential(action.node.nodeId, 'online');
      if (action.kind === 'revoke' && action.node)
        return revokeHubNode(action.node.nodeId);
      if (action.kind === 'clear' && action.node)
        return clearHubNodeRotationFailure(action.node.nodeId);
      if (action.kind === 'open' && action.node)
        return createSession({ type: 'terminal', nodeId: action.node.nodeId });
      throw new Error('unsupported node action');
    },
    onSuccess: async () => {
      setStatus((s) => ({ ...s, message: 'updated' }));
      await refresh();
    },
    onError: (error) =>
      setStatus((s) => ({
        ...s,
        error: errorMessage(error, 'node action failed'),
      })),
    onSettled: (_data, _error, _variables, context) => {
      if (context?.runId !== mutationRunRef.current) return;
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        setStatus({ busyId: null, message: '', error: '' });
        clearTimerRef.current = null;
      }, 2500);
    },
  });
  const pendingRequests = (requestsQuery.data ?? []).filter(
    (request) => request.state === 'pending'
  );
  const resolvedRequests = (requestsQuery.data ?? [])
    .filter((request) => request.state !== 'pending')
    .slice(0, 4);
  const groups = useMemo(
    () => groupSettingsNodes(nodesQuery.data ?? []),
    [nodesQuery.data]
  );
  const loading = nodesQuery.isLoading || requestsQuery.isLoading;
  const failed = nodesQuery.isError || requestsQuery.isError;
  return (
    <section
      id="section-nodes"
      className={sectionClass(searchQuery)}
      data-settings-section="nodes"
      data-action-id={SECTION_ACTION_ID}
    >
      <h3 className="settings-dialog-section-heading">nodes</h3>
      <div className="settings-nodes-section">
        <div className="settings-nodes-intro">
          <div>
            <p>
              nodes are machines paired to this hub that can run terminals,
              agents, and repo work.
            </p>
            <p>
              device codes locate pending requests; operator approval issues the
              key-bound credential.
            </p>
          </div>
          <AddNodeWizard requests={requestsQuery.data ?? []} />
        </div>
        {loading && (
          <SettingsNodesState>loading node lifecycle...</SettingsNodesState>
        )}
        {failed && (
          <SettingsNodesState kind="error">
            nodes unavailable:{' '}
            {errorMessage(
              nodesQuery.error ?? requestsQuery.error,
              'api unavailable'
            )}{' '}
            <button type="button" onClick={() => void refresh()}>
              retry
            </button>
          </SettingsNodesState>
        )}
        {!loading &&
          !failed &&
          pendingRequests.length === 0 &&
          (nodesQuery.data?.length ?? 0) === 0 && (
            <SettingsNodesState>
              no paired nodes yet. add node to pair a device with this hub.
            </SettingsNodesState>
          )}
        {!loading && !failed && pendingRequests.length > 0 && (
          <div className="settings-nodes-group">
            <h4>pending requests</h4>
            {pendingRequests.map((request) => (
              <PendingNodeRequestCard
                key={request.requestId}
                request={request}
                mutationStatus={status}
                onApprove={(req, edit) =>
                  mutation.mutate({
                    kind: 'approve',
                    request: req,
                    ...(edit ? { edit } : {}),
                  })
                }
                onDeny={(req) =>
                  mutation.mutate({ kind: 'deny', request: req })
                }
                onEdit={(req, edit) =>
                  mutation.mutate({ kind: 'edit', request: req, edit })
                }
              />
            ))}
          </div>
        )}
        {!loading &&
          !failed &&
          groups.map((group) => (
            <div key={group.key} className="settings-nodes-group">
              <h4>{group.label}</h4>
              {group.nodes.map((node) => (
                <PairedNodeCard
                  key={node.nodeId}
                  node={node}
                  mutationStatus={status}
                  onOpenTerminal={(n) =>
                    mutation.mutate({ kind: 'open', node: n })
                  }
                  onRotate={(n) => {
                    if (
                      window.confirm(
                        'Rotate this node credential? The old credential remains valid until the node confirms the new one.'
                      )
                    )
                      mutation.mutate({ kind: 'rotate', node: n });
                  }}
                  onClearRotation={(n) =>
                    mutation.mutate({ kind: 'clear', node: n })
                  }
                  onRevoke={(n) => {
                    if (
                      window.confirm(
                        'Revoke this node credential? Active links close immediately and reconnect is blocked. Local files on that machine are not deleted. Re-pairing requires operator approval before this node can connect again.'
                      )
                    )
                      mutation.mutate({ kind: 'revoke', node: n });
                  }}
                />
              ))}
            </div>
          ))}
        {!loading && !failed && resolvedRequests.length > 0 && (
          <div className="settings-nodes-group">
            <h4>recent pairing history</h4>
            {resolvedRequests.map((request) => (
              <PendingNodeRequestCard
                key={request.requestId}
                request={request}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default SettingsNodesSection;
