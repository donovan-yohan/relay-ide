// EnvPickerLauncher (#862) — thin wrapper that owns the env-picker option
// derivation and renders <EnvPickerDialog> as the command-palette / empty-state
// launcher. Lives as its own component (rather than inline in App) so
// the `['hub-nodes']` + `['repo-inventory']` `useQuery` calls in
// `useEnvPickerOptions` run INSIDE the `<QueryClientProvider>` boundary — App
// renders that provider in its own return, so calling those hooks in App's body
// would sit outside it.
//
// #862 shipped terminal-only launch. #863 adds agent launches WITHOUT changing
// the option list: the derived options stay `sessionType: 'terminal'` (see
// `useEnvPickerOptions`), so every fresh node row remains launchable for a bare
// shell even when its agent providers are unavailable (acceptance: unavailable
// agents must not block terminal launch). The launch *kind* is carried by the
// `launchOverrides` the dialog forwards to `launchEnvironment`:
//   - `{ type: 'terminal' }`            → bare shell (default, #862 behaviour)
//   - `{ type: 'agent', agent: <id> }`  → agent launch; the provider is gated
//     fail-closed at the launch boundary against `option.node.agentProviders`.
// The caller decides which kind to request via the `launchOverrides` prop;
// when omitted we default to terminal so existing #862 call sites are unchanged.

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
  /** Agent the picker gates capability-missing reasons against. */
  selectedAgent: UseEnvPickerOptionsInput['selectedAgent'];
  /** Active workspace fallback when inventory is empty (optional). */
  fallbackWorkspace?: UseEnvPickerOptionsInput['fallbackWorkspace'];
  fallbackWorktreePath?: UseEnvPickerOptionsInput['fallbackWorktreePath'];
  /**
   * Launch shape forwarded to `EnvPickerDialog` → `launchEnvironment`. Defaults
   * to `{ type: 'terminal' }` (#862 bare-shell behaviour). Pass
   * `{ type: 'agent', agent: <providerId> }` to request an agent launch; the
   * provider is enforced fail-closed at the launch boundary, not here.
   */
  launchOverrides?: LaunchEnvironmentOptions;
  /** Called after a successful launch so callers can navigate to the session. */
  onLaunched?: (result: LaunchEnvironmentResult) => void;
}

export function EnvPickerLauncher({
  open,
  onClose,
  selectedAgent,
  fallbackWorkspace,
  fallbackWorktreePath,
  launchOverrides = { type: 'terminal' },
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
      launchOverrides={launchOverrides}
      {...(onLaunched ? { onLaunched } : {})}
    />
  );
}

export default EnvPickerLauncher;
