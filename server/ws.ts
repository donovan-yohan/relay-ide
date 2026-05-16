import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import http from 'node:http';
import type { IPty } from 'node-pty';
import * as sessions from './sessions.js';
import { WorktreeWatcher } from './watcher.js';
import type { Session } from './types.js';
import type { Attachment } from './protocol-adapter.js';
import { trackEvent } from './analytics.js';
import { createLogger } from './logger.js';
import { loadConfig } from './config.js';
import { verifyCookieToken } from './auth.js';
import { createAgentSessionSnapshotPatch } from './web-session-v2-state.js';
import type { AgentApprovalDecisionV2 } from '../shared/agent-chat-protocol-v2.js';
import type { LocalRelayNode } from './local-node.js';
import type { HubNodeRegistry } from './hub-node-registry.js';
import {
  authenticateHubNodeLink,
  handleHubNodeLink,
  type HubNodeLinkManager,
} from './hub-node-link.js';
import {
  createNodeScopedFileEvent,
  createNodeScopedSessionEvent,
} from '../shared/node-boundary.js';

import {
  sessionEnvelopeRegistry,
  type InMemorySessionEnvelopeRegistry,
} from './session-envelope-registry.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import type { RoutedSessionAuditSink } from './hub-node-router.js';
import {
  appendPolicyAudit,
  evaluateHubPolicy,
  policyDecisionToRelayError,
} from './hub-policy-evaluator.js';

const logger = createLogger('ws');

function replyPing(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) ws.send('{"type":"pong"}');
}

function appendRoutedSessionAudit(
  sink: RoutedSessionAuditSink | undefined,
  input: SecurityAuditEntryInput
): void {
  if (!sink) return;
  try {
    sink.append(input);
  } catch {
    // WebSocket upgrades cannot rely on audit persistence; lifecycle
    // validation itself remains fail-closed before the PTY attach starts.
  }
}

function routedSessionStatus(code: string): number {
  if (code === 'NOT_FOUND') return 404;
  if (
    code === 'SESSION_EXPIRED' ||
    code === 'SESSION_REVOKED' ||
    code === 'SESSION_MISMATCH'
  ) {
    return 403;
  }
  return 400;
}

function routedPolicyStatus(code: string): number {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'INTERNAL') return 500;
  if (
    code === 'UNSUPPORTED_CAPABILITY' ||
    code === 'NODE_REVOKED' ||
    code === 'SESSION_EXPIRED' ||
    code === 'SESSION_REVOKED' ||
    code === 'SESSION_MISMATCH'
  ) {
    return 403;
  }
  return routedSessionStatus(code);
}

function auditAttachDenial(
  sink: RoutedSessionAuditSink | undefined,
  validation: Exclude<
    ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
    { ok: true }
  >,
  nodeId: string,
  sessionId: string
): void {
  if (validation.ok) return;
  const reasonCode =
    typeof validation.error.details?.['reasonCode'] === 'string'
      ? validation.error.details['reasonCode']
      : validation.error.code;
  appendRoutedSessionAudit(sink, {
    eventType:
      validation.error.code === 'SESSION_EXPIRED'
        ? 'expiry'
        : validation.error.code === 'SESSION_REVOKED'
          ? 'revocation'
          : 'denial',
    decision:
      validation.error.code === 'SESSION_EXPIRED'
        ? 'expired'
        : validation.error.code === 'SESSION_REVOKED'
          ? 'revoked'
          : 'deny',
    reasonCode,
    peer:
      validation.summary?.peerIdentity.kind === 'relay-node'
        ? { kind: 'node', nodeId: validation.summary.peerIdentity.nodeId }
        : { kind: 'hub' },
    node: { nodeId },
    sessionId: validation.record?.envelope.sessionId ?? sessionId,
    intent: { action: 'sessions.attach', target: nodeId },
    material: { scope: validation.summary?.scope ?? null },
    ...(validation.record?.envelope.correlationId
      ? { correlationId: validation.record.envelope.correlationId }
      : {}),
  });
}

