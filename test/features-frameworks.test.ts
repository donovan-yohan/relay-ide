import { describe, expect, it } from 'vitest';
import {
  decorateManifestWithFrameworks,
  probeFrameworks,
} from '../server/features/frameworks.js';
import {
  getCoreNodeManifest,
  getNodeManifest,
} from '../server/node-manifest.js';

describe('frameworks feature', () => {
  it('core manifest has an empty agents map (no framework knowledge)', async () => {
    const manifest = await getCoreNodeManifest({
      env: process.env,
      hostname: 'core-host',
      relayVersion: '0.1.0-test',
    });
    expect(manifest.capabilities.agents).toEqual({});
  });

  it('decorateManifestWithFrameworks layers an agents map onto a core manifest', async () => {
    const core = await getCoreNodeManifest({
      env: process.env,
      hostname: 'core-host',
      relayVersion: '0.1.0-test',
    });
    expect(core.capabilities.agents).toEqual({});

    const decorated = await decorateManifestWithFrameworks(core, {
      env: process.env,
    });
    // The default framework registry always reports at least one
    // entry (claude / codex / opencode / hermes by default; even
    // unavailable ones surface as 'unavailable' probes). Don't assert
    // specific ids here — that's #437's job.
    expect(Object.keys(decorated.capabilities.agents).length).toBeGreaterThan(
      0
    );
    // Input not mutated.
    expect(core.capabilities.agents).toEqual({});
  });

  it('getNodeManifest (back-compat entry) returns a decorated manifest matching the old shape', async () => {
    const manifest = await getNodeManifest({
      env: process.env,
      hostname: 'compat-host',
      relayVersion: '0.1.0-test',
    });
    expect(Object.keys(manifest.capabilities.agents).length).toBeGreaterThan(0);
    // Other capability fields still present.
    expect(manifest.capabilities.tmux).toBeDefined();
    expect(manifest.capabilities.git).toBeDefined();
  });

  it('probeFrameworks returns a probe map keyed by framework id', async () => {
    const probes = await probeFrameworks(undefined, process.env);
    for (const [id, probe] of Object.entries(probes)) {
      expect(probe.id).toBe(id);
      expect(probe.status).toMatch(/available|degraded|unavailable|unknown/);
    }
  });
});
