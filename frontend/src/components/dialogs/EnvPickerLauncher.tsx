// EnvPickerLauncher (#862) — thin wrapper that owns the env-picker option
// derivation and renders <EnvPickerDialog> as the command-palette / empty-state
// launcher. Lives as its own component (rather than inline in App) so
// the `['hub-nodes']` + `['repo-inventory']` `useQuery` calls in
// `useEnvPickerOptions` run INSIDE the `<QueryClientProvider>` boundary — App
// renders that provider in its own return, so calling those hooks in App's body
// would sit outside it.
//
// The environment picker is terminal-only. Agent work opens in a channel/DM.

import React from 'react';

import EnvPickerDialog from './EnvPickerDialog.js';
import {
  useEnvPickerOptions,
  type UseEnvPickerOptionsInput,
} from '../../lib/hooks/use-env-picker-options.js';
import type {
  LaunchEnvironmentOptions,
  LaunchEnvironmentResult,
} from '../../lib/launch-environment.js';

export interface EnvPickerLauncherProps {
  open: boolean;
  onClose: () => void;
  /** Active workspace fallback when inventory is empty (optional). */
  fallbackWorkspace?: UseEnvPickerOptionsInput['fallbackWorkspace'];
  fallbackWorktreePath?: UseEnvPickerOptionsInput['fallbackWorktreePath'];
  /** Terminal launch shape forwarded to the environment launcher. */
  launchOverrides?: LaunchEnvironmentOptions;
  /** Called after a successful launch so callers can navigate to the session. */
  onLaunched?: (result: LaunchEnvironmentResult) => void;
}

export function EnvPickerLauncher({
  open,
  onClose,
  fallbackWorkspace,
  fallbackWorktreePath,
  launchOverrides = { type: 'terminal' },
  onLaunched,
}: EnvPickerLauncherProps) {
  const options = useEnvPickerOptions({
    ...(fallbackWorkspace !== undefined ? { fallbackWorkspace } : {}),
    ...(fallbackWorktreePath !== undefined ? { fallbackWorktreePath } : {}),
  });

  return (
    <EnvPickerDialog
      open={open}
      options={options}
      onClose={onClose}
      launchOverrides={launchOverrides}
      {...(onLaunched ? { onLaunched } : {})}
    />
  );
}

export default EnvPickerLauncher;
