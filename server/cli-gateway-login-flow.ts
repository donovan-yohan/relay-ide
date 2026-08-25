import * as crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type {
  ScopedActorCredentialRecord,
  ScopedActorCredentialScope,
} from '../shared/scoped-actor-credentials.js';

/**
 * #1435 slice 1: the hub leg of `relay-ide login`.
 *
 * A fresh CLI creates a short-lived, one-time login flow; the human approves it
 * in a browser with a PIN re-entry (the consent act); the CLI polls and
 * receives the minted scoped actor credential exactly once. The flow record
 * never stores token material — issuance is delegated to a callback supplied
 * by the hub composition root, and the token passes through memory only.
 */

/** How long a login flow may sit unapproved. */
export const CLI_LOGIN_FLOW_TTL_MS = 5 * 60 * 1000;

/** Upper bound on simultaneously pending flows (light abuse guard). */
export const MAX_PENDING_CLI_LOGIN_FLOWS = 20;

/**
 * Human-typed verification code alphabet: digits and uppercase letters with
 * the ambiguous glyphs (0/O, 1/I/L) removed.
 */
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type CliGatewayLoginFlowStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed';

export interface CliGatewayLoginFlow {
  flowId: string;
  code: string;
  status: CliGatewayLoginFlowStatus;
  actorId: string;
  displayName?: string;
  requestedCapabilities: string[];
  requestedScope: ScopedActorCredentialScope;
  createdAt: string;
  expiresAt: string;
  correlationId: string;
  /** Present once approved: public record only, never token material. */
  credentialId?: string;
  credentialExpiresAt?: string;
  deliveredAt?: string;
  decidedBy?: string;
}

export interface IssuedCliLoginCredential {
  token: string;
  credential: ScopedActorCredentialRecord;
}

export type CliLoginCredentialIssuer = (input: {
  flow: CliGatewayLoginFlow;
  approvedBy: string;
}) => IssuedCliLoginCredential;

export type CliGatewayLoginFlowErrorCode =
  | 'flow_not_found'
  | 'flow_not_pending'
  | 'too_many_pending'
  | 'invalid_capabilities'
  | 'invalid_input';

export class CliGatewayLoginFlowError extends Error {
  constructor(
    public readonly code: CliGatewayLoginFlowErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CliGatewayLoginFlowError';
  }
}

