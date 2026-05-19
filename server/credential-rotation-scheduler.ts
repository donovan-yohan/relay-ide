import { createLogger } from './logger.js';
import type {
  HubNodeRegistry,
  ScheduledRotationCandidate,
} from './hub-node-registry.js';
import type { HubNodeLinkManager } from './hub-node-link.js';
import type {
  SecurityAuditEntryInput,
  SecurityAuditDecision,
} from '../shared/security-audit.js';

const logger = createLogger('credential-rotation-scheduler');

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const MIN_CHECK_INTERVAL_MS = 1_000;

export type CredentialRotationNodeLinks = Pick<
  HubNodeLinkManager,
  'hasActiveNode' | 'request'
>;

export interface CredentialRotationSchedulerOptions {
  registry: HubNodeRegistry;
  nodeLinks: CredentialRotationNodeLinks;
  auditSink?: { append(input: SecurityAuditEntryInput): unknown } | undefined;
  intervalMs: number;
  checkIntervalMs?: number;
  now?: () => Date;
}

export interface ScheduledRotationSkip {
  nodeId: string;
  reasonCode: string;
  message?: string;
}

export interface ScheduledRotationFailure {
  nodeId: string;
  reasonCode: string;
  message: string;
  rotationId?: string;
}

export interface ScheduledRotationTickResult {
  evaluatedAt: string;
  candidates: number;
  triggered: Array<{ nodeId: string; rotationId: string }>;
  skipped: ScheduledRotationSkip[];
  failed: ScheduledRotationFailure[];
}

export interface CredentialRotationScheduler {
  start(): void;
  stop(): void;
  runOnce(): Promise<ScheduledRotationTickResult>;
}

export function createCredentialRotationScheduler(
  options: CredentialRotationSchedulerOptions
): CredentialRotationScheduler {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error(
      'credentialRotationScheduler requires a positive intervalMs'
    );
  }
  const checkIntervalMs = Math.max(
    options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    MIN_CHECK_INTERVAL_MS
  );
  const now = options.now ?? (() => new Date());

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ScheduledRotationTickResult> | null = null;

  function audit(
    nodeId: string,
    decision: SecurityAuditDecision,
    reasonCode: string,
    params: Record<string, unknown>,
    credentialId?: string,
    rotationId?: string
  ): void {
    if (!options.auditSink) return;
    try {
      options.auditSink.append({
        eventType: 'rotation',
        decision,
        reasonCode,
        peer: {
          kind: 'node',
          nodeId,
          ...(credentialId ? { credentialId } : {}),
        },
        node: { nodeId },
        intent: { action: 'nodes.credential.rotate', target: nodeId },
        material: {
          params: {
            trigger: 'scheduled',
            ...(rotationId ? { rotationId } : {}),
            ...params,
          },
        },
      });
    } catch (error) {
      logger.warn(
        'scheduled rotation audit append failed for node %s (%s): %s',
        nodeId,
        reasonCode,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function rotateOne(
    candidate: ScheduledRotationCandidate,
    result: ScheduledRotationTickResult
  ): Promise<void> {
    const { nodeId } = candidate;
    if (!options.nodeLinks.hasActiveNode(nodeId)) {
      audit(
        nodeId,
        'recorded',
        'CREDENTIAL_ROTATION_SCHEDULED_SKIPPED',
        { reason: 'NODE_OFFLINE', ageMs: candidate.ageMs },
        candidate.credentialId
      );
      result.skipped.push({ nodeId, reasonCode: 'NODE_OFFLINE' });
      return;
    }
    let started;
    try {
      started = options.registry.beginCredentialRotation(nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = extractErrorCode(error) ?? 'BEGIN_FAILED';
      audit(
        nodeId,
        'recorded',
        'CREDENTIAL_ROTATION_SCHEDULED_SKIPPED',
        { reason: code, message, ageMs: candidate.ageMs },
        candidate.credentialId
      );
      result.skipped.push({ nodeId, reasonCode: code, message });
      return;
    }
    audit(
      nodeId,
      'recorded',
      'CREDENTIAL_ROTATION_SCHEDULED_TRIGGERED',
      { ageMs: candidate.ageMs },
      started.rotation.previousCredentialId,
      started.rotation.rotationId
    );
    result.triggered.push({ nodeId, rotationId: started.rotation.rotationId });
    try {
      await options.nodeLinks.request(nodeId, 'credential.rotate', {
        credential: started.credential,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        options.registry.failCredentialRotation(
          nodeId,
          started.rotation.rotationId,
          message
        );
      } catch (failError) {
        logger.warn(
          'failCredentialRotation threw for node %s after scheduled delivery failure: %s',
          nodeId,
          failError instanceof Error ? failError.message : String(failError)
        );
      }
      audit(
        nodeId,
        'failed',
        'CREDENTIAL_ROTATION_SCHEDULED_FAILED',
        { message, ageMs: candidate.ageMs },
        started.rotation.previousCredentialId,
        started.rotation.rotationId
      );
      result.failed.push({
        nodeId,
        reasonCode: 'CREDENTIAL_ROTATION_SCHEDULED_FAILED',
        message,
        rotationId: started.rotation.rotationId,
      });
      return;
    }
    try {
      options.registry.markCredentialRotationDelivered(
        nodeId,
        started.rotation.rotationId
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        'markCredentialRotationDelivered threw for node %s after scheduled delivery: %s',
        nodeId,
        message
      );
    }
    audit(
      nodeId,
      'recorded',
      'CREDENTIAL_ROTATION_SCHEDULED_DELIVERED',
      { ageMs: candidate.ageMs },
      started.rotation.previousCredentialId,
      started.rotation.rotationId
    );
  }

  async function tick(): Promise<ScheduledRotationTickResult> {
    const evaluatedAt = now().toISOString();
    const candidates = options.registry.listScheduledRotationCandidates(
      options.intervalMs
    );
    const result: ScheduledRotationTickResult = {
      evaluatedAt,
      candidates: candidates.length,
      triggered: [],
      skipped: [],
      failed: [],
    };
    for (const candidate of candidates) {
      try {
        await rotateOne(candidate, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          'unexpected scheduled rotation error for node %s: %s',
          candidate.nodeId,
          message
        );
        result.failed.push({
          nodeId: candidate.nodeId,
          reasonCode: 'CREDENTIAL_ROTATION_SCHEDULED_FAILED',
          message,
        });
      }
    }
    return result;
  }

  function runOnce(): Promise<ScheduledRotationTickResult> {
    if (inFlight) return inFlight;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void runOnce().catch((error) => {
        logger.error(
          'scheduled rotation tick threw: %s',
          error instanceof Error ? error.message : String(error)
        );
      });
    }, checkIntervalMs);
    timer.unref?.();
    logger.info(
      'scheduled credential rotation enabled (intervalMs=%d, checkIntervalMs=%d)',
      options.intervalMs,
      checkIntervalMs
    );
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybe = error as { relayNodeError?: { code?: unknown } };
  const code = maybe.relayNodeError?.code;
  return typeof code === 'string' ? code : undefined;
}
