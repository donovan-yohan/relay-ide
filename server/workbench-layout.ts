/**
 * Workbench layout persistence — slice 3 of epic #612.
 *
 * Storage model: one JSON file per workspace, keyed by a SHA-256 prefix of
 * the workspace id. Files live in `<configDir>/workbench-layouts/`. This
 * mirrors the `worktree-meta/` pattern from server/config.ts.
 *
 * Forward-compat: unknown block kinds and extra placement fields are
 * preserved verbatim (see deserialiseWorkbenchLayout in shared/).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  deserialiseWorkbenchLayout,
  serialiseWorkbenchLayout,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
} from '../shared/workbench-layout-types.js';
import type { WorkbenchLayout } from '../shared/workbench-layout-types.js';
import { createLogger } from './logger.js';

const logger = createLogger('workbench-layout');

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

function layoutDir(configPath: string): string {
  return path.join(path.dirname(configPath), 'workbench-layouts');
}

function layoutFilePath(configPath: string, workspaceId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(workspaceId)
    .digest('hex')
    .slice(0, 16);
  return path.join(layoutDir(configPath), `${hash}.json`);
}

function ensureLayoutDir(configPath: string): void {
  const dir = layoutDir(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public read/write API (used by router and tests)
// ---------------------------------------------------------------------------

/**
 * Read the stored layout for a workspace.
 * Returns `null` if no layout is stored yet.
 * Returns `null` and logs a warning on parse error (corrupt file).
 */
export function readWorkbenchLayout(
  configPath: string,
  workspaceId: string
): WorkbenchLayout | null {
  const fp = layoutFilePath(configPath, workspaceId);
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    // File not found — no layout stored yet
    return null;
  }
  try {
    return deserialiseWorkbenchLayout(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      `Failed to parse workbench layout for workspace ${workspaceId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Persist a layout for a workspace.
 * Throws on write errors.
 */
export function writeWorkbenchLayout(
  configPath: string,
  workspaceId: string,
  layout: WorkbenchLayout
): void {
  ensureLayoutDir(configPath);
  const fp = layoutFilePath(configPath, workspaceId);
  fs.writeFileSync(
    fp,
    JSON.stringify(serialiseWorkbenchLayout(layout), null, 2),
    'utf8'
  );
}

/**
 * Delete the stored layout for a workspace (e.g. when workspace is deleted).
 * Silently ignores missing files.
 */
export function deleteWorkbenchLayout(
  configPath: string,
  workspaceId: string
): void {
  const fp = layoutFilePath(configPath, workspaceId);
  try {
    fs.unlinkSync(fp);
  } catch {
    // Ignore missing file
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (used in the router)
// ---------------------------------------------------------------------------

/**
 * Validate that a layout body submitted via PUT is structurally valid.
 * Returns a descriptive error string on failure, or null on success.
 */
export function validateLayoutBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'request body must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  const schemaVersion = obj['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    return 'schemaVersion must be a number';
  }
  if (schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${schemaVersion} (expected ${WORKBENCH_LAYOUT_SCHEMA_VERSION})`;
  }

  const workspaceScope = obj['workspaceScope'];
  if (
    typeof workspaceScope !== 'object' ||
    workspaceScope === null ||
    typeof (workspaceScope as Record<string, unknown>)['id'] !== 'string'
  ) {
    return 'workspaceScope.id must be a string';
  }

  if (!Array.isArray(obj['blocks'])) {
    return 'blocks must be an array';
  }

  const blocks = obj['blocks'] as unknown[];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      return `blocks[${i}] must be an object`;
    }
    const b = block as Record<string, unknown>;

    const descriptor = b['descriptor'];
    if (
      typeof descriptor !== 'object' ||
      descriptor === null ||
      typeof (descriptor as Record<string, unknown>)['kind'] !== 'string'
    ) {
      return `blocks[${i}].descriptor.kind must be a string`;
    }
    if (typeof (descriptor as Record<string, unknown>)['id'] !== 'string') {
      return `blocks[${i}].descriptor.id must be a string`;
    }

    const pos = b['position'];
    if (
      typeof pos !== 'object' ||
      pos === null ||
      typeof (pos as Record<string, unknown>)['x'] !== 'number' ||
      typeof (pos as Record<string, unknown>)['y'] !== 'number'
    ) {
      return `blocks[${i}].position must have numeric x and y`;
    }

    const sz = b['size'];
    if (
      typeof sz !== 'object' ||
      sz === null ||
      typeof (sz as Record<string, unknown>)['width'] !== 'number' ||
      typeof (sz as Record<string, unknown>)['height'] !== 'number'
    ) {
      return `blocks[${i}].size must have numeric width and height`;
    }

    if (b['minimized'] !== undefined && typeof b['minimized'] !== 'boolean') {
      return `blocks[${i}].minimized must be a boolean`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Express router factory
// ---------------------------------------------------------------------------

export interface WorkbenchLayoutRouterDeps {
  configPath: string;
}

/**
 * Creates and returns an Express Router for workbench layout persistence.
 *
 * Routes (relative to mount point `/workspace-groups`):
 *   GET  /:id/workbench-layout  → WorkbenchLayout | null (204 if not set)
 *   PUT  /:id/workbench-layout  → persists layout, returns 200 with layout
 *
 * Auth is applied by the caller (mount with requireAuth middleware).
 */
export function createWorkbenchLayoutRouter(
  deps: WorkbenchLayoutRouterDeps
): Router {
  const { configPath } = deps;
  const router = Router({ mergeParams: true });

  // GET /:id/workbench-layout
  router.get('/:id/workbench-layout', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const layout = readWorkbenchLayout(configPath, id);
    if (layout === null) {
      res.status(204).end();
      return;
    }
    res.json(layout);
  });

  // PUT /:id/workbench-layout
  router.put('/:id/workbench-layout', (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const body = req.body as unknown;

    const validationError = validateLayoutBody(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // Parse via the shared deserialiser (handles unknown kinds, extra fields)
    let layout: WorkbenchLayout | null;
    try {
      layout = deserialiseWorkbenchLayout(body);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'invalid layout body',
      });
      return;
    }

    if (!layout) {
      res.status(400).json({ error: 'layout body is required' });
      return;
    }

    // Scope-guard: workspaceScope.id in body must match the URL :id
    if (layout.workspaceScope.id !== id) {
      res.status(400).json({
        error: 'workspaceScope.id in body must match workspace id in URL',
      });
      return;
    }

    try {
      writeWorkbenchLayout(configPath, id, layout);
    } catch (err) {
      logger.error(
        `Failed to write workbench layout for workspace ${id}:`,
        err instanceof Error ? err.message : err
      );
      res.status(500).json({ error: 'failed to persist layout' });
      return;
    }

    res.json(layout);
  });

  return router;
}
