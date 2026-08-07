import { describe, expect, it, vi } from 'vitest';

import {
  PersistenceStartupError,
  initializePersistenceStores,
  type PersistenceStoreDescriptor,
} from '../server/persistence-startup.js';

function descriptors(): PersistenceStoreDescriptor<unknown>[] {
  return [
    {
      name: 'relay-state',
      criticality: 'core',
      initialize: () => ({ ready: true }),
    },
    {
      name: 'analytics',
      criticality: 'optional',
      initialize: () => ({ ready: true }),
    },
  ];
}

describe('persistence startup collector', () => {
  it('fails boot before listening by default when an injected core factory throws', () => {
    const warn = vi.fn();

    expect(() =>
      initializePersistenceStores(descriptors(), {
        logger: { warn },
        failureInjector: (descriptor) =>
          descriptor.name === 'relay-state'
            ? new Error('test persistence factory failure')
            : undefined,
      })
    ).toThrow(PersistenceStartupError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('also fails by default when only an optional SQLite store is disabled', () => {
    const warn = vi.fn();

    expect(() =>
      initializePersistenceStores(descriptors(), {
        logger: { warn },
        failureInjector: (descriptor) =>
          descriptor.name === 'analytics'
            ? new Error('test optional persistence factory failure')
            : undefined,
      })
    ).toThrow(PersistenceStartupError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('collapses multiple degraded store failures into one warning summary', () => {
    const warn = vi.fn();
    const state = initializePersistenceStores(descriptors(), {
      allowDegraded: true,
      logger: { warn },
      failureInjector: () => new Error('Module did not self-register'),
    });

    expect(state.isDegraded).toBe(true);
    expect(state.disabledStores).toEqual(['relay-state', 'analytics']);
    expect(state.coreFailures.map((failure) => failure.name)).toEqual([
      'relay-state',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'persistence degraded: 2/2 stores failed to init: [relay-state, analytics] — Module did not self-register'
    );
  });

  it('summarizes a better-sqlite3 ABI failure with running Node and rebuild guidance', () => {
    const warn = vi.fn();
    initializePersistenceStores(descriptors(), {
      allowDegraded: true,
      logger: { warn },
      failureInjector: () =>
        new Error(
          'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
        ),
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`running Node ${process.version}`)
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('npm rebuild better-sqlite3')
    );
  });

  it('keeps normal persistence startup healthy without a warning', () => {
    const warn = vi.fn();
    const state = initializePersistenceStores(descriptors(), {
      logger: { warn },
    });

    expect(state.isDegraded).toBe(false);
    expect(state.disabledStores).toEqual([]);
    expect(state.get<{ ready: boolean }>('relay-state')).toEqual({
      ready: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
