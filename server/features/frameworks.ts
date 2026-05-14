import type { Config } from '../types.js';
import {
  getFrameworkClientInfoWithRuntime,
  type FrameworkClientInfo,
} from '../frameworks.js';
import type {
  NodeCapabilityProbe,
  NodeManifest,
} from '../../shared/node-manifest.js';

// Framework / agent capability probing. Lives outside core because
// "what counts as an agent framework" is feature-layer policy
// (arbitrary IDs once #437 lands; today the registry ships with a
// default set).
//
// Core builds a manifest with `agents: {}`. This feature decorates the
// manifest by populating the `agents` map after probing the configured
// framework registry. Callers wire the decorator in via the
// composition root, or use the back-compat helper `getNodeManifest`
// exported from `server/node-manifest.ts` which calls
// `decorateManifestWithFrameworks` below.

function frameworkProbeFromClientInfo(
  framework: FrameworkClientInfo
): NodeCapabilityProbe {
  const availability = framework.availability;
  if (!availability?.installed) {
    return {
      id: framework.id,
      label: framework.displayName,
      status: 'unavailable',
      message:
        availability?.reason ?? `${framework.displayName} is not installed.`,
    };
  }
  if (framework.webAvailability && !framework.webAvailability.available) {
    return {
      id: framework.id,
      label: framework.displayName,
      status: 'degraded',
      message:
        framework.webAvailability.reason ??
        'CLI is installed but web runtime probe failed.',
      ...(availability.path ? { path: availability.path } : {}),
    };
  }
  return {
    id: framework.id,
    label: framework.displayName,
    status: 'available',
    message: `${framework.displayName} CLI is available.`,
    ...(availability.path ? { path: availability.path } : {}),
  };
}

export async function probeFrameworks(
  config: Pick<Config, 'frameworks'> | undefined,
  env: NodeJS.ProcessEnv
): Promise<Record<string, NodeCapabilityProbe>> {
  try {
    const frameworks = await getFrameworkClientInfoWithRuntime(
      config?.frameworks,
      env
    );
    return Object.fromEntries(
      frameworks.map((framework) => [
        framework.id,
        frameworkProbeFromClientInfo(framework),
      ])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      frameworks: {
        id: 'frameworks',
        label: 'Agent framework registry',
        status: 'degraded',
        message: `Agent framework probes failed non-fatally: ${message}`,
      },
    };
  }
}

export interface FrameworkDecorationOptions {
  config?: Pick<Config, 'frameworks'> | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decorate a core manifest (one whose `capabilities.agents` is empty)
 * with the probed framework registry. Returns a new manifest object;
 * input is not mutated.
 */
export async function decorateManifestWithFrameworks(
  manifest: NodeManifest,
  options: FrameworkDecorationOptions = {}
): Promise<NodeManifest> {
  const env = options.env ?? process.env;
  const agents = await probeFrameworks(options.config, env);
  return {
    ...manifest,
    capabilities: {
      ...manifest.capabilities,
      agents,
    },
  };
}

export { frameworkProbeFromClientInfo };
