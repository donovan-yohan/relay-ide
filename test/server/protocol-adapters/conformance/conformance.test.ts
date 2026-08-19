/**
 * Adapter conformance suite — the offline floor every registered
 * `ProtocolAdapterV2` must clear.
 *
 * Discovery is the drift guard: the suite iterates `v2Adapters` itself, so
 * registering an adapter without a conformance fixture fails here with an
 * actionable message, and deleting/renaming an adapter orphans its fixture.
 * Per-adapter deep tests stay authoritative for their own quirks; this suite
 * only asserts the contract the repo states in prose.
 *
 * Run: `npx vitest run test/server/protocol-adapters/conformance/`
 */
import { describe, expect, it } from 'vitest';
import { v2Adapters } from '../../../../server/protocol-adapters/index.js';
import type { ProtocolAdapterV2 } from '../../../../server/protocol-adapter-v2.js';
import { ALL_CAPABILITIES, describeAdapterConformance } from './harness.js';
import type { AdapterConformanceFixture } from './fixture-types.js';

declare global {
  interface ImportMeta {
    glob<T = unknown>(
      pattern: string,
      options: { eager: true }
    ): Record<string, T>;
  }
}

// Vite/vitest eager glob — no central registration file for fixture authors to
// conflict on. One file per adapter under `fixtures/`.
const fixtureModules = import.meta.glob<{ default: AdapterConformanceFixture }>(
  './fixtures/*.fixture.ts',
  { eager: true }
);

// The glob's type annotation is an unchecked cast, so `npm run check` cannot
// catch a fixture whose default export was renamed or dropped. Without this
// split such a file would still register its id — `fixtures.has(id)` true,
// value undefined — and silently delete that adapter's whole floor.
const fixtures = new Map<string, AdapterConformanceFixture>();
const defaultlessFixtureModules: string[] = [];
for (const [modulePath, module] of Object.entries(fixtureModules)) {
  const id = modulePath.replace(/^.*\/(.+)\.fixture\.ts$/, '$1');
  if (!module?.default) {
    defaultlessFixtureModules.push(modulePath);
    continue;
  }
  fixtures.set(id, module.default);
}

const adapterIds = Object.keys(v2Adapters);

describe('adapter conformance', () => {
  for (const adapterId of adapterIds) {
    describe(adapterId, () => {
      it('has a conformance fixture', () => {
        expect(
          fixtures.get(adapterId),
          `Registered adapter '${adapterId}' has no usable conformance fixture. ` +
            `Create test/server/protocol-adapters/conformance/fixtures/${adapterId}.fixture.ts ` +
            `with a default export ` +
            `(see fixture-types.ts for the contract and claude.fixture.ts for a worked example).`
        ).toBeTruthy();
      });

      const fixture = fixtures.get(adapterId);
      if (fixture) describeAdapterConformance(adapterId, fixture);
    });
  }

  it('every fixture module exports a default fixture', () => {
    expect(
      defaultlessFixtureModules,
      'a *.fixture.ts file has no default export — its adapter would silently lose its entire conformance floor'
    ).toEqual([]);
  });

  it('has no orphan fixtures', () => {
    const orphans = [...fixtures.keys()].filter((id) => !(id in v2Adapters));
    expect(
      orphans,
      'conformance fixture without a registered adapter (renamed or removed?)'
    ).toEqual([]);
  });

  it('capability reconciliation covers every flag a registered adapter declares', () => {
    const known = new Set<string>(ALL_CAPABILITIES);
    const missing = new Set<string>();
    for (const adapterId of adapterIds) {
      const adapter = (v2Adapters as Record<string, () => ProtocolAdapterV2>)[
        adapterId
      ]!();
      for (const flag of Object.keys(adapter.capabilities)) {
        if (!known.has(flag)) missing.add(`${adapterId}.${flag}`);
      }
    }
    expect(
      [...missing],
      'a registered adapter declares a capability flag the conformance table does not know — add it to ALL_CAPABILITIES (and a detector when one is possible)'
    ).toEqual([]);
  });
});
