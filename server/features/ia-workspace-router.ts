// IA Workspace CRUD HTTP surface (#733 / BE-1). Exposes the six-layer
// **Workspace** (a durable, user-authored grouping-of-Projects) over REST,
// backed by the #737 `IaStore` (own `ia.db`, new tables only).
//
// STRICTLY NON-DESTRUCTIVE: this router only reads/writes the IA store's
// `ia_workspaces` table via the injected `IaStore` handle. It never touches
// `config.workspaces`, `config.repos`, or any legacy state. The legacy
// `config.workspaces` grouping that feeds `GET /hub/ia/tree` is a separate,
// read-only concern and is untouched here.
//
// Project (Instance / Bench / git-worktree) facts remain DERIVED via
// `GET /hub/ia/tree` (#734); a Workspace only persists an ORDERED LIST of
// ProjectIds it groups (membership), not the projects themselves.
//
// Endpoints (mounted at `/hub/ia/workspaces`):
// - GET    /hub/ia/workspaces        → list, ordered by `order` asc then id
// - POST   /hub/ia/workspaces        → create { name, projectIds?, order? }
// - PATCH  /hub/ia/workspaces/:id    → partial update (name / order / projectIds)
// - DELETE /hub/ia/workspaces/:id    → remove
//
// Reorder and project-membership-move are folded into PATCH: send `order` to
// reorder, send the full desired `projectIds` array to set membership (the
// store replaces the membership list wholesale). This is the minimal correct
// shape — no dedicated reorder/move endpoints — because the persisted Workspace
// record is small and fully replaceable.

import * as express from 'express';

import { createLogger } from '../logger.js';
import { relayError, sendRelayError } from '../hub-node-router.js';
import type { IaStore } from '../ia-store.js';
import {
  createWorkspaceId,
  parseWorkspaceId,
  type Workspace,
} from '../../shared/workspace.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('ia-workspace-router');

export interface IaWorkspaceRouterOptions {
  requireAuth: express.RequestHandler;
  /**
   * The #737 IA persistence handle. Optional so the hub degrades gracefully to
   * "no IA persistence" (503) rather than failing boot if the store could not
   * initialize — mirrors how `server/index.ts` guards `initIaStore`.
   */
  iaStore: IaStore | null;
}

function bodyRecord(req: express.Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

/** Normalize an arbitrary value into a clean string[] of non-empty ids. */
function readProjectIds(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) return null;
    out.push(entry);
  }
  return out;
}

