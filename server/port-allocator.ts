/**
 * Port Allocator for Worktree Environments
 *
 * Provides durable port allocation with OS-level verification.
 * Ports are persisted to port-assignments.json under the user config
 * directory, scoped by config/workspace identity so local dev state never
 * lands in the repo root.
 *
 * Port ranges:
 * - Primary: 10000-10999 (1000 ports)
 * - Overflow: 11000-11999 (1000 ports)
 *
 * .env block utilities manage relay-ide port variable blocks while preserving
 * surrounding content.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import getPort from 'get-port';

const DEFAULT_PORT_VARIABLES = ['PORT'];

// ── Constants ─────────────────────────────────────────────────────────────

/** Primary port range start (inclusive) */
export const PORT_RANGE_START = 10000;
/** Primary port range end (exclusive) */
export const PORT_RANGE_END = 11000;
/** Overflow port range start (inclusive) */
export const OVERFLOW_RANGE_START = 11000;
/** Overflow port range end (exclusive) */
export const OVERFLOW_RANGE_END = 12000;

/** Marker for .env managed block start */
export const ENV_BLOCK_START =
  '# --- relay-ide managed ports (do not edit) ---';
/** Marker for .env managed block end */
export const ENV_BLOCK_END = '# --- end relay-ide managed ports ---';

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * A single port assignment for a worktree variable.
 */
export interface PortAssignment {
  repoId: string;
  worktreeId: string;
  variableName: string;
  port: number;
  verifiedAt: string; // ISO timestamp
}

/**
 * All port assignments persisted to disk.
 */
export interface PortAssignmentsFile {
  version: 1;
  assignments: PortAssignment[];
}

/**
 * Result of port verification check.
 */
export interface PortVerificationResult {
  port: number;
  available: boolean;
}

/**
 * Options for creating a PortAllocator.
 */
export interface PortAllocatorOptions {
  /** Path to config.json (used to derive config directory) */
  configPath: string;
  /** Variable names whose existing assignments should not be OS-verified/reassigned on initialize. */
  skipVerifyVariableNames?: string[] | undefined;
  /** Optional logger for debug/warn output */
  logger?:
    | {
        debug: (msg: string, ...args: unknown[]) => void;
        warn?: (msg: string, ...args: unknown[]) => void;
      }
    | undefined;
}

type PortAllocatorLogger = NonNullable<PortAllocatorOptions['logger']>;

interface LoadedAssignments {
  assignments: PortAssignmentsFile;
  source: 'none' | 'current' | 'legacy';
}

function userConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const baseDir = xdgConfigHome || path.join(os.homedir(), '.config');
  return path.join(baseDir, 'relay-ide');
}