function sendAgentErrorV2(
  ws: WebSocket,
  sessionId: string,
  context: string,
  err: unknown
): void {
  if (ws.readyState !== ws.OPEN) return;
  const message = err instanceof Error ? err.message : String(err);
  ws.send(
    JSON.stringify({
      type: 'agent-error-v2',
      sessionId,
      timestamp: new Date().toISOString(),
      message: `${context}: ${message}`,
    })
  );
}

function handleAgentCommandV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  switch (parsed['type']) {
    case 'agent-send-message-v2':
      sendAgentMessageV2(ws, session, parsed);
      break;
    case 'agent-interrupt-v2':
      interruptAgentV2(ws, session, parsed);
      break;
    case 'agent-approve-v2':
      approveAgentV2(ws, session, parsed);
      break;
    case 'agent-answer-v2':
      answerAgentV2(ws, session, parsed);
      break;
    case 'agent-resume-v2':
      resumeAgentV2(ws, session, parsed);
      break;
  }
}

function sendAgentMessageV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  const input = {
    turnId: String(parsed['turnId'] ?? ''),
    content: String(parsed['content'] ?? ''),
    ...(parsed['attachments'] !== undefined
      ? { attachments: parsed['attachments'] as Attachment[] }
      : {}),
    ...(typeof parsed['clientMessageId'] === 'string'
      ? { clientMessageId: parsed['clientMessageId'] }
      : {}),
  };
  session.adapterV2.sendMessage(input).catch((err: unknown) => {
    logger.error('v2 sendMessage error:', err);
    sendAgentErrorV2(ws, session.id, 'v2 sendMessage failed', err);
  });
}

function interruptAgentV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  const input =
    typeof parsed['turnId'] === 'string' ? { turnId: parsed['turnId'] } : {};
  session.adapterV2.interrupt(input).catch((err: unknown) => {
    logger.error('v2 interrupt error:', err);
    sendAgentErrorV2(ws, session.id, 'v2 interrupt failed', err);
  });
}

function parseApprovalDecision(
  parsed: Record<string, unknown>
): AgentApprovalDecisionV2 | null {
  const decision = parsed['decision'];
  if (typeof decision !== 'object' || decision === null) return null;
  const d = decision as Record<string, unknown>;
  const kind = d['kind'];
  if (kind === 'decline') return { kind: 'decline' };
  if (kind === 'cancel') return { kind: 'cancel' };
  if (kind === 'accept') {
    const scope = d['scope'];
    const result: Extract<AgentApprovalDecisionV2, { kind: 'accept' }> = {
      kind: 'accept',
    };
    if (
      scope === 'once' ||
      scope === 'session' ||
      scope === 'turn' ||
      scope === 'permanent'
    ) {
      result.scope = scope;
    }
    const amendments = d['amendments'];
    if (Array.isArray(amendments)) {
      result.amendments = amendments as AgentApprovalDecisionV2 extends {
        amendments?: infer A;
      }
        ? NonNullable<A>
        : never;
    }
    return result;
  }
  return null;
}

function approveAgentV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  const decision = parseApprovalDecision(parsed);
  if (decision === null) {
    logger.warn('ws: invalid v2 approval decision', {
      decision: parsed['decision'],
    });
    return;
  }

  session.adapterV2
    .respondToApproval({
      requestId: String(parsed['requestId'] ?? ''),
      decision,
    })
    .catch((err: unknown) => {
      logger.error('v2 respondToApproval error:', err);
      sendAgentErrorV2(ws, session.id, 'v2 approval delivery failed', err);
    });
}

function answerAgentV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  const answers =
    (parsed['answers'] as Record<string, string[]> | undefined) ?? {};

  session.adapterV2
    .respondToInput({
      requestId: String(parsed['requestId'] ?? ''),
      answers,
    })
    .catch((err: unknown) => {
      logger.error('v2 respondToInput error:', err);
      sendAgentErrorV2(ws, session.id, 'v2 input delivery failed', err);
    });
}

