import { CURSOR_CHANNEL_COMMAND } from './launch-commands.js';
import { nowIso, stringField as string } from './wire-values.js';
import type {
  AgentApprovalSupportV2,
  AgentCapabilitySetV2,
  AgentPlanItemV2,
  AgentQuestionItemV2,
} from '../../shared/agent-chat-protocol-v2.js';
import type { AcpPeerRequest } from '../acp-client.js';
import {
  AcpProtocolAdapter,
  type AcpHarnessProfile,
  type ClientFactory,
} from './acp-adapter.js';

/**
 * Honest capabilities for the Cursor CLI ACP lane (`cursor-agent acp`).
 */
const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  reasoning: true,
  tools: true,
  commandExecution: true,
  fileChanges: true,
  approvals: true,
  questions: true,
  plans: true,
  slashCommands: false,
  queue: true,
  steer: false,
  cancelQueued: false,
  interrupt: true,
  resume: true,
  fork: false,
  rollback: false,
  compact: false,
  telemetry: false,
  rateLimits: false,
  streaming: true,
} satisfies Required<AgentCapabilitySetV2>;

const CURSOR_APPROVAL_SUPPORT: AgentApprovalSupportV2 = {
  scopes: ['once', 'session'],
  amendmentTypes: [],
  canCancel: true,
};

const CURSOR_COMMAND_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'terminal_bash',
  'shell',
  'command',
  'exec',
]);

const CURSOR_FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'file_edit',
  'create_file',
  'delete_file',
]);

const CURSOR_PROFILE: AcpHarnessProfile = {
  agentType: 'cursor',
  displayName: 'Cursor',
  capabilities: CAPABILITIES,
  providerNamespace: 'cursor',
  providerSessionKey: 'cursorSessionId',
  approvalSupport: CURSOR_APPROVAL_SUPPORT,
  command: CURSOR_CHANNEL_COMMAND,
  authMethodId: 'cursor_login',
  clientInfo: { name: 'relay-ide', version: '0.1.0' },
  resumeStrategy: 'load',
  firstUpdateTimeoutMs: 20_000,
  modelArgs: (model) => ['--model', model],
  permissionPolicy: () => ({
    // `cursor-agent --yolo acp` is inert (still raises permission frames), but
    // Relay preserves the flag and also auto-approves on the wire.
    yoloArgs: ['--yolo'],
    yoloAutoApprove: true,
  }),
  extensionNamespace: 'cursor',
  otherKindHeuristics: true,
  commandToolNames: CURSOR_COMMAND_TOOL_NAMES,
  fileToolNames: CURSOR_FILE_TOOL_NAMES,
  selectPermissionOptionId: ({ decision, options }) => {
    if (decision.kind === 'accept') {
      const targetKinds =
        decision.scope === 'session' || decision.scope === 'permanent'
          ? ['allow_always', 'allow-always']
          : ['allow_once', 'allow-once'];
      const matched = options.find((o) =>
        o.kind ? targetKinds.includes(o.kind) : false
      );
      return matched?.optionId ?? null;
    }

    if (decision.kind === 'decline') {
      // A one-time reject must never widen into a standing one. If reject_once
      // is absent, fail closed.
      const matched = options.find((o) =>
        o.kind ? o.kind === 'reject_once' || o.kind === 'reject-once' : false
      );
      return matched?.optionId ?? null;
    }

    return null;
  },
  onNotification: (notification, context) => {
    if (!context.turnId) return;
    if (notification.method === 'cursor/update_todos') {
      context.emitProviderExtension(
        { kind: 'todos', todos: notification.params.todos ?? [] },
        'debug'
      );
      return true;
    }
    if (notification.method === 'cursor/task') {
      context.emitProviderExtension(
        { kind: 'task', ...notification.params },
        'debug'
      );
      return true;
    }
    if (notification.method === 'cursor/generate_image') {
      context.emitProviderExtension(
        { kind: 'generate_image', ...notification.params },
        'debug'
      );
      return true;
    }
    return;
  },
  onPeerRequest: (request: AcpPeerRequest, context) => {
    const client = context.client;

    if (request.method === 'cursor/ask_question') {
      const turnId = context.turnId;
      if (!turnId) {
        client.respond(request.id, { outcome: { outcome: 'cancelled' } });
        return true;
      }

      const requestId = `cursor-question-${String(request.id)}`;
      const startedAt = nowIso();
      const rawQuestions = Array.isArray(request.params.questions)
        ? (request.params.questions as Array<Record<string, unknown>>)
        : [];
      const title = string(request.params.title);

      const questionText =
        rawQuestions
          .map((q) => string(q.prompt))
          .filter(Boolean)
          .join(' / ') ||
        title ||
        'Cursor requires input';

      const card: AgentQuestionItemV2 = {
        type: 'question',
        id: `question-${requestId}`,
        requestId,
        question: questionText,
        fields: rawQuestions.map((q) => ({
          id: string(q.id),
          prompt: string(q.prompt),
          options: Array.isArray(q.options) ? q.options : [],
          allowMultiple: Boolean(q.allowMultiple),
        })),
        status: 'running',
        startedAt,
      };

      context.registerPendingInput(requestId, {
        turnId,
        peerRequestId: request.id,
        card,
      });
      context.ensureItem(card.id, card);
      context.emitLiveStateUpdate();
      return true;
    }

    if (request.method === 'cursor/create_plan') {
      const turnId = context.turnId;
      const planText =
        string(request.params.plan) ||
        string(request.params.overview) ||
        string(request.params.name) ||
        'Proposed plan';
      const toolCallId = string(request.params.toolCallId);
      const planId = toolCallId || `plan-${String(request.id)}`;

      if (turnId) {
        const rawTodos = Array.isArray(request.params.todos)
          ? (request.params.todos as Array<Record<string, unknown>>)
          : [];
        const steps = rawTodos.map((todo) => ({
          step: string(todo.content, string(todo.id, 'Task')),
          status: (string(todo.status) === 'completed'
            ? 'completed'
            : string(todo.status) === 'in_progress'
              ? 'inProgress'
              : 'pending') as 'pending' | 'inProgress' | 'completed',
        }));

        const planItem: AgentPlanItemV2 = {
          type: 'plan',
          id: planId,
          text: planText,
          ...(steps.length > 0 ? { steps } : {}),
          status: 'completed',
          startedAt: nowIso(),
          completedAt: nowIso(),
        };

        context.ensureItem(planId, planItem);
        context.emitItemUpdated(planItem);
      }

      client.respond(request.id, { outcome: { outcome: 'accepted' } });
      return true;
    }

    if (request.method === 'cursor/update_todos') {
      context.emitProviderExtension(
        { kind: 'todos', todos: request.params.todos ?? [] },
        'debug'
      );
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return true;
    }
    if (request.method === 'cursor/task') {
      context.emitProviderExtension(
        { kind: 'task', ...request.params },
        'debug'
      );
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return true;
    }
    if (request.method === 'cursor/generate_image') {
      context.emitProviderExtension(
        { kind: 'generate_image', ...request.params },
        'debug'
      );
      client.respond(request.id, { outcome: { outcome: 'completed' } });
      return true;
    }

    return;
  },
};

export class CursorProtocolAdapter extends AcpProtocolAdapter {
  constructor(clientFactory?: ClientFactory) {
    super(CURSOR_PROFILE, clientFactory);
  }
}