export function generateCliLoginCode(randomBytes = crypto.randomBytes): string {
  const bytes = randomBytes(8);
  const chars = Array.from(
    bytes,
    (byte) => CODE_CHARSET[byte % CODE_CHARSET.length]
  );
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

interface StartCliLoginFlowInput {
  actorId?: unknown;
  displayName?: unknown;
  capabilities?: unknown;
  correlationId?: unknown;
}

export class CliGatewayLoginFlowRegistry {
  private readonly flows = new Map<string, CliGatewayLoginFlow>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly issueCredential: CliLoginCredentialIssuer;

  constructor(options: {
    issueCredential: CliLoginCredentialIssuer;
    now?: () => Date;
    ttlMs?: number;
  }) {
    this.issueCredential = options.issueCredential;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? CLI_LOGIN_FLOW_TTL_MS;
  }

  start(
    input: StartCliLoginFlowInput = {},
    allowedCapabilities?: readonly string[]
  ): CliGatewayLoginFlow {
    this.pruneExpired();
    const pendingCount = Array.from(this.flows.values()).filter(
      (flow) => this.statusOf(flow) === 'pending'
    ).length;
    if (pendingCount >= MAX_PENDING_CLI_LOGIN_FLOWS) {
      throw new CliGatewayLoginFlowError(
        'too_many_pending',
        'too many pending CLI login flows; wait for one to expire or complete'
      );
    }
    const capabilities = coerceCapabilities(
      input.capabilities,
      allowedCapabilities
    );
    const actorId =
      typeof input.actorId === 'string' && input.actorId.trim()
        ? input.actorId.trim().slice(0, 128)
        : 'relay-cli';
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 128)
        : undefined;
    const createdAt = this.now();
    const flow: CliGatewayLoginFlow = {
      flowId: crypto.randomUUID(),
      code: generateCliLoginCode(),
      status: 'pending',
      actorId,
      ...(displayName ? { displayName } : {}),
      requestedCapabilities: capabilities,
      requestedScope: {},
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
      correlationId:
        typeof input.correlationId === 'string' && input.correlationId.trim()
          ? input.correlationId.trim()
          : `cli-login-${flowRandomId()}`,
    };
    this.flows.set(flow.flowId, flow);
    return this.publicFlow(flow);
  }

  /**
   * Poll a flow. On the FIRST poll observing `approved`, the response carries
   * the issued token; every later observation reports `consumed`. The token is
   * never stored on the flow record, so delivery is exactly-once per process.
   */
  poll(flowId: string): {
    status: CliGatewayLoginFlowStatus;
    expiresAt: string;
    codeRequired: boolean;
    token?: string;
    credential?: ScopedActorCredentialRecord;
    credentialId?: string;
  } {
    const flow = this.requireFlow(flowId);
    const base = {
      expiresAt: flow.expiresAt,
      codeRequired: false,
      ...(flow.credentialId ? { credentialId: flow.credentialId } : {}),
    };
    // Already delivered: the token never leaves the process twice.
    if (flow.deliveredAt) {
      return { ...base, status: 'consumed' };
    }
    if (flow.status === 'approved') {
      const issued = this.issueCredential({
        flow: this.publicFlow(flow),
        approvedBy: flow.decidedBy ?? 'browser-operator',
      });
      flow.deliveredAt = this.now().toISOString();
      flow.credentialId = issued.credential.id;
      flow.credentialExpiresAt = issued.credential.expiresAt;
      return {
        ...base,
        status: 'approved',
        token: issued.token,
        credential: issued.credential,
      };
    }
    return { ...base, status: this.statusOf(flow) };
  }

  approve(
    flowId: string,
    input: { approvedBy?: string } = {}
  ): CliGatewayLoginFlow {
    const flow = this.requireFlow(flowId);
    if (this.statusOf(flow) === 'expired') {
      throw new CliGatewayLoginFlowError(
        'flow_not_pending',
        'CLI login flow has expired'
      );
    }
    if (flow.status !== 'pending') {
      throw new CliGatewayLoginFlowError(
        'flow_not_pending',
        `CLI login flow is ${flow.status}, not pending`
      );
    }
    flow.status = 'approved';
    flow.decidedBy =
      typeof input.approvedBy === 'string' && input.approvedBy.trim()
        ? input.approvedBy.trim()
        : 'browser-operator';
    return this.publicFlow(flow);
  }

  deny(flowId: string, input: { deniedBy?: string } = {}): CliGatewayLoginFlow {
    const flow = this.requireFlow(flowId);
    if (this.statusOf(flow) === 'expired') {
      throw new CliGatewayLoginFlowError(
        'flow_not_pending',
        'CLI login flow has expired'
      );
    }
    if (flow.status !== 'pending') {
      throw new CliGatewayLoginFlowError(
        'flow_not_pending',
        `CLI login flow is ${flow.status}, not pending`
      );
    }
    flow.status = 'denied';
    flow.decidedBy =
      typeof input.deniedBy === 'string' && input.deniedBy.trim()
        ? input.deniedBy.trim()
        : 'browser-operator';
    return this.publicFlow(flow);
  }

  get(flowId: string): CliGatewayLoginFlow | null {
    const flow = this.flows.get(flowId);
    return flow ? this.publicFlow(flow) : null;
  }

  private requireFlow(flowId: string): CliGatewayLoginFlow {
    const flow = this.flows.get(flowId);
    if (!flow) {
      throw new CliGatewayLoginFlowError(
        'flow_not_found',
        'unknown CLI login flow id'
      );
    }
    return flow;
  }

  /** Lazy expiry: a pending flow past its deadline reads as expired forever. */
  private statusOf(flow: CliGatewayLoginFlow): CliGatewayLoginFlowStatus {
    if (
      flow.status === 'pending' &&
      new Date(flow.expiresAt).getTime() <= this.now().getTime()
    ) {
      return 'expired';
    }
    return flow.status;
  }

  private pruneExpired(): void {
    for (const [flowId, flow] of this.flows) {
      // Remove records that are no longer pending (expired, decided, done).
      if (this.statusOf(flow) === 'pending') continue;
      this.flows.delete(flowId);
    }
  }

  private publicFlow(flow: CliGatewayLoginFlow): CliGatewayLoginFlow {
    return {
      ...flow,
      requestedCapabilities: [...flow.requestedCapabilities],
      requestedScope: { ...flow.requestedScope },
      ...(flow.decidedBy ? { decidedBy: flow.decidedBy } : {}),
    };
  }
}

