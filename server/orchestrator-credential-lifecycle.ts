import type { RelayCapabilityBit } from '../shared/security-policy.js';
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

/**
 * Standing lease for an ordinary bound agent runtime (#1410): read bits only.
 *
 * `context:read` is the bit every `channels.*` read verb gates on
 * (`cliGatewayActorCommandCapabilities`); `session:read` is what makes
 * `defaultCliGatewayActorScope` stamp the generic read task-ref marker. There is
 * deliberately no `context:write` here — a bound agent replies through the
 * channel bridge, never by posting with its own credential — and no
 * `session:create:terminal`, which would turn a read handle into process
 * execution.
 */
export const READONLY_RUNTIME_ACTOR_CAPABILITIES = [
  'session:read',
  'context:read',
] as const;

/**
 * Hard registry clamp (`shared/scoped-actor-credentials.ts`). A lease may ask
 * for less, never for more: a longer window is a registry-wide policy change,
 * not a per-lease option.
 */
export const RUNTIME_ACTOR_CREDENTIAL_TTL_MS =
  DEFAULT_SCOPED_ACTOR_CREDENTIAL_MAX_TTL_MS;
export const ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS =
  RUNTIME_ACTOR_CREDENTIAL_TTL_MS;
export const ORCHESTRATOR_ACTOR_REFRESH_RATIO = 1 / 2;
export const ORCHESTRATOR_ACTOR_REFRESH_DEADLINE_SAFETY_MS = 1_000;

/**
 * Which runtime lease this is. Drives audit reason strings and public error
 * text only — capability material comes from `input.capabilities`, so a new
 * kind cannot silently inherit orchestrator privileges by naming itself.
 */
export type RuntimeCredentialLeaseKind =
  | 'orchestrator'
  | 'channel-runtime-read';

/**
 * `refresh` rotates at half lifetime through `applyRuntimeEnv` (adapters that
 * implement `refreshRuntimeEnv`). `static` mints once at spawn and lets the
 * credential expire: an adapter that cannot re-receive env must not be handed a
 * token that outlives what it was minted for.
 */
export type RuntimeCredentialRotation = 'refresh' | 'static';

interface LeaseAuditVocabulary {
  /** Noun phrase used in public (material-free) error text. */
  readonly subject: string;
  readonly ended: string;
  readonly rotated: string;
  readonly refreshFailed: string;
}

