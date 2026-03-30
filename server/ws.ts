import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import type { IPty } from 'node-pty';
import * as sessions from './sessions.js';
import { WorktreeWatcher } from './watcher.js';
import type { Session } from './types.js';
import { trackEvent } from './analytics.js';

function replyPing(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN) ws.send('{"type":"pong"}');
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
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

function setupWebSocket(server: http.Server, authenticatedTokens: Set<string>, watcher: WorktreeWatcher | null, _configPath?: string): { wss: WebSocketServer; broadcastEvent: (type: string, data?: Record<string, unknown>) => void } {
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
        const cleanup = () => { eventClients.delete(ws); };
        eventClients.add(ws);
        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'ping') replyPing(ws);
          } catch { /* ignore */ }
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
    }

    attachToPty(session.pty);

    const ptyReplacedHandler = (newPty: IPty) => attachToPty(newPty);
    session.onPtyReplacedCallbacks.push(ptyReplacedHandler);

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
      } catch (_) {}
      // Use session.pty dynamically so writes go to current PTY
      session.pty.write(str);
    });

    ws.on('close', () => {
      dataDisposable?.dispose();
      exitDisposable?.dispose();
      const idx = session.onPtyReplacedCallbacks.indexOf(ptyReplacedHandler);
      if (idx !== -1) session.onPtyReplacedCallbacks.splice(idx, 1);
    });
  });

  sessions.onBackendStateChange((sessionId, state) => {
    broadcastEvent('session-backend-state-changed', { sessionId, state });
    if (state === 'idle') { trackEvent({ category: 'agent', action: 'idle', target: sessionId, session_id: sessionId }); }
    if (state === 'permission') { trackEvent({ category: 'agent', action: 'waiting-for-input', target: sessionId, session_id: sessionId }); }
  });

  sessions.onSessionEnd((sessionId, cwd, branchName) => {
    broadcastEvent('session-ended', { sessionId, cwd, branchName });
  });

  return { wss, broadcastEvent };
}

export { setupWebSocket };
