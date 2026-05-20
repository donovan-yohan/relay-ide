// Shared barrel — currently a minimal re-export surface for cross-cutting
// types added during the #615 environment picker work. Existing modules are
// still imported by direct file path elsewhere in the codebase; new shared
// surfaces that span backend + frontend should also re-export from here so
// the picker has one stable import path.

export {
  ENVIRONMENT_DEGRADED_REASONS,
  ENVIRONMENT_FRESHNESS_VALUES,
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  hasBench,
  hasRepoInstance,
  isEnvironmentDegradedReason,
  isEnvironmentFreshness,
  isEnvironmentOption,
  type EnvironmentBenchSummary,
  type EnvironmentCwdMode,
  type EnvironmentDegradedReason,
  type EnvironmentDegradedReasonKind,
  type EnvironmentFreshness,
  type EnvironmentNodeSummary,
  type EnvironmentOption,
  type EnvironmentRepoInstanceSummary,
} from './environment-option.js';

export {
  normalizeRemoteUrl,
  resolveCanonicalRepoIdentity,
  type CanonicalRepoIdentityResolution,
  type NormalizedRemoteIdentity,
  type RemoteDescriptor,
  type RemoteProvider,
  type RepoIdentityWarning,
  type ResolvedRemoteIdentity,
} from './repo-identity.js';

export {
  aggregateRepoInventoryReports,
  isRepoInventoryReport,
  summarizeRepoIdentityGroups,
  type AggregatedRepoInventoryGroup,
  type AggregatedRepoInventoryResponse,
  type RepoIdentityGroup,
  type RepoIdentityGroupInstance,
  type RepoIdentityGroupsResponse,
  type RepoInventoryRepoInstance,
  type RepoInventoryReport,
  type RepoInventoryWorktreeInstance,
} from './repo-inventory.js';

export {
  pickDefaultEnvironment,
  type ActiveTabContext,
  type EnvironmentHistoryEntry,
  type PickDefaultEnvironmentError,
  type PickDefaultEnvironmentErrorReason,
  type PickDefaultEnvironmentInput,
  type PickDefaultEnvironmentOk,
  type PickDefaultEnvironmentOkReason,
  type PickDefaultEnvironmentResult,
} from './safe-defaults.js';