function coerceCapabilities(
  value: unknown,
  allowed?: readonly string[]
): string[] {
  if (value === undefined || value === null) return ['session:read'];
  if (!Array.isArray(value)) {
    throw new CliGatewayLoginFlowError(
      'invalid_input',
      'capabilities must be an array of strings'
    );
  }
  const capabilities = value.map((entry) => String(entry));
  if (allowed) {
    const unknown = capabilities.filter(
      (capability) => !allowed.includes(capability)
    );
    if (unknown.length > 0 || capabilities.length === 0) {
      throw new CliGatewayLoginFlowError(
        'invalid_capabilities',
        `unsupported capabilities requested: ${unknown.join(', ') || '(none)'}`
      );
    }
  }
  return capabilities;
}

function flowRandomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

export interface CliGatewayLoginRouterOptions {
  flows: CliGatewayLoginFlowRegistry;
  verifyPin: (pin: string) => Promise<boolean>;
  isRateLimited: (ip: string) => boolean;
  recordFailedAttempt: (ip: string) => void;
  clearRateLimit: (ip: string) => void;
  allowedCapabilities: readonly string[];
  /** Absolute base URL used in the returned verificationUrl. */
  baseUrl: () => string;
}

export function createCliGatewayLoginRouter(
  options: CliGatewayLoginRouterOptions
): Router {
  const router = Router();
  // HTML form submissions are urlencoded; the global express.json() middleware
  // cannot parse them, so mount urlencoded locally for the approval POST.
  router.use(express.urlencoded({ extended: false }));

  const flowErrorResponse = (res: Response, error: unknown): void => {
    if (error instanceof CliGatewayLoginFlowError) {
      const status =
        error.code === 'flow_not_found'
          ? 404
          : error.code === 'flow_not_pending'
            ? 409
            : error.code === 'too_many_pending'
              ? 429
              : 400;
      res.status(status).json({
        error: {
          code: `CLI_LOGIN_FLOW_${error.code.toUpperCase()}`,
          message: error.message,
          retryable: false,
        },
      });
      return;
    }
    throw error;
  };

  router.post('/start', (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const flow = options.flows.start(body, options.allowedCapabilities);
      res.status(201).json({
        flowId: flow.flowId,
        code: flow.code,
        expiresAt: flow.expiresAt,
        verificationUrl: `${options.baseUrl()}/cli-gateway/login/${encodeURIComponent(flow.flowId)}/approve`,
      });
    } catch (error) {
      flowErrorResponse(res, error);
    }
  });

  router.get('/:flowId', (req, res) => {
    try {
      res.json(options.flows.poll(requireFlowId(req)));
    } catch (error) {
      flowErrorResponse(res, error);
    }
  });

  router.get('/:flowId/approve', (req, res) => {
    const flow = (() => {
      try {
        return options.flows.get(requireFlowId(req));
      } catch {
        return null;
      }
    })();
    if (!flow) {
      res
        .status(404)
        .type('html')
        .send(
          renderApprovalPage({
            heading: 'Unknown login request',
            detail:
              'This CLI login link is not valid anymore. Close this page and run `relay-ide login` again.',
            flow: null,
          })
        );
      return;
    }
    res
      .type('html')
      .send(
        renderApprovalPage({
          heading: 'Authorize CLI login',
          detail: null,
          flow,
        })
      );
  });

  router.post('/:flowId/approve', async (req, res) => {
    const flowId = requireFlowId(req);
    const ip = (req.ip || '') as string;
    const body = isRecord(req.body) ? req.body : {};
    const pin = typeof body['pin'] === 'string' ? body['pin'] : '';
    const deny = body['action'] === 'deny';
    if (options.isRateLimited(ip)) {
      res
        .status(429)
        .type('html')
        .send(
          renderMessagePage(
            'Too many attempts',
            'Too many PIN attempts. Wait a minute and start a new `relay-ide login`.'
          )
        );
      return;
    }
    if (!pin) {
      res
        .status(400)
        .type('html')
        .send(
          renderApprovalPage({
            heading: 'PIN required',
            detail: 'Enter your Relay PIN to approve this login.',
            flow: options.flows.get(flowId) ?? null,
          })
        );
      return;
    }
    const valid = await options.verifyPin(pin);
    if (!valid) {
      options.recordFailedAttempt(ip);
      res
        .status(401)
        .type('html')
        .send(
          renderApprovalPage({
            heading: 'Invalid PIN',
            detail: 'The PIN did not match. Try again or run `relay-ide login` for a fresh link.',
            flow: options.flows.get(flowId) ?? null,
          })
        );
      return;
    }
    options.clearRateLimit(ip);
    try {
      const flow = deny
        ? options.flows.deny(flowId, { deniedBy: 'browser-operator' })
        : options.flows.approve(flowId, { approvedBy: 'browser-operator' });
      res
        .type('html')
        .send(
          deny
            ? renderMessagePage(
                'Login denied',
                'The CLI login request was denied. You can close this page.'
              )
            : renderApprovedPage(flow)
        );
    } catch (error) {
      if (error instanceof CliGatewayLoginFlowError) {
        res
          .status(error.code === 'flow_not_found' ? 404 : 409)
          .type('html')
          .send(
            renderMessagePage(
              'Login request unavailable',
              'This CLI login link is no longer pending. Run `relay-ide login` again.'
            )
          );
        return;
      }
      throw error;
    }
  });

  return router;
}

