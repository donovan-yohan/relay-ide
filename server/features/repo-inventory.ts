import {
  aggregateRepoInventoryReports,
  isRepoInventoryReport,
  type AggregatedRepoInventoryResponse,
  type RepoInventoryReport,
} from '../../shared/repo-inventory.js';
import type { RelayNodeError } from '../../shared/relay-node-protocol.js';
import type { HubNodeRegistry } from '../hub-node-registry.js';

export interface InventoryValidationContext {
  nodeId: string;
}

export type InventoryValidationResult =
  | { ok: true; payload: RepoInventoryReport | undefined }
  | { ok: false; error: RelayNodeError };

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
}

export function validateInventoryPayload(
  payload: unknown,
  ctx: InventoryValidationContext
): InventoryValidationResult {
  if (payload === undefined || payload === null) {
    return { ok: true, payload: undefined };
  }
  if (!isRepoInventoryReport(payload)) {
    return { ok: false, error: invalidRequest('repoInventory is malformed') };
  }
  if (payload.nodeId !== ctx.nodeId) {
    return {
      ok: false,
      error: invalidRequest(
        'repoInventory.nodeId must match authenticated nodeId'
      ),
    };
  }
  return { ok: true, payload };
}

export function parseStoredInventory(
  payload: unknown
): RepoInventoryReport | null {
  if (payload === undefined || payload === null) return null;
  return isRepoInventoryReport(payload) ? payload : null;
}

export interface RepoInventoryFeature {
  validateInventoryPayload: (
    payload: unknown,
    ctx: InventoryValidationContext
  ) => InventoryValidationResult;
  listInventoryReports: (options?: {
    includeRevoked?: boolean;
  }) => RepoInventoryReport[];
  aggregateInventoryReports: (
    reports: RepoInventoryReport[],
    now?: Date
  ) => AggregatedRepoInventoryResponse;
}

export function createRepoInventoryFeature(
  registry: HubNodeRegistry
): RepoInventoryFeature {
  return {
    validateInventoryPayload,
    listInventoryReports: (options) => {
      const payloads = registry.listInventoryPayloads(options);
      const reports: RepoInventoryReport[] = [];
      for (const { payload } of payloads) {
        const parsed = parseStoredInventory(payload);
        if (parsed) reports.push(parsed);
      }
      return reports;
    },
    aggregateInventoryReports: aggregateRepoInventoryReports,
  };
}

export type { RepoInventoryReport, AggregatedRepoInventoryResponse };