function resumeAgentV2(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  parsed: Record<string, unknown>
): void {
  const providerSessionId =
    typeof parsed['providerSessionId'] === 'string'
      ? parsed['providerSessionId']
      : undefined;

  if (!session.adapterV2.capabilities.resume) {
    sendAgentErrorV2(
      ws,
      session.id,
      'agent-resume-v2 rejected',
      new Error(`${session.adapterType} does not support resume`)
    );
    return;
  }

  // Resolve the provider session ID: prefer the one sent by the client
  // (which may come from the UI's persisted state), fall back to the
  // server-side providerSession stored on the session.
  const storedProviderSession = session.agentSessionV2.providerSession;
  const resolvedId =
    providerSessionId ??
    (session.adapterType === 'claude'
      ? storedProviderSession?.['claudeSessionId']
      : session.adapterType === 'codex'
        ? storedProviderSession?.['threadId']
        : undefined);

  if (!resolvedId) {
    sendAgentErrorV2(
      ws,
      session.id,
      'agent-resume-v2 rejected',
      new Error('No provider session ID available for resume')
    );
    return;
  }

  session.adapterV2.resumeSession(resolvedId).catch((err: unknown) => {
    logger.error('v2 resumeSession error:', err);
    sendAgentErrorV2(ws, session.id, 'v2 resume failed', err);
  });
}

function handleWebSessionMessage(
  ws: WebSocket,
  session: Extract<Session, { mode: 'web' }>,
  msg: RawData
): void {
  const body = msg.toString();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    logger.warn('ws: invalid JSON for web session', {
      sessionId: session.id,
      preview: body.slice(0, 200),
    });
    return;
  }

  if (parsed['type'] === 'ping') {
    replyPing(ws);
    return;
  }

  if (typeof parsed['type'] === 'string' && parsed['type'].endsWith('-v2')) {
    handleAgentCommandV2(ws, session, parsed);
    return;
  }

  logger.warn('ws: ignoring legacy web command for v2-only web session', {
    sessionId: session.id,
    type: parsed['type'],
  });
}

