// View-spine Bench scaffold (#444 Lane B). Replaces "worktree" as the cwd+env
// layer; for repo-kind instances a Bench is a git worktree, for node-kind
// instances it is an arbitrary cwd.

import type { InstanceId } from './project.js';

export type BenchId = string;

export interface Bench {
  id: BenchId;
  instanceId: InstanceId;
  // Anchored cwd within the instance host. Required — a Bench without a cwd
  // is not a Bench, it's a Tab inheriting Instance defaults.
  cwd: string;
  // User-visible label. Branch name for git-worktree benches; free-form
  // otherwise. The derivation rule lives at the UI layer.
  label: string;
  // Env overrides layered on top of Instance defaults. Empty record means
  // "no override", not "clear env."
  envOverrides: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

export function createBenchId(instanceId: InstanceId, cwd: string): BenchId {
  if (!hasValue(instanceId)) throw new Error('instanceId is required');
  if (!hasValue(cwd)) throw new Error('cwd is required');
  return `bench:${encodeURIComponent(instanceId)}:${encodeURIComponent(cwd)}`;
}

export function parseBenchId(
  id: BenchId
): { instanceId: InstanceId; cwd: string } | null {
  if (!id.startsWith('bench:')) return null;
  const rest = id.slice('bench:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  try {
    const instanceId = decodeURIComponent(rest.slice(0, sep));
    const cwd = decodeURIComponent(rest.slice(sep + 1));
    if (!hasValue(instanceId) || !hasValue(cwd)) return null;
    return { instanceId, cwd };
  } catch {
    return null;
  }
}
