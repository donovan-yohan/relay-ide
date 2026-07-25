import type { Logger } from './logger.js';

export type PersistenceStoreCriticality = 'core' | 'optional';

export interface PersistenceStoreDescriptor<T> {
  /** Stable operator-facing identifier; also used by test-only failure injection. */
  name: string;
  criticality: PersistenceStoreCriticality;
  initialize: () => T;
  /**
   * Some legacy routes require a callable unavailable-store object rather than
   * null. The persistence state remains disabled even when this fallback is
   * supplied.
   */
  unavailable?: (cause: unknown) => T;
}

export interface PersistenceStoreFailure {
  name: string;
  criticality: PersistenceStoreCriticality;
  cause: string;
}

export interface PersistenceFailureInjector {
  (descriptor: Pick<PersistenceStoreDescriptor<unknown>, 'name'>):
    | Error
    | undefined;
}

export interface PersistenceStartupOptions {
  allowDegraded?: boolean;
  logger: Pick<Logger, 'warn'>;
  failureInjector?: PersistenceFailureInjector;
}

/**
 * The finalized persistence state is immutable for the lifetime of one hub
 * process. It is deliberately small so health/auth can report the truth
 * without coupling to every store implementation.
 */
export class PersistenceStartupState {
  readonly disabledStores: readonly string[];
  readonly failures: readonly PersistenceStoreFailure[];
  readonly coreFailures: readonly PersistenceStoreFailure[];
  readonly totalStores: number;
  private readonly values: ReadonlyMap<string, unknown>;

  constructor(input: {
    values: ReadonlyMap<string, unknown>;
    failures: readonly PersistenceStoreFailure[];
    totalStores: number;
  }) {
    this.values = input.values;
    this.failures = input.failures;
    this.disabledStores = input.failures.map((failure) => failure.name);
    this.coreFailures = input.failures.filter(
      (failure) => failure.criticality === 'core'
    );
    this.totalStores = input.totalStores;
  }

  get isDegraded(): boolean {
    return this.disabledStores.length > 0;
  }

  get<T>(name: string): T | null {
    if (!this.values.has(name)) return null;
    return this.values.get(name) as T;
  }
}

/** Error intentionally formatted for one concise fatal startup log line. */
export class PersistenceStartupError extends Error {
  constructor(
    readonly state: PersistenceStartupState
  ) {
    super(
      `persistence initialization failed before listening: ${formatPersistenceFailureSummary(
        state.failures,
        state.totalStores
      )}. Rebuild the persistence layer or start explicitly degraded with --allow-degraded (RELAY_IDE_ALLOW_DEGRADED=1).`
    );
    this.name = 'PersistenceStartupError';
  }
}

export function isAllowDegradedPersistence(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  return (
    env['RELAY_IDE_ALLOW_DEGRADED'] === '1' ||
    argv.includes('--allow-degraded')
  );
}

/**
 * Child startup tests can fail named factories without corrupting a database.
 * This is deliberately inert outside NODE_ENV=test.
 */
export function persistenceFailureInjectorFromTestEnvironment(
  env: NodeJS.ProcessEnv = process.env
): PersistenceFailureInjector | undefined {
  if (env['NODE_ENV'] !== 'test') return undefined;
  const names = new Set(
    (env['RELAY_IDE_TEST_FAIL_PERSISTENCE_STORES'] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );
  if (names.size === 0) return undefined;
  return (descriptor) =>
    names.has(descriptor.name)
      ? new Error(`test persistence factory failure for ${descriptor.name}`)
      : undefined;
}

/**
 * Runs every synchronous boot-time SQLite factory exactly once, records all
 * failures, and emits at most one warning only for explicitly allowed
 * degraded boot. Core marks the amnesiac-hub boundary for operators, but the
 * strict default applies to every SQLite store: without opt-in, no caller
 * receives a state and thus no listener can be started with disabled
 * persistence.
 */
export function initializePersistenceStores(
  descriptors: readonly PersistenceStoreDescriptor<unknown>[],
  options: PersistenceStartupOptions
): PersistenceStartupState {
  const values = new Map<string, unknown>();
  const failures: PersistenceStoreFailure[] = [];

  for (const descriptor of descriptors) {
    try {
      const injected = options.failureInjector?.(descriptor);
      if (injected) throw injected;
      values.set(descriptor.name, descriptor.initialize());
    } catch (err) {
      failures.push({
        name: descriptor.name,
        criticality: descriptor.criticality,
        cause: normalizeFailureCause(err),
      });
      values.set(
        descriptor.name,
        descriptor.unavailable ? descriptor.unavailable(err) : null
      );
    }
  }

  const state = new PersistenceStartupState({
    values,
    failures,
    totalStores: descriptors.length,
  });
  if (!state.isDegraded) return state;

  if (!options.allowDegraded) {
    throw new PersistenceStartupError(state);
  }

  options.logger.warn(
    formatPersistenceFailureSummary(state.failures, state.totalStores)
  );
  return state;
}

export function formatPersistenceFailureSummary(
  failures: readonly PersistenceStoreFailure[],
  totalStores: number
): string {
  const names = failures.map((failure) => failure.name).join(', ');
  return `persistence degraded: ${failures.length}/${totalStores} stores failed to init: [${names}] — ${summarizeFailureCauses(failures)}`;
}

function summarizeFailureCauses(
  failures: readonly PersistenceStoreFailure[]
): string {
  const causes = Array.from(new Set(failures.map((failure) => failure.cause)));
  const joined = causes.join('; ');
  if (
    causes.some((cause) =>
      /NODE_MODULE_VERSION|was compiled against a different Node\.js version|better-sqlite3.*(?:module|version)/i.test(
        cause
      )
    )
  ) {
    return `better-sqlite3 native module ABI mismatch (running Node ${process.version}); run npm rebuild better-sqlite3. ${joined}`;
  }
  return joined;
}

function normalizeFailureCause(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, ' ').trim() || 'unknown initialization failure';
}