function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function setupWebSocket(
  server: http.Server,
  authenticatedTokens: Set<string>,
  watcher: WorktreeWatcher | null,
  configPath?: string,
  noPinMode = false,
  localNode?: LocalRelayNode,
  hubNodeRegistry?: HubNodeRegistry,
  nodeLinks?: HubNodeLinkManager,
  sessionEnvelopes: InMemorySessionEnvelopeRegistry = sessionEnvelopeRegistry,
  auditSink?: RoutedSessionAuditSink
): {
  wss: WebSocketServer;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  broadcastBranchChanged: (cwdPath: string, branchName: string) => void;
} {
  const wss = new WebSocketServer({ noServer: true });
  const eventClients = new Set<WebSocket>();

  function isAuthenticated(cookieHeader: string | undefined): boolean {
    if (noPinMode) return true;
    const cookies = parseCookies(cookieHeader);
    const token = cookies['token'] ?? '';
    if (authenticatedTokens.has(token)) return true;
    if (!configPath) return false;
    try {
      const config = loadConfig(configPath);
      return verifyCookieToken(token, config.pinHash);
    } catch {
      return false;
    }
  }

  function scopedEventPayload(
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!localNode) return data;

    const input = data ?? {};
    const nodeId = typeof input['nodeId'] === 'string' ? input['nodeId'] : localNode.nodeId;
    const environmentId =
      typeof input['environmentId'] === 'string' ? input['environmentId'] : localNode.environmentId;
    const payload: Record<string, unknown> = {
      ...input,
      nodeId,
      environmentId,
      authority: 'local-node',
    };
    const sessionId =
      typeof payload['localSessionId'] === 'string'
        ? payload['localSessionId']
        : payload['sessionId'];
    if (typeof sessionId === 'string') {
      Object.assign(payload, createNodeScopedSessionEvent(sessionId, { nodeId, environmentId }));
    }

    const workspacePath = payload['workspacePath'];
    if (typeof workspacePath === 'string') {
      Object.assign(payload, createNodeScopedFileEvent({
        workspacePath,
        ...(typeof payload['worktreePath'] === 'string'
          ? { worktreePath: payload['worktreePath'] }
          : {}),
        nodeId,
        environmentId,
      }));
    }

    return payload;
  }

  function broadcastEvent(type: string, data?: Record<string, unknown>): void {
    const msg = JSON.stringify({ type, ...scopedEventPayload(data) });
    for (const client of eventClients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }
  }

  function broadcastBranchChanged(cwdPath: string, branchName: string): void {
    const matchingSessions = sessions
      .list()
      .filter(
        (session) =>
          session.cwd === cwdPath ||
          session.worktreePath === cwdPath ||
          session.repoPath === cwdPath
      );

    for (const session of matchingSessions) {
      broadcastEvent('session-branch-changed', {
        sessionId: session.id,
        branch: branchName,
        cwdPath,
      });
    }
  }

  if (watcher) {
    watcher.on('worktrees-changed', function () {
      broadcastEvent('worktrees-changed');
    });
  }

  nodeLinks?.onNodeEvent((type, data) => {
    broadcastEvent(type, data);
  });

  const unsubscribeNodeStatus = hubNodeRegistry?.onNodeStatus((event) => {
    broadcastEvent('node.status', { ...event });
  });

  const nodeStatusRefreshTimer = hubNodeRegistry
    ? setInterval(() => {
        hubNodeRegistry.refreshNodeStatuses();
      }, 5_000)
    : null;
  nodeStatusRefreshTimer?.unref?.();
  server.on('close', () => {
    unsubscribeNodeStatus?.();
    if (nodeStatusRefreshTimer) clearInterval(nodeStatusRefreshTimer);
  });

  server.on('upgrade', (request, socket, head) => {
    const requestPath = request.url
      ? new URL(request.url, 'http://relay.local').pathname.replace(/\/$/, '')
      : '';
    if (requestPath === '/hub/node-link') {
      const authenticated = authenticateHubNodeLink(request, hubNodeRegistry);
      if (!authenticated || !hubNodeRegistry) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleHubNodeLink(ws, hubNodeRegistry, authenticated, nodeLinks);
      });
      return;
    }

    if (!isAuthenticated(request.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const routedPtyMatch = requestPath.match(
      /^\/nodes\/([^/]+)\/ws\/sessions\/([^/]+)$/
    );
    if (routedPtyMatch) {
      let nodeId: string;
      let sessionId: string;
      try {
        nodeId = decodeURIComponent(routedPtyMatch[1]!);
        sessionId = decodeURIComponent(routedPtyMatch[2]!);
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const validation = sessionEnvelopes.validate({
        nodeId,
        sessionId,
      });
      if (!validation.ok) {
        const denial = validation as Exclude<
          ReturnType<InMemorySessionEnvelopeRegistry['validate']>,
          { ok: true }
        >;
        auditAttachDenial(auditSink, denial, nodeId, sessionId);
        socket.write(
          `HTTP/1.1 ${routedSessionStatus(denial.error.code)} ${denial.error.code}\r\n\r\n`
        );
        socket.destroy();
        return;
      }
      const node = hubNodeRegistry
        ?.listNodes()
        .find((candidate) => candidate.nodeId === nodeId);
      const policyDecision = evaluateHubPolicy({
        peer: { kind: 'hub' },
        node,
        nodeId,
        intent: { action: 'sessions.attach', target: nodeId },
        scope: {
          kind: validation.summary.scope.kind,
          nodeId,
          cwd: validation.summary.scope.cwd,
          ...(validation.summary.scope.repoPath
            ? { repoPath: validation.summary.scope.repoPath }
            : {}),
          ...(validation.summary.scope.worktreePath !== undefined
            ? { worktreePath: validation.summary.scope.worktreePath }
            : {}),
        },
        requiredCapabilities: ['session:attach'],
        sessionId,
        expiresAt: validation.summary.expiresAt,
        ...(validation.summary.revokedAt ? { revokedAt: validation.summary.revokedAt } : {}),
        ...(validation.summary.correlationId
          ? { correlationId: validation.summary.correlationId }
          : {}),
      });
      const auditedDecision = appendPolicyAudit(auditSink, policyDecision);
      if (auditedDecision.decision !== 'allow') {
        const error = policyDecisionToRelayError(auditedDecision);
        socket.write(`HTTP/1.1 ${routedPolicyStatus(error.code)} ${error.code}\r\n\r\n`);
        socket.destroy();
        return;
      }
      if (!nodeLinks?.hasActiveNode(nodeId)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        try {
          nodeLinks.attachPty(nodeId, sessionId, ws);
        } catch {
          ws.close(1011);
        }
      });
      return;
    }

    // Event channel: /ws/events
    if (request.url === '/ws/events') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const cleanup = () => {
          eventClients.delete(ws);
        };
        eventClients.add(ws);
        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'ping') replyPing(ws);
          } catch {
            /* ignore */
          }
        });
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      });
      return;
    }

    // PTY channel: /ws/:sessionId
    const match = request.url && request.url.match(/^\/ws\/([a-f0-9]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = match[1]!;
    const session = sessions.get(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      sessionMap.set(ws, session);
      wss.emit('connection', ws, request);
    });
  });

  const sessionMap = new WeakMap<WebSocket, Session>();

  wss.on('connection', (ws: WebSocket, _request: http.IncomingMessage) => {
    const session = sessionMap.get(ws);
    if (!session) return;

    if (session.mode === 'pty') {
      let dataDisposable: { dispose(): void } | null = null;
      let exitDisposable: { dispose(): void } | null = null;

      const attachToPty = (ptyProcess: IPty): void => {
        // Dispose previous handlers
        dataDisposable?.dispose();
        exitDisposable?.dispose();

        // Replay scrollback
        for (const chunk of session.scrollback) {
          if (ws.readyState === ws.OPEN) ws.send(chunk);
        }

        dataDisposable = ptyProcess.onData((data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        });

        exitDisposable = ptyProcess.onExit(() => {
          if (ws.readyState === ws.OPEN) ws.close(1000);
        });
      };

      attachToPty(session.pty);

      const ptyReplacedHandler = (newPty: IPty) => attachToPty(newPty);
      session.onPtyReplacedCallbacks.push(ptyReplacedHandler);

      let lastActivityBroadcast = 0;

      ws.on('message', (msg) => {
        const str = msg.toString();
        try {
          const parsed = JSON.parse(str);
          if (parsed.type === 'ping') {
            replyPing(ws);
            return;
          }
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            sessions.resize(session.id, parsed.cols, parsed.rows);
            return;
          }
        } catch (_) {
          // ignore
        }
        // Route browser PTY input through the session write path so control
        // interventions are recorded before the active PTY receives input.
        sessions.write(session.id, str);
        // Update activity timestamp on user input (throttled broadcast to avoid storm)
        const now = Date.now();
        session.lastActivity = new Date(now).toISOString();
        if (now - lastActivityBroadcast >= 2000) {
          lastActivityBroadcast = now;
          broadcastEvent('session-activity-changed', {
            sessionId: session.id,
            timestamp: session.lastActivity,
          });
        }
      });

      const cleanup = () => {
        dataDisposable?.dispose();
        exitDisposable?.dispose();
        const idx = session.onPtyReplacedCallbacks.indexOf(ptyReplacedHandler);
        if (idx !== -1) session.onPtyReplacedCallbacks.splice(idx, 1);
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    } else {
      // Web session — JSON relay
      const patchReplayStart = session.agentPatchesV2.length;
      const snapshotPatch = createAgentSessionSnapshotPatch(session);
      const unlistenV2 = session.adapterV2.onPatch((patch) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(patch));
      });

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshotPatch));
      for (const patch of session.agentPatchesV2.slice(patchReplayStart)) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(patch));
      }

      ws.on('message', (msg) => handleWebSessionMessage(ws, session, msg));

      const cleanup = () => {
        unlistenV2();
        sessionMap.delete(ws);
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    }
  });

  sessions.onControlEvent((event) => {
    broadcastEvent('tab-control-event', { event });
  });

  sessions.onBackendStateChange((sessionId, state, permissionType) => {
    broadcastEvent('session-backend-state-changed', {
      sessionId,
      state,
      permissionType,
    });
    if (state === 'idle') {
      trackEvent({
        category: 'agent',
        action: 'idle',
        target: sessionId,
        session_id: sessionId,
      });
    }
    if (state === 'permission') {
      trackEvent({
        category: 'agent',
        action: 'waiting-for-input',
        target: sessionId,
        session_id: sessionId,
      });
    }
  });

  sessions.onSessionEnd((sessionId, cwd, branchName) => {
    broadcastEvent('session-ended', { sessionId, cwd, branchName });
  });

  return { wss, broadcastEvent, broadcastBranchChanged };
}

export { setupWebSocket };
