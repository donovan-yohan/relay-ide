// EnvPickerLauncher (#862) — thin wrapper that owns the env-picker option
// derivation and renders <EnvPickerDialog> as the command-palette / empty-state
// terminal launcher. Lives as its own component (rather than inline in App) so
// the `['hub-nodes']` + `['repo-inventory']` `useQuery` calls in
// `useEnvPickerOptions` run INSIDE the `<QueryClientProvider>` boundary — App
// renders that provider in its own return, so calling those hooks in App's body
// would sit outside it.
//
// Terminal MVP scope (#862): always launches a bare shell
// (`launchOverrides={{ type: 'terminal' }}`); agent-provider selection is #863.

import React from 'react';

import EnvPickerDialog from './EnvPickerDialog.js';
import {
  useEnvPickerOptions,
  type UseEnvPickerOptionsInput,
} from '../../lib/hooks/use-env-picker-options.js';
import type { LaunchEnvironmentResult } from '../../lib/launch-environment.js';

export interface EnvPickerLauncherProps {
  open: boolean;
  onClose: () => void;
  /** Agent the picker gates capability-missing reasons against. */
  selectedAgent: UseEnvPickerOptionsInput['selectedAgent'];
  /** Active workspace fallback when inventory is empty (optional). */
  fallbackWorkspace?: UseEnvPickerOptionsInput['fallbackWorkspace'];
  fallbackWorktreePath?: UseEnvPickerOptionsInput['fallbackWorktreePath'];
  /** Called after a successful launch so callers can navigate to the session. */
  onLaunched?: (result: LaunchEnvironmentResult) => void;
}

export function EnvPickerLauncher({
  open,
  onClose,
  selectedAgent,
  fallbackWorkspace,
  fallbackWorktreePath,
  onLaunched,
}: EnvPickerLauncherProps) {
  const options = useEnvPickerOptions({
    selectedAgent,
    ...(fallbackWorkspace !== undefined ? { fallbackWorkspace } : {}),
    ...(fallbackWorktreePath !== undefined ? { fallbackWorktreePath } : {}),
  });

  return (
    <EnvPickerDialog
      open={open}
      options={options}
      onClose={onClose}
      launchOverrides={{ type: 'terminal' }}
      {...(onLaunched ? { onLaunched } : {})}
    />
  );
}

export default EnvPickerLauncher;