export function createIaWorkspaceRouter(
  options: IaWorkspaceRouterOptions
): express.Router {
  const router = express.Router();
  const { requireAuth } = options;

  // Guard: every route needs a live store. Centralized so each handler can
  // assume a non-null store after this check.
  function store(res: express.Response): IaStore | null {
    if (!options.iaStore) {
      sendRelayError(
        res,
        relayError(
          'NODE_BUSY',
          'IA persistence store is unavailable',
          true,
          { reasonCode: 'IA_STORE_UNAVAILABLE' }
        )
      );
      return null;
    }
    return options.iaStore;
  }

  // GET /hub/ia/workspaces — list all workspaces, ordered by the store
  // (`order` asc then id asc for stability).
  router.get('/hub/ia/workspaces', requireAuth, (_req, res) => {
    const iaStore = store(res);
    if (!iaStore) return;
    try {
      res.json({ workspaces: iaStore.listWorkspaces() });
    } catch (error) {
      sendInternal(res, 'list', error);
    }
  });

  // POST /hub/ia/workspaces — create. Mints a fresh WorkspaceId. `order`
  // defaults to (max existing order + 1) so new workspaces append to the bar.
  router.post('/hub/ia/workspaces', requireAuth, (req, res) => {
    const iaStore = store(res);
    if (!iaStore) return;
    const body = bodyRecord(req);

    const name = body['name'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      sendValidation(res, 'name is required', 'name');
      return;
    }

    const projectIds = readProjectIds(body['projectIds']);
    if (body['projectIds'] !== undefined && projectIds === null) {
      sendValidation(
        res,
        'projectIds must be an array of non-empty strings',
        'projectIds'
      );
      return;
    }

    let order: number;
    if (body['order'] === undefined) {
      order = nextOrder(iaStore.listWorkspaces());
    } else if (typeof body['order'] === 'number' && Number.isFinite(body['order'])) {
      order = body['order'];
    } else {
      sendValidation(res, 'order must be a finite number', 'order');
      return;
    }

    try {
      const created = iaStore.upsertWorkspace({
        id: createWorkspaceId(randomUUID()),
        name: name.trim(),
        order,
        projectIds: projectIds ?? [],
      });
      res.status(201).json({ workspace: created });
    } catch (error) {
      sendInternal(res, 'create', error);
    }
  });

  // PATCH /hub/ia/workspaces/:id — partial update. Merges provided fields onto
  // the existing record (rename, reorder, set membership). Absent fields are
  // preserved. The store upsert preserves `createdAt`.
  router.patch('/hub/ia/workspaces/:id', requireAuth, (req, res) => {
    const iaStore = store(res);
    if (!iaStore) return;

    const id = req.params['id'];
    if (!id || !parseWorkspaceId(id)) {
      sendValidation(res, 'invalid workspace id', 'id');
      return;
    }
    const existing = iaStore.getWorkspace(id);
    if (!existing) {
      sendRelayError(res, relayError('NOT_FOUND', `workspace ${id} not found`));
      return;
    }

    const body = bodyRecord(req);

    let name = existing.name;
    if (body['name'] !== undefined) {
      if (typeof body['name'] !== 'string' || body['name'].trim().length === 0) {
        sendValidation(res, 'name must be a non-empty string', 'name');
        return;
      }
      name = body['name'].trim();
    }

    let order = existing.order;
    if (body['order'] !== undefined) {
      if (typeof body['order'] !== 'number' || !Number.isFinite(body['order'])) {
        sendValidation(res, 'order must be a finite number', 'order');
        return;
      }
      order = body['order'];
    }

    let projectIds = existing.projectIds;
    if (body['projectIds'] !== undefined) {
      const parsed = readProjectIds(body['projectIds']);
      if (parsed === null) {
        sendValidation(
          res,
          'projectIds must be an array of non-empty strings',
          'projectIds'
        );
        return;
      }
      projectIds = parsed;
    }

    try {
      const updated = iaStore.upsertWorkspace({ id, name, order, projectIds });
      res.json({ workspace: updated });
    } catch (error) {
      sendInternal(res, 'update', error);
    }
  });

  // DELETE /hub/ia/workspaces/:id — remove. 204 on success, 404 if absent.
  router.delete('/hub/ia/workspaces/:id', requireAuth, (req, res) => {
    const iaStore = store(res);
    if (!iaStore) return;

    const id = req.params['id'];
    if (!id || !parseWorkspaceId(id)) {
      sendValidation(res, 'invalid workspace id', 'id');
      return;
    }
    try {
      const removed = iaStore.deleteWorkspace(id);
      if (!removed) {
        sendRelayError(res, relayError('NOT_FOUND', `workspace ${id} not found`));
        return;
      }
      res.status(204).end();
    } catch (error) {
      sendInternal(res, 'delete', error);
    }
  });

  return router;

  function sendValidation(
    res: express.Response,
    message: string,
    field: string
  ): void {
    sendRelayError(
      res,
      relayError('INVALID_REQUEST', message, false, {
        reasonCode: 'INVALID_WORKSPACE_INPUT',
        field,
      })
    );
  }

  function sendInternal(
    res: express.Response,
    op: string,
    error: unknown
  ): void {
    logger.warn('workspace %s failed: %s', op, error);
    sendRelayError(
      res,
      relayError(
        'INTERNAL',
        error instanceof Error ? error.message : `workspace ${op} failed`
      )
    );
  }
}

/** Next append-order: max existing `order` + 1, or 0 for an empty list. */
function nextOrder(existing: Workspace[]): number {
  if (existing.length === 0) return 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const ws of existing) {
    if (ws.order > max) max = ws.order;
  }
  return Number.isFinite(max) ? max + 1 : 0;
}
