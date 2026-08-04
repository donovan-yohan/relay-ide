import {
  DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_TTL_MS,
  type ScopedActorCredentialRecord,
  type ScopedActorCredentialRegistry,
} from '../shared/scoped-actor-credentials.js';
import type { CliGatewayActorIssueInput } from './cli-gateway-actor-auth.js';

export const ORCHESTRATOR_ACTOR_CAPABILITIES = [
  'session:read',
  'context:read',
  'context:write',
  'session:create:terminal',
] as const;

export const ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS =
  DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_TTL_MS;
export const ORCHESTRATOR_ACTOR_REFRESH_RATIO = 1 / 2;
export const ORCHESTRATOR_ACTOR_REFRESH_DEADLINE_SAFETY_MS = 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface OrchestratorCredentialIssueResult {
  token: string;
  credential: ScopedActorCredentialRecord;
}

export interface OrchestratorCredentialLifecycleDeps {
  issueCredential: (
    input: Omit<CliGatewayActorIssueInput, 'metadata'>
  ) => OrchestratorCredentialIssueResult;
  revokeCredential: (
    credentialId: string,
    input: Parameters<ScopedActorCredentialRegistry['revoke']>[1]
  ) => unknown;
  applyRuntimeEnv: (processEnv: Record<string, string>) => Promise<void>;
  failClosed: (error: Error) => void | Promise<void>;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

export interface StartOrchestratorCredentialLifecycleInput {
  runtimeId: string;
  profileActorId: string;
  port: number;
  displayName?: string;
}

function publicLifecycleError(message: string): Error {
  // Never retain the issuer/apply error as `cause`: an adapter or credential
  // provider may include environment material in its error details.
  return new Error(message);
}

function credentialRefreshDelay(
  credential: ScopedActorCredentialRecord,
  now: number
): number | null {
  const issuedAt = Date.parse(credential.issuedAt);
  const expiresAt = Date.parse(credential.expiresAt);
  const lifetime = expiresAt - issuedAt;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0
  ) {
    return null;
  }
  return Math.max(
    0,
    issuedAt + lifetime * ORCHESTRATOR_ACTOR_REFRESH_RATIO - now
  );
}

/**
 * Runtime-only credential lease for one persistent channel orchestrator.
 *
 * The initial credential is minted synchronously before the caller creates the
 * adapter. Rotations are ordered mint -> runtime apply -> current swap -> old
 * revoke, so a failed replacement never revokes the last usable credential.
 */
