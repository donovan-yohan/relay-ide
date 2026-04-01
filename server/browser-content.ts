import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router } from 'express';
import type express from 'express';

// ── Content token store ──
interface TokenEntry {
  baseDir: string;
  filePath: string;
  createdAt: number;
}

const tokenStore = new Map<string, TokenEntry>();
const pathToToken = new Map<string, string>();

// ── Scoped auth token ──
let scopedToken = '';

export function generateScopedToken(): string {
  scopedToken = crypto.randomBytes(32).toString('hex');
  return scopedToken;
}

export function validateScopedToken(token: string): boolean {
  return token.length > 0 && token === scopedToken;
}

// ── Content tokens ──
export function createBrowserToken(filePath: string): string {
  const existing = pathToToken.get(filePath);
  if (existing && tokenStore.has(existing)) return existing;

  const token = crypto.randomBytes(16).toString('hex');
  const baseDir = path.dirname(filePath);
  tokenStore.set(token, { baseDir, filePath, createdAt: Date.now() });
  pathToToken.set(filePath, token);
  return token;
}

export function validateToken(token: string): { baseDir: string; filePath: string } | null {
  const entry = tokenStore.get(token);
  return entry ? { baseDir: entry.baseDir, filePath: entry.filePath } : null;
}

export function resolveTokenPath(token: string, relativePath: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (path.isAbsolute(relativePath)) return null;

  const resolved = path.resolve(entry.baseDir, relativePath);
  if (!resolved.startsWith(entry.baseDir + path.sep) && resolved !== entry.baseDir) return null;

  try {
    const realBaseDir = fs.realpathSync(entry.baseDir);
    const realResolved = fs.realpathSync(resolved);
    if (realResolved !== realBaseDir && !realResolved.startsWith(realBaseDir + path.sep)) return null;
  } catch {
    return null;
  }

  return resolved;
}

export function getTokenForPath(filePath: string): string | null {
  return pathToToken.get(filePath) ?? null;
}

export function cleanExpiredTokens(ttlMs: number): void {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (now - entry.createdAt >= ttlMs) {
      tokenStore.delete(token);
      pathToToken.delete(entry.filePath);
    }
  }
}

export function _resetForTesting(): void {
  tokenStore.clear();
  pathToToken.clear();
  scopedToken = '';
}

// ── Express router ──
export function createBrowserContentRouter(
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void,
): Router {
  const router = Router();

  router.post('/browser-tabs', (req: express.Request, res: express.Response) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!validateScopedToken(bearerToken)) {
      res.status(401).json({ error: 'Invalid browser token' });
      return;
    }

    const { path: filePath } = req.body as { path?: string };
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const resolved = path.resolve(filePath);

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'path must be a file, not a directory' });
        return;
      }
    } catch {
      res.status(404).json({ error: 'file not found' });
      return;
    }

    const existingToken = getTokenForPath(resolved);
    if (existingToken) {
      // Always emit browser-tab-opened (not just refreshed) so reconnecting clients,
      // second devices, or users who closed the tab get it re-opened with the token.
      // openHtmlTab on the frontend is idempotent — it focuses existing tabs.
      broadcastEvent('browser-tab-opened', { filePath: resolved, token: existingToken });
      broadcastEvent('browser-tab-refreshed', { filePath: resolved });
      res.json({ token: existingToken, refreshed: true });
      return;
    }

    const token = createBrowserToken(resolved);
    broadcastEvent('browser-tab-opened', { filePath: resolved, token });
    res.json({ token, refreshed: false });
  });

  router.get('/browser-content/:token/*', (req: express.Request, res: express.Response) => {
    const { token } = req.params;
    const relativePath = req.params[0] ?? '';

    if (!relativePath) {
      res.status(400).send('Missing file path');
      return;
    }

    const resolved = resolveTokenPath(token!, relativePath);
    if (!resolved) {
      res.status(403).send('Forbidden');
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(404).send('Not found');
      return;
    }
    if (!stat.isFile()) {
      res.status(400).send('Not a file');
      return;
    }

    res.sendFile(resolved);
  });

  return router;
}
