import { DSH_CHANNEL_COMMAND } from './launch-commands.js';
import { buildChildEnv } from './adapter-utils.js';
import { objectField as record, stringField as string } from './wire-values.js';
import type { AdapterConfig } from '../protocol-adapter-v2.js';
import type {
  AgentApprovalSupportV2,
  AgentCapabilitySetV2,
} from '../../shared/agent-chat-protocol-v2.js';
import {
  AcpProtocolAdapter,
  type AcpHarnessProfile,
  type ClientFactory,
} from './acp-adapter.js';

/**
 * Honest capabilities for the DeepSeek Harness ACP lane (`dsh --profile acp`).
 *
 * The `true`s that carry weight, and where they come from on the wire:
 *  - `interrupt`: `session/cancel` is a real cancellation — the in-flight
 *    `session/prompt` settles with `stopReason: 'cancelled'`. Nothing is killed.
 *  - `resume`: `initialize` advertises `sessionCapabilities.resume`, and a
 *    closed session reopened with `session/resume` still remembers its history.
 *  - `approvals`: the server sends `session/request_permission` as a
 *    server-to-client REQUEST and blocks the turn until it is answered.
 *
 * The `false`s are the ACP server's own documented non-surface: it omits or
 * rejects `session/load`, deletion, fork, modes, commands, plans, terminals,
 * client filesystem operations, and elicitation.
 */
const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: false,
  plans: false,
  slashCommands: false,
  queue: true,
  steer: false,
  cancelQueued: false,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: true,
  rateLimits: false,
  streaming: true,
} satisfies Required<AgentCapabilitySetV2>;

/**
 * The permission choices the harness offers, byte for byte
 * (`packages/acp/acp/src/index.ts`, the `approval/request` bridge). It
 * hard-codes exactly these two one-shot options and infers no durable grant, so
 * Relay advertises `once` alone: an `allow-always` decision has nowhere to go.
 */
const DSH_ALLOW_OPTION_ID = 'allow-once';
const DSH_REJECT_OPTION_ID = 'reject-once';
const DSH_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once'],
  amendmentTypes: [],
  canCancel: true,
};

/** Native tool names Relay renders as a command card. */
const COMMAND_TOOL_NAMES = new Set(['bash', 'pwsh', 'terminal_bash']);
/** Native tool names Relay renders as a file-change card. */
const FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
]);

const DSH_PROFILE: AcpHarnessProfile = {
  agentType: 'dsh',
  displayName: 'dsh',
  capabilities: CAPABILITIES,
  providerNamespace: 'dsh',
  providerSessionKey: 'dshSessionId',
  extensionNamespace: 'dsh',
  otherKindHeuristics: false,
  commandToolNames: COMMAND_TOOL_NAMES,
  fileToolNames: FILE_TOOL_NAMES,
  fileEditStatus: 'edited',
  approvalSupport: DSH_APPROVAL_SUPPORT,
  command: DSH_CHANNEL_COMMAND,
  args: () => ['--profile', 'acp'],
  resumeStrategy: 'resume',
  firstUpdateTimeoutMs: 120_000,
  buildEnv: (config: AdapterConfig) => {
    // No provider extras in the denylist: the harness reads its credentials
    // from `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`, which a named profile MUST
    // stay able to set. Only the universal nesting set is stripped.
    const env = buildChildEnv({ processEnv: config.processEnv });
    // The ACP composition derives BOTH its sandbox mode and its approval policy
    // from this one variable. Relay states it rather than inheriting whatever
    // the hub environment held.
    env.DSH_PERMISSION_MODE =
      config.processEnv?.DSH_PERMISSION_MODE ??
      config.permissionMode ??
      'workspace-write';
    return env;
  },
  selectPermissionOptionId: ({ decision }) => {
    if (decision.kind === 'accept') return DSH_ALLOW_OPTION_ID;
    if (decision.kind === 'decline') return DSH_REJECT_OPTION_ID;
    return null;
  },
  onNotification: (notification, context) => {
    if (notification.method !== 'session/update') return;
    if (!context.turnId) return;
    const update = record(notification.params.update);
    if (string(update.sessionUpdate, '') !== 'config_option_update') return;
    // The dsh adapter surfaces config options as a debug provider extension.
    context.emitProviderExtension(
      {
        kind: 'configOptions',
        options: Array.isArray(update.configOptions)
          ? update.configOptions
          : [],
      },
      'debug'
    );
    return true;
  },
};

export class DshProtocolAdapter extends AcpProtocolAdapter {
  constructor(clientFactory?: ClientFactory) {
    super(DSH_PROFILE, clientFactory);
  }
}
