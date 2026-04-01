import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig, saveConfig, resolveSessionSettings, writeMeta } from './config.js';
import type { Config, Workspace, AgentType } from './types.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from './types.js';
import { findOrCreateWorktreeForBranch } from './watcher.js';
import { detectGitRepo } from './workspaces.js';
import type { CreateParams, CreateResult } from './sessions.js';

const execFileAsync = promisify(execFile);

interface SessionDeps {
  sessions: {
    create: (params: CreateParams) => CreateResult;
    nextAgentName: () => string;
  };
  gitWatcher: { watch(cwd: string): void };
  configPath: string;
}

export function createWorkspaceGroupsRouter(
  configPath: string,
  requireAuth: (req: any, res: any, next: any) => void,
  sessionDeps?: SessionDeps,
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

  // POST /workspace-groups/:id/session — launch a workspace session with coordinated worktrees
  if (sessionDeps) {
    router.post('/:id/session', requireAuth, async (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const { agent, yolo, useTmux, claudeArgs, cols, rows } = req.body as {
        agent?: string;
        yolo?: boolean;
        useTmux?: boolean;
        claudeArgs?: string[];
        cols?: number;
        rows?: number;
      };

      let config: Config;
      try {
        config = loadConfig(configPath);
      } catch {
        res.status(500).json({ error: 'Failed to read config' });
        return;
      }

      const workspaces = config.workspaces ?? [];
      const workspace = workspaces.find(w => w.id === id);
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

      if (workspace.repos.length === 0) {
        res.status(400).json({ error: 'Workspace has no repos' });
        return;
      }

      // Resolve paths per-repo in parallel: git repos get worktrees, non-git use path directly
      const execFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) =>
        execFileAsync(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 10_000 })
          .then(({ stdout, stderr }) => ({ stdout, stderr }));

      type RepoResult = { repoPath: string; resolvedPath: string } | { repoPath: string; error: string };

      // Inner fn always returns (never rejects), so Promise.all is safe here
      const results = await Promise.all(
        workspace.repos.map(async (repoPath): Promise<RepoResult> => {
          if (!fs.existsSync(repoPath)) {
            return { repoPath, error: `directory not found: ${repoPath}` };
          }

          let gitInfo: { isGitRepo: boolean; defaultBranch: string | null };
          try {
            gitInfo = await detectGitRepo(repoPath);
          } catch (err) {
            console.warn(`[workspace-groups] detectGitRepo failed for ${repoPath}:`, err);
            return { repoPath, resolvedPath: repoPath };
          }

          if (!gitInfo.isGitRepo || !gitInfo.defaultBranch) {
            return { repoPath, resolvedPath: repoPath };
          }

          try {
            const result = await findOrCreateWorktreeForBranch(repoPath, gitInfo.defaultBranch, execFn);
            return { repoPath, resolvedPath: result.worktreePath };
          } catch (err) {
            return { repoPath, error: err instanceof Error ? err.message : 'worktree creation failed' };
          }
        }),
      );

      const successes: Array<{ repoPath: string; resolvedPath: string }> = [];
      const failures: Array<{ repoPath: string; error: string }> = [];

      for (const val of results) {
        if ('error' in val) {
          failures.push(val);
        } else {
          successes.push(val);
        }
      }

      if (successes.length === 0) {
        res.status(500).json({ error: 'All repos failed to resolve', failures });
        return;
      }

      const primary = successes[0]!;
      const additionalDirs = successes.slice(1).map(s => s.resolvedPath);
      const addDirArgs = additionalDirs.flatMap(dir => ['--add-dir', dir]);

      // Resolve settings first (respects global < workspace < repo cascade),
      // then append --add-dir args so they don't replace configured claudeArgs
      const resolved = resolveSessionSettings(config, primary.repoPath, {
        agent: agent as AgentType | undefined,
        yolo,
        useTmux,
        claudeArgs,
      }, workspace.id);

      const resolvedAgent = resolved.agent;
      const combinedClaudeArgs = [...resolved.claudeArgs, ...addDirArgs];
      const baseArgs = [
        ...combinedClaudeArgs,
        ...(resolved.yolo ? AGENT_YOLO_ARGS[resolvedAgent] : []),
      ];

      const useContinue = resolved.continuePolicy === 'always';
      const finalArgs = useContinue
        ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs]
        : [...baseArgs];

      const displayName = sessionDeps.sessions.nextAgentName();
      const safeCols = typeof cols === 'number' && Number.isFinite(cols) && cols >= 1 && cols <= 500 ? Math.round(cols) : undefined;
      const safeRows = typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 && rows <= 200 ? Math.round(rows) : undefined;

      const cwd = primary.resolvedPath;
      const worktreePath = primary.resolvedPath !== primary.repoPath ? primary.resolvedPath : null;

      try {
        const createParams: CreateParams = {
          type: 'agent',
          agent: resolvedAgent,
          repoName: workspace.name,
          repoPath: primary.repoPath,
          worktreePath,
          cwd,
          branchName: '',
          displayName,
          args: finalArgs,
          configPath: sessionDeps.configPath,
          useTmux: resolved.useTmux,
          yolo: resolved.yolo,
          claudeArgs: combinedClaudeArgs,
          continuePolicy: resolved.continuePolicy,
          workspaceId: workspace.id,
        };
        if (additionalDirs.length > 0) createParams.additionalDirs = additionalDirs;
        if (safeCols != null) createParams.cols = safeCols;
        if (safeRows != null) createParams.rows = safeRows;

        const session = sessionDeps.sessions.create(createParams);

        // Write worktree metadata (matches pattern in server/index.ts)
        if (worktreePath) {
          writeMeta(sessionDeps.configPath, {
            worktreePath: cwd,
            displayName,
            lastActivity: new Date().toISOString(),
            branchName: '',
          });
        }

        sessionDeps.gitWatcher.watch(session.cwd);

        const response: Record<string, unknown> = { ...session };
        if (failures.length > 0) {
          response.warnings = failures;
        }

        res.status(201).json(response);
      } catch (err) {
        console.error(`[workspace-groups] session creation failed for workspace ${id}:`, err);
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create workspace session' });
      }
    });
  }

  return router;
}
