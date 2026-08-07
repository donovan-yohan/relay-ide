import crypto from 'node:crypto';
import { Router } from 'express';
import express from 'express';

import type { ChannelAgentRuntime } from './channel-agent-runtime.js';

export interface HookDeps {
  getRuntime(id: string): ChannelAgentRuntime | undefined;
}

/**
 * Provider hook ingress for private channel runtimes.
 *
 * Public sessions are terminals and never receive provider hooks. Keeping this
 * router runtime-only prevents retired PTY agent sessions from re-entering the
 * public session registry through a callback path.
 */
export function createHooksRouter(deps: HookDeps): Router {
  const router = Router();
  router.use(express.json());

  router.post('/agent-event', (req, res) => {
    const { sessionId, token, eventType, data, timestamp } = req.body as {
      sessionId?: string;
      token?: string;
      eventType?: string;
      data?: Record<string, unknown>;
      timestamp?: string;
    };

    if (!sessionId || !token || !eventType) {
      res.status(400).json({
        error: 'Missing required fields: sessionId, token, eventType',
      });
      return;
    }

    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(404).json({ error: 'Hook target not found' });
      return;
    }

    const tokenBuffer = Buffer.from(token);
    const expectedTokenBuffer = Buffer.from(runtime.hookToken);
    if (
      tokenBuffer.length !== expectedTokenBuffer.length ||
      !crypto.timingSafeEqual(tokenBuffer, expectedTokenBuffer)
    ) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const adapter = runtime.adapter as typeof runtime.adapter & {
      handleHookEvent?: (payload: {
        type: string;
        sessionId: string;
        data?: Record<string, unknown>;
        timestamp?: string;
      }) => void;
    };
    adapter.handleHookEvent?.({
      type: eventType,
      sessionId,
      ...(data !== undefined ? { data } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
    res.status(204).end();
  });

  return router;
}
