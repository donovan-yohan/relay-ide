import crypto from 'node:crypto';

import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  secret: () => string | undefined;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifySignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

function buildPrPayload(
  event: string | string[] | undefined,
  body: Record<string, unknown>,
  repoFullName: string | undefined
): Record<string, unknown> | undefined {
  const pr = body.pull_request as Record<string, unknown> | undefined;
  const payload: Record<string, unknown> = {};
  if (repoFullName) payload.repo = repoFullName;
  if (pr?.number !== undefined) payload.number = pr.number;

  if (event === 'pull_request') {
    const action = body.action as string | undefined;
    if (action) payload.action = action;
    if (pr?.state) payload.state = pr.state;
    if (action === 'closed' && pr?.merged === true) {
      payload.merged = true;
    }
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function shouldBroadcastWorktreesChanged(
  event: string | string[] | undefined,
  body: Record<string, unknown>
): boolean {
  if (event !== 'pull_request') return false;
  const action = body.action as string | undefined;
  const pr = body.pull_request as Record<string, unknown> | undefined;
  return action === 'closed' && pr?.merged === true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  // Middleware: parse JSON and preserve raw body for signature verification
  router.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as Record<string, unknown>).rawBody =
          buf.toString('utf8');
      },
    })
  );

  // POST / — receive GitHub webhook events
  router.post('/', (req: Request, res: Response) => {
    const secret = deps.secret();

    // If no secret configured, webhooks are not set up yet
    if (!secret) {
      res.status(401).json({ error: 'Webhooks not configured' });
      return;
    }

    const signature = req.headers['x-hub-signature-256'];

    // Reject if signature header is missing
    if (!signature || typeof signature !== 'string') {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    // Verify signature against raw body
    const rawBody =
      ((req as unknown as Record<string, unknown>).rawBody as
        | string
        | undefined) ?? '';
    if (!verifySignature(secret, rawBody, signature)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Route based on event type
    const event = req.headers['x-github-event'];

    const repoFullName = (req.body as Record<string, unknown>)?.repository
      ? ((
          (req.body as Record<string, unknown>).repository as Record<
            string,
            unknown
          >
        )?.full_name as string | undefined)
      : undefined;

    if (event === 'pull_request' || event === 'pull_request_review') {
      const body = req.body as Record<string, unknown>;
      const payload = buildPrPayload(event, body, repoFullName);
      deps.broadcastEvent('pr-updated', payload);

      if (shouldBroadcastWorktreesChanged(event, body)) {
        deps.broadcastEvent('worktrees-changed');
      }
    } else if (event === 'check_suite' || event === 'check_run') {
      deps.broadcastEvent(
        'ci-updated',
        repoFullName ? { repo: repoFullName } : undefined
      );
    }
    // Unknown events: ignore, return 200 OK

    res.json({ ok: true });
  });

  return router;
}
