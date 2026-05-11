import type { RepoIdentity } from './identity.js';

export type RemoteProvider = 'github' | 'git';
export type RepoIdentityWarning =
  | 'missing-remotes'
  | 'multiple-remotes'
  | 'malformed-remote-url'
  | 'fork-upstream-ambiguity'
  | 'selected-non-origin-remote';

export interface RemoteDescriptor {
  name: string;
  url: string;
}

export interface NormalizedRemoteIdentity {
  identity: RepoIdentity | null;
  provider: RemoteProvider | null;
  host: string | null;
  path: string | null;
  owner: string | null;
  name: string | null;
  warning?: RepoIdentityWarning;
}

export interface ResolvedRemoteIdentity extends RemoteDescriptor {
  identity: RepoIdentity | null;
  provider: RemoteProvider | null;
  host: string | null;
  path: string | null;
  owner: string | null;
  repoName: string | null;
  warning?: RepoIdentityWarning;
}

export interface CanonicalRepoIdentityResolution {
  identity: RepoIdentity | null;
  selectedRemote: ResolvedRemoteIdentity | null;
  remotes: ResolvedRemoteIdentity[];
  warnings: RepoIdentityWarning[];
}

interface ParsedRemoteUrl {
  host: string;
  path: string;
}

function stripGitSuffix(remotePath: string): string {
  return remotePath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

function parseUrlRemote(rawUrl: string): ParsedRemoteUrl | null {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname) return null;
    const remotePath = stripGitSuffix(parsed.pathname);
    if (!remotePath) return null;
    return { host: parsed.hostname.toLowerCase(), path: remotePath };
  } catch {
    return null;
  }
}

function parseScpLikeRemote(rawUrl: string): ParsedRemoteUrl | null {
  if (/\s/.test(rawUrl)) return null;
  const match = rawUrl.match(/^(?:[^@/:]+@)?([^:/]+):(.+)$/);
  const host = match?.[1]?.toLowerCase();
  const rawPath = match?.[2];
  if (!host || !rawPath) return null;
  const remotePath = stripGitSuffix(rawPath);
  if (!remotePath || remotePath.includes(':')) return null;
  return { host, path: remotePath };
}

function parseRemote(rawUrl: string): ParsedRemoteUrl | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  return parseUrlRemote(trimmed) ?? parseScpLikeRemote(trimmed);
}

export function normalizeRemoteUrl(rawUrl: string): NormalizedRemoteIdentity {
  const parsed = parseRemote(rawUrl);
  if (!parsed) {
    return {
      identity: null,
      provider: null,
      host: null,
      path: null,
      owner: null,
      name: null,
      warning: 'malformed-remote-url',
    };
  }

  const segments = parsed.path.split('/').filter(Boolean);
  const repoName = segments[segments.length - 1] ?? null;
  if (!repoName) {
    return {
      identity: null,
      provider: null,
      host: parsed.host,
      path: parsed.path,
      owner: null,
      name: null,
      warning: 'malformed-remote-url',
    };
  }

  if (parsed.host === 'github.com') {
    const owner = segments[0]?.toLowerCase() ?? null;
    const name = segments[1]?.toLowerCase() ?? null;
    if (!owner || !name) {
      return {
        identity: null,
        provider: null,
        host: parsed.host,
        path: parsed.path,
        owner,
        name,
        warning: 'malformed-remote-url',
      };
    }
    return {
      identity: `github.com/${owner}/${name}`,
      provider: 'github',
      host: parsed.host,
      path: `${owner}/${name}`,
      owner,
      name,
    };
  }

  return {
    identity: `${parsed.host}/${parsed.path}`,
    provider: 'git',
    host: parsed.host,
    path: parsed.path,
    owner: segments.length > 1 ? (segments[0] ?? null) : null,
    name: repoName,
  };
}

function toResolvedRemote(remote: RemoteDescriptor): ResolvedRemoteIdentity {
  const normalized = normalizeRemoteUrl(remote.url);
  return {
    name: remote.name,
    url: remote.url,
    identity: normalized.identity,
    provider: normalized.provider,
    host: normalized.host,
    path: normalized.path,
    owner: normalized.owner,
    repoName: normalized.name,
    ...(normalized.warning ? { warning: normalized.warning } : {}),
  };
}

function uniqueWarnings(warnings: RepoIdentityWarning[]): RepoIdentityWarning[] {
  return Array.from(new Set(warnings));
}

/**
 * Resolve a logical repository identity from configured remotes.
 *
 * Selection policy:
 * - prefer a valid `origin` remote;
 * - otherwise use the lexicographically first valid remote and warn;
 * - never invent a canonical identity from the local path/basename.
 *
 * Warning policy is intentionally conservative for federated/node-aware Relay:
 * multiple remotes are surfaced, malformed URLs are kept in the remote list,
 * and different origin/upstream identities emit `fork-upstream-ambiguity` so
 * callers can distinguish "this checkout path" from "the logical upstream".
 */
export function resolveCanonicalRepoIdentity(
  remotes: RemoteDescriptor[]
): CanonicalRepoIdentityResolution {
  const normalizedRemotes = remotes.map(toResolvedRemote);
  const validRemotes = normalizedRemotes.filter((remote) => remote.identity !== null);
  const warnings: RepoIdentityWarning[] = [];

  if (normalizedRemotes.length === 0) warnings.push('missing-remotes');
  if (normalizedRemotes.length > 1) warnings.push('multiple-remotes');
  if (normalizedRemotes.some((remote) => remote.warning === 'malformed-remote-url')) {
    warnings.push('malformed-remote-url');
  }

  const origin = validRemotes.find((remote) => remote.name === 'origin');
  const selected =
    origin ??
    Array.from(validRemotes).sort((a, b) => a.name.localeCompare(b.name))[0] ??
    null;

  if (selected && selected.name !== 'origin') {
    warnings.push('selected-non-origin-remote');
  }

  const originRemote = validRemotes.find((remote) => remote.name === 'origin');
  const upstreamRemote = validRemotes.find((remote) => remote.name === 'upstream');
  if (
    originRemote?.identity &&
    upstreamRemote?.identity &&
    originRemote.identity !== upstreamRemote.identity
  ) {
    warnings.push('fork-upstream-ambiguity');
  }

  return {
    identity: selected?.identity ?? null,
    selectedRemote: selected,
    remotes: normalizedRemotes,
    warnings: uniqueWarnings(warnings),
  };
}

export function parseGitRemoteVerbose(stdout: string): RemoteDescriptor[] {
  const byName = new Map<string, RemoteDescriptor>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/);
    const remoteName = match?.[1];
    const url = match?.[2];
    if (!remoteName || !url || byName.has(remoteName)) continue;
    byName.set(remoteName, { name: remoteName, url });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
