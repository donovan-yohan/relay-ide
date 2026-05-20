// repo-to-environment (#630) — minimal adapter that derives an
// `EnvironmentOption` list from the locally-known `Repo` projection in the
// sessions store. This is a stopgap until the full env-inventory backend
// (epic #615) lands; today the frontend has no separate environment feed,
// but every known repo is a valid launch target on the local node, and the
// picker is most useful immediately rather than after the inventory work
// completes.
//
// When the full inventory feed lands, App should pass the inventory-derived
// option list directly to <EnvPickerDialog> and this module can be deleted
// (or repurposed as a fallback). Until then, the contract is:
//
//   - One option per known Repo on the local node.
//   - One always-available "free / non-git cwd" option for home directory
//     launches.
//   - All options surface as `fresh` for now (the local node is by
//     definition reachable; node staleness is a remote-node concept this
//     stopgap does not model).
//
// The downstream `launchEnvironment` hook still enforces the
// "never silently switch nodes" invariant by re-checking freshness at the
// launch boundary.

import {
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  type EnvironmentOption,
} from '../../../shared/environment-option.js';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { Repo } from './types.js';

const HOME_FALLBACK_CWD = '~';

/**
 * Map a Repo from the sessions store to an EnvironmentOption. Free (non-git)
 * directories are treated as `cwdMode: 'free'` with no `repoInstance`.
 */
export function repoToEnvironmentOption(
  repo: Repo,
  generatedAt: string
): EnvironmentOption {
  const nodeId = repo.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const localPath = repo.localPath ?? repo.path;
  const optionId = `${nodeId}::${repo.repoInstanceId ?? localPath}`;
  if (!repo.isGitRepo) {
    return {
      schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
      id: optionId,
      node: {
        nodeId,
        kind: nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
        displayName: nodeId,
        online: true,
      },
      capabilities: ['session:create:terminal'],
      cwd: localPath,
      cwdMode: 'free',
      freshness: 'fresh',
      generatedAt,
    };
  }
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: optionId,
    node: {
      nodeId,
      kind: nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
      displayName: nodeId,
      online: true,
    },
    capabilities: ['session:create:terminal', 'rpc:git:read'],
    cwd: localPath,
    cwdMode: 'repo',
    freshness: 'fresh',
    repoInstance: {
      repoInstanceId: repo.repoInstanceId ?? `${nodeId}:${localPath}`,
      localPath,
      repoIdentity: repo.repoIdentity ?? null,
      name: repo.name,
      currentBranch: repo.currentBranch,
      defaultBranch: repo.defaultBranch,
    },
    generatedAt,
  };
}

/**
 * Build the candidate list <EnvPickerDialog> consumes: one option per known
 * repo plus a single "free home" option for non-repo launches.
 */
export function reposToEnvironmentOptions(
  repos: readonly Repo[],
  generatedAt: string = new Date().toISOString()
): EnvironmentOption[] {
  const opts = repos.map((repo) => repoToEnvironmentOption(repo, generatedAt));
  // Always offer a free / non-git cwd entry so the user can launch into a
  // bare shell on their home dir without having a Repo registered.
  opts.push({
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id: `${DEFAULT_LOCAL_NODE_ID}::__home__`,
    node: {
      nodeId: DEFAULT_LOCAL_NODE_ID,
      kind: 'local',
      displayName: DEFAULT_LOCAL_NODE_ID,
      online: true,
    },
    capabilities: ['session:create:terminal'],
    cwd: HOME_FALLBACK_CWD,
    cwdMode: 'free',
    freshness: 'fresh',
    generatedAt,
  });
  return opts;
}