function requireFlowId(req: Request): string {
  const flowId = req.params['flowId'];
  if (!flowId || !/^[0-9a-f-]{16,64}$/i.test(flowId)) {
    throw new CliGatewayLoginFlowError('flow_not_found', 'malformed flow id');
  }
  return flowId;
}

function renderApprovedPage(flow: CliGatewayLoginFlow): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CLI login approved</title>
<style>${PAGE_STYLES}</style></head>
<body><main>
<h1>&#10003; CLI login approved</h1>
<p>Relay authorized <strong>${escapeHtml(flow.actorId)}</strong> on this machine.</p>
<p>Credential: <code>${escapeHtml(flow.credentialId ?? 'issuing…')}</code><br>
Return to your terminal &mdash; it finishes the login automatically.</p>
</main></body></html>`;
}

function renderMessagePage(heading: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title>
<style>${PAGE_STYLES}</style></head>
<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

function renderApprovalPage(input: {
  heading: string;
  detail: string | null;
  flow: CliGatewayLoginFlow | null;
}): string {
  const flow = input.flow;
  const rows = flow
    ? `<tr><th>Device</th><td>${escapeHtml(flow.displayName ?? '')} (${escapeHtml(flow.actorId)})</td></tr>
<tr><th>Requested access</th><td>${escapeHtml(flow.requestedCapabilities.join(', '))}</td></tr>
<tr><th>Request expires</th><td>${escapeHtml(new Date(flow.expiresAt).toUTCString())}</td></tr>
<tr><th>Verification code</th><td><code>${escapeHtml(flow.code)}</code></td></tr>`
    : '';
  const form = flow
    ? `<form method="post" action="/cli-gateway/login/${escapeHtml(flow.flowId)}/approve">
<label for="pin">Relay PIN</label>
<input id="pin" name="pin" type="password" autocomplete="off" autofocus required>
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny" class="secondary">Deny</button>
</form>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(input.heading)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_STYLES}</style></head>
<body><main>
<h1>${escapeHtml(input.heading)}</h1>
${input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : ''}
${rows ? `<table>${rows}</table>` : ''}
<p class="detail">Approving grants the requesting machine a scoped API credential limited to the access listed above. Only approve a request you started.</p>
${form}
</main></body></html>`;
}

const PAGE_STYLES = `
:root { color-scheme: dark; }
* { box-sizing: border-box; border-radius: 0 !important; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #000; color: #c8c8c8;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { width: min(26rem, calc(100vw - 2rem)); padding: 1.75rem;
  border: 1px solid #1a1a1a; background: #0a0a0a; }
h1 { font-size: 1rem; letter-spacing: 0.04em; margin-top: 0; text-transform: uppercase;
  color: #e0e0e0; }
table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; }
th, td { text-align: left; padding: 0.4rem 0.4rem; border-bottom: 1px solid #1a1a1a;
  font-size: 0.78rem; vertical-align: top; }
th { color: #666; font-weight: 500; width: 8rem; text-transform: uppercase;
  letter-spacing: 0.06em; font-size: 0.7rem; }
code { background: #111; padding: 0.1rem 0.3rem; font-size: 0.78rem; color: #e0e0e0; }
label { display: block; margin: 0.75rem 0 0.3rem; color: #666; font-size: 0.7rem;
  text-transform: uppercase; letter-spacing: 0.08em; }
input { width: 100%; padding: 0.5rem 0.5rem; background: #000; color: #e0e0e0;
  border: 1px solid #1a1a1a; font: inherit; font-size: 0.9rem; }
input:focus { outline: none; border-color: #333; }
button { margin-top: 0.75rem; margin-right: 0.4rem; padding: 0.45rem 0.9rem;
  background: #e0e0e0; color: #000; border: 1px solid #e0e0e0;
  font: inherit; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em;
  cursor: pointer; }
button.secondary { background: transparent; color: #666; border-color: #1a1a1a; }
button:hover { opacity: 0.85; }
.detail { color: #666; font-size: 0.75rem; line-height: 1.5; }
.error { color: #c44; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
