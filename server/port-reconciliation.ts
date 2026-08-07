import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from './logger.js';

export type PortReconciliationLogger = Pick<Logger, 'warn'>;

export function isGitRepoPathForPortReconciliation(
  repoPath: string,
  existsSync: (path: string) => boolean = fs.existsSync
): boolean {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') return false;
  return existsSync(path.join(repoPath, '.git'));
}

export function filterPortReconciliationRepoPaths(
  repoPaths: readonly string[],
  existsSync: (path: string) => boolean = fs.existsSync
): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const repoPath of repoPaths) {
    if (typeof repoPath !== 'string') continue;
    const trimmed = repoPath.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (!isGitRepoPathForPortReconciliation(trimmed, existsSync)) continue;
    filtered.push(trimmed);
  }
  return filtered;
}

export function createPortReconciliationWarningLogger(
  logger: PortReconciliationLogger,
  maxWarningKeys = 512
): (key: string, message: string, ...args: unknown[]) => void {
  const warnedKeys = new Set<string>();
  let warnedAboutOverflow = false;

  return (key: string, message: string, ...args: unknown[]): void => {
    if (warnedKeys.has(key)) return;

    if (warnedKeys.size >= maxWarningKeys) {
      if (!warnedAboutOverflow) {
        warnedAboutOverflow = true;
        logger.warn(
          'Suppressing additional port reconciliation warnings after %d unique keys.',
          maxWarningKeys
        );
      }
      return;
    }

    warnedKeys.add(key);
    logger.warn(message, ...args);
  };
}
