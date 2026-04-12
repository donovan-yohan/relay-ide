/**
 * Port Allocator for Worktree Environments
 *
 * Provides durable port allocation with OS-level verification.
 * Ports are persisted to port-assignments.json in the config directory.
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
  /** Optional logger for debug output */
  logger?: { debug: (msg: string, ...args: unknown[]) => void } | undefined;
}

export function normalizePortVariables(
  variableNames?: string[] | null
): string[] {
  const seen = new Set<string>();
  const normalized = (variableNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
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
  private readonly logger:
    | { debug: (msg: string, ...args: unknown[]) => void }
    | undefined;
  private assignments: PortAssignmentsFile;
  private initialized = false;

  constructor(options: PortAllocatorOptions) {
    this.assignmentsPath = path.join(
      path.dirname(options.configPath),
      'port-assignments.json'
    );
    this.logger = options.logger;
    this.assignments = this.loadAssignments();
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

  /**
   * Get all ports for a worktree.
   *
   * @param repoId - Repository identifier
   * @param worktreeId - Worktree identifier
   * @returns Map of variable names to port numbers, or undefined if none allocated
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

  async reconcilePortsForWorktree(
    repoId: string,
    worktreeId: string,
    variableNames: string[]
  ): Promise<Record<string, number>> {
    const requestedVariables = new Set(normalizePortVariables(variableNames));
    const preserved = this.assignments.assignments.filter(
      (a) =>
        a.repoId === repoId &&
        a.worktreeId === worktreeId &&
        requestedVariables.has(a.variableName)
    );

    this.assignments.assignments = this.assignments.assignments.filter(
      (a) =>
        a.repoId !== repoId ||
        a.worktreeId !== worktreeId ||
        requestedVariables.has(a.variableName)
    );

    const result: Record<string, number> = {};
    for (const assignment of preserved) {
      result[assignment.variableName] = assignment.port;
    }

    for (const variableName of requestedVariables) {
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

  private loadAssignments(): PortAssignmentsFile {
    try {
      if (fs.existsSync(this.assignmentsPath)) {
        const raw = fs.readFileSync(this.assignmentsPath, 'utf8');
        const data = JSON.parse(raw) as PortAssignmentsFile;
        if (data.version === 1 && Array.isArray(data.assignments)) {
          return data;
        }
      }
    } catch (err) {
      this.logger?.debug(
        'Failed to load port assignments, starting fresh',
        err
      );
    }
    return { version: 1, assignments: [] };
  }

  private saveAssignments(): void {
    const dir = path.dirname(this.assignmentsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      this.assignmentsPath,
      JSON.stringify(this.assignments, null, 2),
      'utf8'
    );
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

export function removePortsFromEnvFile(worktreePath: string): void {
  const envPath = path.join(worktreePath, '.env');
  if (!fs.existsSync(envPath)) return;
  const current = fs.readFileSync(envPath, 'utf8');
  const next = removeEnvBlock(current);
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
  logger?: PortAllocatorOptions['logger']
): Promise<PortAllocator> {
  defaultAllocator = new PortAllocator({ configPath, logger });
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