function safeStateSlug(configPath: string): string {
  const configDir = path.dirname(path.resolve(configPath));
  const slug = path
    .basename(configDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'workspace';
}

function stateKeyForConfig(configPath: string): string {
  const configDir = path.dirname(path.resolve(configPath));
  const hash = crypto
    .createHash('sha256')
    .update(configDir)
    .digest('hex')
    .slice(0, 16);
  return `${safeStateSlug(configPath)}-${hash}`;
}

export function resolvePortAssignmentsPath(configPath: string): string {
  return path.join(
    userConfigDir(),
    'workspaces',
    stateKeyForConfig(configPath),
    'port-assignments.json'
  );
}

export function resolveLegacyPortAssignmentsPath(configPath: string): string {
  return path.join(
    path.dirname(path.resolve(configPath)),
    'port-assignments.json'
  );
}

function logWarn(
  logger: PortAllocatorLogger | undefined,
  message: string,
  ...args: unknown[]
): void {
  if (logger?.warn) {
    logger.warn(message, ...args);
    return;
  }
  logger?.debug(message, ...args);
}

function sanitizeOptionalPortVariables(
  variableNames?: string[] | null
): string[] {
  const seen = new Set<string>();
  return (variableNames ?? [])
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
    .filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

export function normalizePortVariables(
  variableNames?: string[] | null
): string[] {
  const normalized = sanitizeOptionalPortVariables(variableNames);
  return normalized.length > 0 ? normalized : [...DEFAULT_PORT_VARIABLES];
}

// ── Port Allocator Class ──────────────────────────────────────────────────

/**
 * Manages durable port allocation for worktrees.
 *
 * Ports are allocated from the primary range (10000-10999) first,
 * falling back to overflow range (11000-11999) if primary is exhausted.
 *
 * On initialization, existing assignments are verified against the OS
 * and reassigned if the port is no longer available.
 */
export class PortAllocator {
  private readonly assignmentsPath: string;
  private readonly legacyAssignmentsPath: string;
  private readonly logger:
    | { debug: (msg: string, ...args: unknown[]) => void }
    | undefined;
  private readonly skipVerifyVariableNames: Set<string>;
  private assignments: PortAssignmentsFile;
  private initialized = false;

  constructor(options: PortAllocatorOptions) {
    this.assignmentsPath = resolvePortAssignmentsPath(options.configPath);
    this.legacyAssignmentsPath = resolveLegacyPortAssignmentsPath(
      options.configPath
    );
    this.logger = options.logger;
    this.skipVerifyVariableNames = new Set(
      (options.skipVerifyVariableNames ?? []).filter(
        (name): name is string => typeof name === 'string' && name.trim() !== ''
      )
    );
    const loaded = this.loadAssignments();
    this.assignments = loaded.assignments;
    if (loaded.source === 'legacy') {
      this.saveAssignments();
      this.logger?.debug(
        'Migrated legacy port assignments into user config state:',
        this.assignmentsPath
      );
    }
  }

  /**
   * Initialize the allocator by verifying existing assignments.
   * Must be called before any allocation operations if verification is needed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.verifyAndReassignPorts();
    this.initialized = true;
  }

  /**
   * Allocate ports for a worktree.
   *
   * @param repoId - Repository identifier
   * @param worktreeId - Worktree identifier
   * @param variableNames - Names of port variables (e.g., ['PORT', 'VITE_PORT'])
   * @returns Map of variable names to allocated port numbers
   */
  async allocatePortsForWorktree(
    repoId: string,
    worktreeId: string,
    variableNames: string[]
  ): Promise<Record<string, number>> {
    const requestedVariables = normalizePortVariables(variableNames);
    const result: Record<string, number> = {};

    for (const varName of requestedVariables) {
      const port = await this.allocateSinglePort(repoId, worktreeId, varName);
      result[varName] = port;
    }

    this.saveAssignments();
    return result;
  }

  /**
   * Release all ports for a worktree.
   *
   * @param repoId - Repository identifier
   * @param worktreeId - Worktree identifier
   */
  releasePortsForWorktree(repoId: string, worktreeId: string): void {
    const before = this.assignments.assignments.length;
    this.assignments.assignments = this.assignments.assignments.filter(
      (a) => !(a.repoId === repoId && a.worktreeId === worktreeId)
    );
    if (this.assignments.assignments.length !== before) {
      this.saveAssignments();
    }
  }

  releasePortForWorktreeVariable(
    repoId: string,
    worktreeId: string,
    variableName: string
  ): void {
    const before = this.assignments.assignments.length;
    this.assignments.assignments = this.assignments.assignments.filter(
      (a) =>
        !(
          a.repoId === repoId &&
          a.worktreeId === worktreeId &&
          a.variableName === variableName
        )
    );
    if (this.assignments.assignments.length !== before) {
      this.saveAssignments();
    }
  }

  /**
   * Get all ports for a worktree.
   *
   * @param repoId - Repository identifier
   * @param worktreeId - Worktree identifier
   * @returns Map of variable names to port numbers, or null if none allocated
   */
  getPortsForWorktree(
    repoId: string,
    worktreeId: string
  ): Record<string, number> | null {
    const matching = this.assignments.assignments.filter(
      (a) => a.repoId === repoId && a.worktreeId === worktreeId
    );

    if (matching.length === 0) return null;

    const result: Record<string, number> = {};
    for (const a of matching) {
      result[a.variableName] = a.port;
    }
    return result;
  }

  /**
   * Reconcile a worktree's allocated ports against the currently requested
   * variable set.
   *
   * Existing allocations are preserved for variables still requested, stale
   * variable assignments are removed, and any newly requested variables are
   * allocated fresh ports. Optional preserved variables stay in allocator state
   * and in the returned env mapping if they already exist, but are not allocated
   * when absent.
   */
  async reconcilePortsForWorktree(
    repoId: string,
    worktreeId: string,
    variableNames: string[],
    preserveVariableNames?: string[]
  ): Promise<Record<string, number>> {
    const requestedVariables = new Set(normalizePortVariables(variableNames));
    const preservedVariables = new Set(
      sanitizeOptionalPortVariables(preserveVariableNames)
    );
    const variablesToKeep = new Set(
      Array.from(requestedVariables).concat(Array.from(preservedVariables))
    );
    const preserved = this.assignments.assignments.filter(
      (a) =>
        a.repoId === repoId &&
        a.worktreeId === worktreeId &&
        variablesToKeep.has(a.variableName)
    );

    this.assignments.assignments = this.assignments.assignments.filter(
      (a) =>
        a.repoId !== repoId ||
        a.worktreeId !== worktreeId ||
        variablesToKeep.has(a.variableName)
    );

    const result: Record<string, number> = {};
    for (const assignment of preserved) {
      result[assignment.variableName] = assignment.port;
    }

    for (const variableName of Array.from(requestedVariables)) {
      if (result[variableName] !== undefined) continue;
      result[variableName] = await this.allocateSinglePort(
        repoId,
        worktreeId,
        variableName
      );
    }

    this.saveAssignments();
    return result;
  }

  /**
   * Get all port assignments (for introspection/testing).
   */
  getAllAssignments(): PortAssignment[] {
    return [...this.assignments.assignments];
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  private loadAssignments(): LoadedAssignments {
    if (!fs.existsSync(this.assignmentsPath)) {
      if (
        this.legacyAssignmentsPath !== this.assignmentsPath &&
        fs.existsSync(this.legacyAssignmentsPath)
      ) {
        const legacy = this.readAssignmentsFile(this.legacyAssignmentsPath);
        if (legacy) return { assignments: legacy, source: 'legacy' };
      }
      return { assignments: { version: 1, assignments: [] }, source: 'none' };
    }

    const current = this.readAssignmentsFile(this.assignmentsPath);
    if (current) return { assignments: current, source: 'current' };

    return { assignments: { version: 1, assignments: [] }, source: 'none' };
  }

  private readAssignmentsFile(filePath: string): PortAssignmentsFile | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as PortAssignmentsFile;
      if (data.version === 1 && Array.isArray(data.assignments)) {
        return data;
      }
      logWarn(
        this.logger,
        'Invalid port assignments file version or shape, starting fresh:',
        filePath
      );
    } catch (err) {
      const backupPath = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch {
        // Best-effort backup only.
      }
      logWarn(
        this.logger,
        'Failed to load port assignments, starting fresh:',
        err,
        backupPath ? `backup=${backupPath}` : ''
      );
    }
    return null;
  }

  private saveAssignments(): void {
    const dir = path.dirname(this.assignmentsPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.assignmentsPath,
        JSON.stringify(this.assignments, null, 2),
        'utf8'
      );
    } catch (err) {
      logWarn(this.logger, 'Failed to save port assignments:', err);
      throw err;
    }
  }

  private async allocateSinglePort(
    repoId: string,
    worktreeId: string,
    variableName: string
  ): Promise<number> {
    // Check if already allocated - trust in-memory state (OS verification only on initialize)
    const existing = this.assignments.assignments.find(
      (a) =>
        a.repoId === repoId &&
        a.worktreeId === worktreeId &&
        a.variableName === variableName
    );

    if (existing) {
      // Port is already assigned - return without OS re-verification
      // OS verification happens during initialize() on startup
      return existing.port;
    }

    // Find next available port
    const usedPorts = new Set(this.assignments.assignments.map((a) => a.port));
    const port = await this.findAvailablePort(usedPorts);

    const assignment: PortAssignment = {
      repoId,
      worktreeId,
      variableName,
      port,
      verifiedAt: new Date().toISOString(),
    };
    this.assignments.assignments.push(assignment);

    return port;
  }

  private async findAvailablePort(usedPorts: Set<number>): Promise<number> {
    // Try primary range first
    for (let port = PORT_RANGE_START; port < PORT_RANGE_END; port++) {
      if (!usedPorts.has(port)) {
        const available = await this.isPortAvailable(port);
        if (available) return port;
      }
    }

    // Fall back to overflow range
    for (let port = OVERFLOW_RANGE_START; port < OVERFLOW_RANGE_END; port++) {
      if (!usedPorts.has(port)) {
        const available = await this.isPortAvailable(port);
        if (available) return port;
      }
    }

    // Let get-port pick any available port outside our ranges
    logWarn(
      this.logger,
      'All configured port ranges exhausted, falling back to OS-assigned port'
    );
    return getPort();
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    try {
      const allocated = await getPort({ port });
      return allocated === port;
    } catch {
      return false;
    }
  }

  private async verifyAndReassignPorts(): Promise<void> {
    const toReassign: PortAssignment[] = [];
    const verified: PortAssignment[] = [];

    for (const assignment of this.assignments.assignments) {
      if (this.skipVerifyVariableNames.has(assignment.variableName)) {
        assignment.verifiedAt = new Date().toISOString();
        verified.push(assignment);
        continue;
      }

      const available = await this.isPortAvailable(assignment.port);
      if (available) {
        assignment.verifiedAt = new Date().toISOString();
        verified.push(assignment);
      } else {
        toReassign.push(assignment);
      }
    }

    // Reassign ports that are no longer available
    for (const assignment of toReassign) {
      const usedPorts = new Set(verified.map((a) => a.port));
      const newPort = await this.findAvailablePort(usedPorts);
      assignment.port = newPort;
      assignment.verifiedAt = new Date().toISOString();
      verified.push(assignment);
    }

    this.assignments.assignments = verified;
    if (toReassign.length > 0) {
      this.saveAssignments();
      this.logger?.debug(
        `Reassigned ${toReassign.length} ports that were no longer available`
      );
    }
  }
}

