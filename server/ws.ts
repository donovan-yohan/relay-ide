import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import type { IPty } from 'node-pty';
import * as sessions from './sessions.js';
import { WorktreeWatcher } from './watcher.js';
import type { Session } from './types.js';
import type { Attachment } from './protocol-adapter.js';
import { trackEvent } from './analytics.js';
import { createLogger } from './logger.js';

const logger = createLogger('ws');

function replyPing(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) ws.send('{"type":"pong"}');
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
  _configPath?: string
): {
  wss: WebSocketServer;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  broadcastBranchChanged: (cwdPath: string, branchName: string) => void;
} {
  const wss = new WebSocketServer({ noServer: true });
  const eventClients = new Set<WebSocket>();

  function broadcastEvent(type: string, data?: Record<string, unknown>): void {
    const msg = JSON.stringify({ type, ...data });
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

  server.on('upgrade', (request, socket, head) => {
    const cookies = parseCookies(request.headers.cookie);
    if (!authenticatedTokens.has(cookies['token'] ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
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
        // Use session.pty dynamically so writes go to current PTY
        session.pty.write(str);
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
      // Register the live listener BEFORE replaying the snapshot so no events
      // are lost in the window between replay completion and listener registration.
      const snapshot = [...session.messages];
      const unlisten = session.adapter.on((event) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      });
      for (const event of snapshot) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      }

      ws.on('message', (msg) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (parsed['type']) {
          case 'ping':
            replyPing(ws);
            break;
          case 'send-message':
            session.adapter
              .sendMessage(
                String(parsed['turnId'] ?? ''),
                String(parsed['content'] ?? ''),
                parsed['attachments'] as Attachment[] | undefined
              )
              .catch((err: unknown) => logger.error('sendMessage error:', err));
            break;
          case 'interrupt':
            session.adapter
              .interrupt(String(parsed['turnId'] ?? ''))
              .catch((err: unknown) => logger.error('interrupt error:', err));
            break;
          case 'approve': {
            const decision = parsed['decision'];
            if (
              decision !== 'allow' &&
              decision !== 'allow-always' &&
              decision !== 'deny'
            ) {
              logger.warn('ws: invalid approval decision', { decision });
              break;
            }
            session.adapter
              .respondToApproval(String(parsed['requestId'] ?? ''), decision)
              .catch((err: unknown) =>
                logger.error('respondToApproval error:', err)
              );
            break;
          }
          case 'input-response':
            session.adapter
              .respondToInput(
                String(parsed['requestId'] ?? ''),
                (parsed['answers'] as Record<string, string[]> | undefined) ??
                  {}
              )
              .catch((err: unknown) =>
                logger.error('respondToInput error:', err)
              );
            break;
        }
      });

      const cleanup = () => {
        unlisten();
        sessionMap.delete(ws);
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    }
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