export class OrchestratorCredentialLifecycle {
  private readonly now: () => number;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number
  ) => TimerHandle;
  private readonly cancelTimeout: (timer: TimerHandle) => void;
  private current: OrchestratorCredentialIssueResult;
  private timer: TimerHandle | null = null;
  private applyDeadline: { timer: TimerHandle; cancel: () => void } | undefined;
  private stopped = false;
  private rotationPromise: Promise<void> | null = null;

  constructor(
    private readonly input: StartOrchestratorCredentialLifecycleInput,
    private readonly deps: OrchestratorCredentialLifecycleDeps
  ) {
    this.now = deps.now ?? Date.now;
    this.scheduleTimeout = deps.setTimeout ?? setTimeout;
    this.cancelTimeout = deps.clearTimeout ?? clearTimeout;
    this.current = this.issueInitial();
    this.scheduleRefresh();
  }

  /** Initial runtime overlay; callers pass this to AdapterConfig.processEnv. */
  get processEnv(): Record<string, string> {
    return this.runtimeEnv(this.current.token);
  }

  /** Exposed for deterministic lifecycle tests and operator-driven recovery. */
  refreshNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.rotationPromise) return this.rotationPromise;
    const rotation = this.rotate();
    this.rotationPromise = rotation;
    void rotation.finally(() => {
      if (this.rotationPromise === rotation) this.rotationPromise = null;
    });
    return rotation;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearRefreshTimer();
    this.cancelApplyDeadline();
    this.safeRevoke(this.current.credential.id, 'orchestrator-runtime-ended');
  }

  private issueInitial(): OrchestratorCredentialIssueResult {
    let issued: OrchestratorCredentialIssueResult;
    try {
      issued = this.issue();
    } catch {
      throw publicLifecycleError(
        'Failed to provision orchestrator actor credential'
      );
    }
    if (credentialRefreshDelay(issued.credential, this.now()) === null) {
      this.safeRevoke(issued.credential.id, 'invalid-credential-lifetime');
      throw publicLifecycleError(
        'Failed to provision orchestrator actor credential'
      );
    }
    return issued;
  }

  private issue(): OrchestratorCredentialIssueResult {
    return this.deps.issueCredential({
      actor: {
        type: 'agent',
        id: this.input.profileActorId,
        ...(this.input.displayName
          ? { displayName: this.input.displayName }
          : {}),
      },
      issuer: {
        id: 'relay-ide',
        displayName: 'Relay',
      },
      capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
      scope: { sessionIds: [this.input.runtimeId] },
      ttlMs: ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS,
    });
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    const delay = credentialRefreshDelay(this.current.credential, this.now());
    if (delay === null) {
      this.triggerFailClosed(
        publicLifecycleError(
          'Orchestrator actor credential lifetime is invalid'
        )
      );
      return;
    }
    this.clearRefreshTimer();
    this.timer = this.scheduleTimeout(() => {
      this.timer = null;
      void this.refreshNow();
    }, delay);
    this.timer.unref?.();
  }

  private clearRefreshTimer(): void {
    if (!this.timer) return;
    this.cancelTimeout(this.timer);
    this.timer = null;
  }

  private async rotate(): Promise<void> {
    let replacement: OrchestratorCredentialIssueResult | null = null;
    try {
      replacement = this.issue();
      if (credentialRefreshDelay(replacement.credential, this.now()) === null) {
        throw publicLifecycleError(
          'Orchestrator actor credential lifetime is invalid'
        );
      }
      if (this.stopped) {
        this.safeRevoke(
          replacement.credential.id,
          'orchestrator-runtime-ended'
        );
        return;
      }

      await this.applyBeforeCurrentExpires(this.runtimeEnv(replacement.token));
      if (this.stopped) {
        this.safeRevoke(
          replacement.credential.id,
          'orchestrator-runtime-ended'
        );
        return;
      }

      const previous = this.current;
      this.current = replacement;
      replacement = null;
      this.safeRevoke(previous.credential.id, 'orchestrator-token-rotated');
      this.scheduleRefresh();
    } catch {
      if (replacement) {
        this.safeRevoke(
          replacement.credential.id,
          'orchestrator-token-refresh-failed'
        );
      }
      if (!this.stopped) {
        this.clearRefreshTimer();
        this.triggerFailClosed(
          publicLifecycleError(
            'Failed to refresh orchestrator actor credential'
          )
        );
      }
    }
  }

  private safeRevoke(credentialId: string, reason: string): void {
    try {
      this.deps.revokeCredential(credentialId, {
        revokedBy: 'relay-ide',
        reason,
      });
    } catch {
      // The lease is already unusable or ending. Revocation is best effort and
      // must never re-expose credential material through an error path.
    }
  }

  private runtimeEnv(token: string): Record<string, string> {
    return {
      RELAY_IDE_ACTOR_TOKEN: token,
      RELAY_IDE_PORT: String(this.input.port),
      RELAY_IDE_RUNTIME_ID: this.input.runtimeId,
    };
  }

  private applyBeforeCurrentExpires(
    processEnv: Record<string, string>
  ): Promise<void> {
    const expiresAt = Date.parse(this.current.credential.expiresAt);
    const remainingMs =
      expiresAt - this.now() - ORCHESTRATOR_ACTOR_REFRESH_DEADLINE_SAFETY_MS;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return Promise.reject(
        publicLifecycleError(
          'Orchestrator actor credential refresh deadline elapsed'
        )
      );
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (this.applyDeadline) {
          this.cancelTimeout(this.applyDeadline.timer);
          this.applyDeadline = undefined;
        }
        if (error) reject(error);
        else resolve();
      };
      const timer = this.scheduleTimeout(
        () =>
          finish(
            publicLifecycleError(
              'Orchestrator actor credential refresh deadline elapsed'
            )
          ),
        remainingMs
      );
      timer.unref?.();
      this.applyDeadline = {
        timer,
        cancel: () =>
          finish(
            publicLifecycleError(
              'Orchestrator actor credential refresh was cancelled'
            )
          ),
      };
      void this.deps.applyRuntimeEnv(processEnv).then(
        () => finish(),
        () =>
          finish(
            publicLifecycleError(
              'Failed to apply orchestrator actor credential'
            )
          )
      );
    });
  }

  private cancelApplyDeadline(): void {
    const deadline = this.applyDeadline;
    if (!deadline) return;
    deadline.cancel();
  }

  private triggerFailClosed(error: Error): void {
    try {
      void Promise.resolve(this.deps.failClosed(error)).catch(() => {});
    } catch {
      // The callback owns termination/reporting. A callback failure must not
      // restart the refresh loop or surface credential-bearing internals.
    }
  }
}

export function startOrchestratorCredentialLifecycle(
  input: StartOrchestratorCredentialLifecycleInput,
  deps: OrchestratorCredentialLifecycleDeps
): OrchestratorCredentialLifecycle {
  return new OrchestratorCredentialLifecycle(input, deps);
}