// ── .env Block Utilities ───────────────────────────────────────────────────

/**
 * Extract the relay-ide managed ports block from .env content.
 *
 * @param content - Full .env file content
 * @returns Object with block content (if found) and surrounding content
 */
export function extractEnvBlock(content: string): {
  block: string | null;
  before: string;
  after: string;
} {
  const startIdx = content.indexOf(ENV_BLOCK_START);
  const endIdx = content.indexOf(ENV_BLOCK_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { block: null, before: content, after: '' };
  }

  // Include the end marker in the block
  const blockEnd = endIdx + ENV_BLOCK_END.length;
  const block = content.slice(startIdx, blockEnd);
  const before = content.slice(0, startIdx);
  const after = content.slice(blockEnd);

  return { block, before, after };
}

/**
 * Upsert the relay-ide managed ports block in .env content.
 *
 * Preserves all content outside the marker block. Only modifies
 * the content between the start and end markers.
 *
 * @param content - Full .env file content
 * @param portMapping - Map of variable names to port values
 * @returns Updated .env content with new block
 */
export function upsertEnvBlock(
  content: string,
  portMapping: Record<string, number>
): string {
  const { before, after } = extractEnvBlock(content);

  // Build the new block content
  const lines = [ENV_BLOCK_START];
  for (const [varName, port] of Object.entries(portMapping).sort()) {
    lines.push(`${varName}=${port}`);
  }
  lines.push(ENV_BLOCK_END);

  const newBlock = lines.join('\n');

  // Normalize whitespace around block
  const normalizedBefore = before.trimEnd();
  const normalizedAfter = after.trimStart();

  // Assemble the new content
  const parts: string[] = [];
  if (normalizedBefore) {
    parts.push(normalizedBefore);
    parts.push(''); // Empty line before block
  }
  parts.push(newBlock);
  if (normalizedAfter) {
    parts.push(''); // Empty line after block
    parts.push(normalizedAfter);
  }

  return parts.join('\n') + '\n';
}