const LEASE_AUDIT: Record<RuntimeCredentialLeaseKind, LeaseAuditVocabulary> = {
  orchestrator: {
    subject: 'orchestrator actor credential',
    ended: 'orchestrator-runtime-ended',
    rotated: 'orchestrator-token-rotated',
    refreshFailed: 'orchestrator-token-refresh-failed',
  },
  'channel-runtime-read': {
    subject: 'channel runtime read actor credential',
    ended: 'channel-runtime-read-ended',
    rotated: 'channel-runtime-read-rotated',
    refreshFailed: 'channel-runtime-read-refresh-failed',
  },
};

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
  /** Durable channel this private runtime serves. */
  channelId: string;
  profileActorId: string;
  port: number;
  displayName?: string;
  /** Audit/error vocabulary for this lease. Never a capability source. */
  leaseKind: RuntimeCredentialLeaseKind;
  /**
   * Exact capability set to mint. Required (not defaulted) so a new caller is a
   * compile error rather than an implicit orchestrator-privileged lease.
   */
  capabilities: readonly RelayCapabilityBit[];
  rotation: RuntimeCredentialRotation;
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
 * Runtime-only credential lease for one channel agent runtime.
 *
 * Two modes, one implementation. The persistent orchestrator takes the
 * read/write lease and rotates (`rotation: 'refresh'`); every other bound agent
 * takes a read-only lease that rotates when its adapter can re-receive env and
 * otherwise simply expires (`rotation: 'static'`, #1410).
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

  /** Audit/error vocabulary for this lease kind. */
  private get audit(): LeaseAuditVocabulary {
    return LEASE_AUDIT[this.input.leaseKind];
  }

  /** Exposed for deterministic lifecycle tests and operator-driven recovery. */
  refreshNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A static lease has no delivery path for a replacement token; rotating it
    // would revoke a working credential and hand the child nothing.
    if (this.input.rotation === 'static') return Promise.resolve();
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
    this.safeRevoke(this.current.credential.id, this.audit.ended);
  }

  private issueInitial(): OrchestratorCredentialIssueResult {
    let issued: OrchestratorCredentialIssueResult;
    try {
      issued = this.issue();
    } catch {
      throw publicLifecycleError(`Failed to provision ${this.audit.subject}`);
    }
    // A credential with an unreadable lifetime is rejected in BOTH modes: a
    // static lease still relies on a real expiry to bound the injected token.
    if (credentialRefreshDelay(issued.credential, this.now()) === null) {
      this.safeRevoke(issued.credential.id, 'invalid-credential-lifetime');
      throw publicLifecycleError(`Failed to provision ${this.audit.subject}`);
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
      capabilities: [...this.input.capabilities],
      // Scope only the dimensions the lease's own requests actually name.
      //
      // `validateCredentialScope` fails closed on an unnamed dimension: a
      // credential that carries values a request does not name is rejected with
      // `missing_scope`. Channel requests name a channel and nothing else — no
      // HTTP channel route has a session in it — so a `sessionIds` pin on the
      // read lease is not a narrowing, it is a credential that cannot be used
      // at all (verified: `channels.history` scoped `{channelIds:[c]}` against a
      // `{sessionIds,channelIds}` credential returns `missing_scope`).
      //
      // Dropping it costs no confinement, because the same catch-all is what
      // confines the credential: a channel-only scope is accepted ONLY by
      // routes that request `channelIds`. Every other route — sessions, work
      // contexts, inbox — leaves the channel dimension unrequested and denies.
      //
      // The orchestrator lease still carries the pin, and that is a KNOWN
      // DEFECT, not a working design: no route names both dimensions, so the
      // orchestrator credential is denied `missing_scope` on BOTH lanes today
      // (channel routes request `{channelIds}` alone; sessions/command-center
      // routes request `{sessionIds, globalSessionIds}` alone). It is
      // fail-closed — the lease authenticates nothing rather than too much —
      // and the pin cannot simply be dropped here, because
      // `authenticatedSourceRuntimeId` (`server/channel-chat-router.ts`) reads
      // `scope.sessionIds[0]` to bind the credential to its private runtime
      // before granting the verbatim sender-id / agent-brake bypass. Removing
      // it would delete that binding instead of fixing the deny. Tracked in
      // #1419; `test/sessions-orchestrator-credential.test.ts` asserts the
      // current deny against real route scope shapes so it stays visible.
      scope: {
        ...(this.input.leaseKind === 'orchestrator'
          ? { sessionIds: [this.input.runtimeId] }
          : {}),
        channelIds: [this.input.channelId],
      },
      ttlMs: RUNTIME_ACTOR_CREDENTIAL_TTL_MS,
    });
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    // Static leases never rotate: the credential expires and the next spawn
    // mints a fresh one.
    if (this.input.rotation === 'static') return;
    const delay = credentialRefreshDelay(this.current.credential, this.now());
    if (delay === null) {
      this.triggerFailClosed(
        publicLifecycleError(`Invalid ${this.audit.subject} lifetime`)
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
        throw publicLifecycleError(`Invalid ${this.audit.subject} lifetime`);
      }
      if (this.stopped) {
        this.safeRevoke(replacement.credential.id, this.audit.ended);
        return;
      }

      await this.applyBeforeCurrentExpires(this.runtimeEnv(replacement.token));
      if (this.stopped) {
        this.safeRevoke(replacement.credential.id, this.audit.ended);
        return;
      }

      const previous = this.current;
      this.current = replacement;
      replacement = null;
      this.safeRevoke(previous.credential.id, this.audit.rotated);
      this.scheduleRefresh();
    } catch {
      if (replacement) {
        this.safeRevoke(replacement.credential.id, this.audit.refreshFailed);
      }
      if (!this.stopped) {
        this.clearRefreshTimer();
        this.triggerFailClosed(
          publicLifecycleError(`Failed to refresh ${this.audit.subject}`)
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
          `Refresh deadline elapsed for ${this.audit.subject}`
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
              `Refresh deadline elapsed for ${this.audit.subject}`
            )
          ),
        remainingMs
      );
      timer.unref?.();
      this.applyDeadline = {
        timer,
        cancel: () =>
          finish(
            publicLifecycleError(`Refresh cancelled for ${this.audit.subject}`)
          ),
      };
      void this.deps.applyRuntimeEnv(processEnv).then(
        () => finish(),
        () =>
          finish(publicLifecycleError(`Failed to apply ${this.audit.subject}`))
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
