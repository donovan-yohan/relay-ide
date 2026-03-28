import crypto from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig, saveConfig } from './config.js';
import type { Config, Workspace } from './types.js';

export function createWorkspaceGroupsRouter(
  configPath: string,
  requireAuth: (req: any, res: any, next: any) => void,
): Router {
  const router = Router();

  // GET /workspace-groups — list all workspaces sorted by order
  router.get('/', requireAuth, (_req: Request, res: Response) => {
    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
      return;
    }
    const workspaces = config.workspaces ?? [];
    const sorted = [...workspaces].sort((a, b) => a.order - b.order);
    res.json(sorted);
  });

  // POST /workspace-groups — create a new workspace
  router.post('/', requireAuth, (req: Request, res: Response) => {
    const { name, repos, themeColor, settings, template } = req.body as {
      name?: unknown;
      repos?: unknown;
      themeColor?: unknown;
      settings?: unknown;
      template?: unknown;
    };

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required and must be a non-empty string' });
      return;
    }

    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
      return;
    }
    const validRepoPaths = new Set<string>(config.repos ?? []);

    const repoList: string[] = Array.isArray(repos)
      ? (repos as unknown[]).filter((r): r is string => typeof r === 'string' && validRepoPaths.has(r))
      : [];

    const workspaces = config.workspaces ?? [];
    const maxOrder = workspaces.reduce((max, w) => Math.max(max, w.order), -1);

    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: name.trim(),
      repos: repoList,
      order: maxOrder + 1,
    };

    if (themeColor !== undefined && typeof themeColor === 'string' && themeColor.trim()) {
      workspace.themeColor = themeColor;
    }
    if (settings !== undefined && typeof settings === 'object' && settings !== null) {
      (workspace as any).settings = settings;
    }
    if (template !== undefined && typeof template === 'object' && template !== null) {
      (workspace as any).template = template;
    }

    config.workspaces = [...workspaces, workspace];
    saveConfig(configPath, config);

    res.status(201).json(workspace);
  });

  // PUT /workspace-groups/reorder — reorder workspaces by ids array
  // MUST be registered BEFORE /:id to avoid Express matching "reorder" as :id
  router.put('/reorder', requireAuth, (req: Request, res: Response) => {
    const { ids } = req.body as { ids?: unknown };

    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
      res.status(400).json({ error: 'ids must be an array of strings' });
      return;
    }

    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
      return;
    }
    const workspaces = config.workspaces ?? [];
    const workspaceMap = new Map(workspaces.map(w => [w.id, w]));

    // Validate all provided ids exist
    for (const id of ids) {
      if (!workspaceMap.has(id)) {
        res.status(400).json({ error: `Workspace with id "${id}" not found` });
        return;
      }
    }

    const idSet = new Set(ids);
    const missing = workspaces.filter(w => !idSet.has(w.id));

    // Build reordered list: specified ids in order, then append any missing
    const reordered: Workspace[] = [
      ...ids.map((id, idx) => ({ ...workspaceMap.get(id)!, order: idx })),
      ...missing.map((w, idx) => ({ ...w, order: ids.length + idx })),
    ];

    config.workspaces = reordered;
    saveConfig(configPath, config);

    res.json(reordered.sort((a, b) => a.order - b.order));
  });

  // PUT /workspace-groups/:id — update a workspace
  router.put('/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { name, repos, themeColor, settings, template } = req.body as {
      name?: unknown;
      repos?: unknown;
      themeColor?: unknown;
      settings?: unknown;
      template?: unknown;
    };

    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
      return;
    }
    const workspaces = config.workspaces ?? [];
    const idx = workspaces.findIndex(w => w.id === id);

    if (idx === -1) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }

    const validRepoPaths = new Set<string>(config.repos ?? []);
    const existing = workspaces[idx]!;

    const updated: Workspace = { ...existing };

    if (name !== undefined) updated.name = (name as string).trim();
    if (repos !== undefined) {
      updated.repos = Array.isArray(repos)
        ? (repos as unknown[]).filter((r): r is string => typeof r === 'string' && validRepoPaths.has(r))
        : existing.repos;
    }
    if (themeColor !== undefined) {
      if (typeof themeColor === 'string' && themeColor.trim()) {
        updated.themeColor = themeColor;
      } else {
        delete updated.themeColor;
      }
    }
    if (settings !== undefined) {
      if (settings !== null && typeof settings === 'object') {
        (updated as any).settings = settings;
      } else {
        delete updated.settings;
      }
    }
    if (template !== undefined) {
      if (template !== null && typeof template === 'object') {
        (updated as any).template = template;
      } else {
        delete updated.template;
      }
    }

    workspaces[idx] = updated;
    config.workspaces = workspaces;
    saveConfig(configPath, config);

    res.json(updated);
  });

  // DELETE /workspace-groups/:id — delete a workspace and re-normalize order
  router.delete('/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
      return;
    }
    const workspaces = config.workspaces ?? [];
    const idx = workspaces.findIndex(w => w.id === id);

    if (idx === -1) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const remaining = workspaces
      .filter(w => w.id !== id)
      .sort((a, b) => a.order - b.order)
      .map((w, i) => ({ ...w, order: i }));

    config.workspaces = remaining;
    saveConfig(configPath, config);

    res.status(204).end();
  });

  return router;
}