/**
 * Remove the relay-ide managed ports block from .env content.
 *
 * Preserves all content outside the marker block.
 *
 * @param content - Full .env file content
 * @returns .env content with the managed block removed
 */
export function removeEnvBlock(content: string): string {
  const { block, before, after } = extractEnvBlock(content);

  if (!block) {
    return content;
  }

  // Normalize whitespace
  const normalizedBefore = before.trimEnd();
  const normalizedAfter = after.trimStart();

  const parts: string[] = [];
  if (normalizedBefore) {
    parts.push(normalizedBefore);
  }
  if (normalizedAfter) {
    if (normalizedBefore) {
      parts.push(''); // Empty line separator
    }
    parts.push(normalizedAfter);
  }

  const result = parts.join('\n');
  return result ? result + '\n' : '';
}

/**
 * Parse port variables from the relay-ide managed block.
 *
 * @param content - Full .env file content
 * @returns Map of variable names to port values, or undefined if no block
 */
export function parseEnvBlock(content: string): Record<string, number> | null {
  const { block } = extractEnvBlock(content);

  if (!block) {
    return null;
  }

  const result: Record<string, number> = {};
  const lines = block.split('\n').slice(1, -1); // Remove markers

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    const port = parseInt(value, 10);
    if (key && !isNaN(port) && port > 0) {
      result[key] = port;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function removeEnvBlockVariables(
  content: string,
  variableNames: string[]
): string {
  const existing = parseEnvBlock(content);
  if (!existing) return content;

  const variablesToRemove = new Set(sanitizeOptionalPortVariables(variableNames));
  const remaining = Object.fromEntries(
    Object.entries(existing).filter(
      ([variableName]) => !variablesToRemove.has(variableName)
    )
  );

  if (Object.keys(remaining).length === 0) {
    return removeEnvBlock(content);
  }

  return upsertEnvBlock(content, remaining);
}

export function upsertPortsInEnvFile(
  worktreePath: string,
  portMapping: Record<string, number>
): void {
  const envPath = path.join(worktreePath, '.env');
  const current = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : '';
  const next = upsertEnvBlock(current, portMapping);
  fs.writeFileSync(envPath, next, 'utf8');
}

export function removePortsFromEnvFile(
  worktreePath: string,
  variableNames?: string[]
): void {
  const envPath = path.join(worktreePath, '.env');
  if (!fs.existsSync(envPath)) return;
  const current = fs.readFileSync(envPath, 'utf8');
  const next = variableNames
    ? removeEnvBlockVariables(current, variableNames)
    : removeEnvBlock(current);
  if (next.length === 0) {
    fs.rmSync(envPath, { force: true });
    return;
  }
  fs.writeFileSync(envPath, next, 'utf8');
}

// ── Standalone Verification Utility ───────────────────────────────────────

/**
 * Verify if a specific port is currently available on the system.
 *
 * @param port - Port number to check
 * @returns Promise resolving to verification result
 */
export async function verifyPort(
  port: number
): Promise<PortVerificationResult> {
  try {
    const allocated = await getPort({ port });
    return { port, available: allocated === port };
  } catch {
    return { port, available: false };
  }
}

// ── Singleton for convenience (optional) ───────────────────────────────────

let defaultAllocator: PortAllocator | null = null;

/**
 * Initialize the default port allocator.
 *
 * @param configPath - Path to config.json
 * @param logger - Optional logger
 */
export async function initializeDefaultAllocator(
  configPath: string,
  logger?: PortAllocatorOptions['logger'],
  skipVerifyVariableNames?: string[]
): Promise<PortAllocator> {
  defaultAllocator = new PortAllocator({
    configPath,
    logger,
    skipVerifyVariableNames,
  });
  await defaultAllocator.initialize();
  return defaultAllocator;
}

/**
 * Get the default port allocator, or throw if not initialized.
 */
export function getDefaultAllocator(): PortAllocator {
  if (!defaultAllocator) {
    throw new Error(
      'Default port allocator not initialized. Call initializeDefaultAllocator first.'
    );
  }
  return defaultAllocator;
}

/**
 * Reset the default allocator (for testing).
 */
export function resetDefaultAllocator(): void {
  defaultAllocator = null;
}
