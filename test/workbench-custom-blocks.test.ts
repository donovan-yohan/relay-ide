/**
 * Tests for custom block proposal flow — slice 4 of epic #612, #622.
 *
 * Covers:
 *   1. Shared types: KnownTemplateName set, error codes, compile-time assertions
 *   2. Server validation: validateProposalInput
 *      - Happy path
 *      - jsx-snippet always rejected (capability boundary)
 *      - Unknown template name rejected
 *      - Unknown capability bit in capabilityRequirements rejected
 *      - Missing required fields
 *   3. Server store: readAllProposals / writeAllProposals round-trip
 *   4. Server REST endpoints via http.createServer:
 *      - POST /proposals: create → 201, proposalId returned
 *      - GET  /proposals?status=: list + filter
 *      - POST /proposals/:id/approve: pending → approved, audit emitted
 *      - POST /proposals/:id/reject: pending → rejected, audit emitted
 *      - POST /proposals/:id/revoke: approved → revoked, audit emitted
 *      - 404 on unknown id, 409 on wrong state transition
 *   5. Audit envelopes emitted on each state transition
 *   6. Server index mounts the router
 *
 * The frontend block-renderer source assertions this file used to carry were
 * dropped with `frontend/src/workbench/` in epic #1287 slice 0. The pre-channel
 * block canvas had no live importer left; the proposal REST surface it fed is
 * still covered here.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { Express } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ---------------------------------------------------------------------------
// HTTP test helper (matches workbench-layout.test.ts pattern)
// ---------------------------------------------------------------------------

function call(
  app: Express,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (bodyStr !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }
      const req = http.request(
        { host: '127.0.0.1', port, path: url, method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            server.close();
            let parsed: unknown = null;
            if (data.trim()) {
              try {
                parsed = JSON.parse(data);
              } catch {
                parsed = data;
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on('error', (err: Error) => {
        server.close();
        reject(err);
      });
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Shared types
// ---------------------------------------------------------------------------

import {
  KNOWN_TEMPLATE_NAMES,
  isKnownTemplateName,
  CUSTOM_BLOCK_PROPOSAL_ERRORS,
} from '../shared/workbench-custom-blocks.js';
import type {
  CustomBlockProposal,
  CustomRendererSource,
} from '../shared/workbench-custom-blocks.js';

describe('workbench-custom-blocks: shared types', () => {
  it('KNOWN_TEMPLATE_NAMES contains the three starter templates', () => {
    expect(KNOWN_TEMPLATE_NAMES).toContain('status-card');
    expect(KNOWN_TEMPLATE_NAMES).toContain('kv-grid');
    expect(KNOWN_TEMPLATE_NAMES).toContain('link-list');
    expect(KNOWN_TEMPLATE_NAMES).toHaveLength(3);
  });

  it('isKnownTemplateName accepts valid names', () => {
    expect(isKnownTemplateName('status-card')).toBe(true);
    expect(isKnownTemplateName('kv-grid')).toBe(true);
    expect(isKnownTemplateName('link-list')).toBe(true);
  });

  it('isKnownTemplateName rejects unknown names', () => {
    expect(isKnownTemplateName('arbitrary-jsx')).toBe(false);
    expect(isKnownTemplateName('')).toBe(false);
    expect(isKnownTemplateName(42)).toBe(false);
    expect(isKnownTemplateName(null)).toBe(false);
  });

  it('CUSTOM_BLOCK_PROPOSAL_ERRORS has required error codes', () => {
    expect(CUSTOM_BLOCK_PROPOSAL_ERRORS.jsx_snippet_not_supported).toBeTruthy();
    expect(CUSTOM_BLOCK_PROPOSAL_ERRORS.unknown_template).toBeTruthy();
    expect(CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_found).toBeTruthy();
    expect(CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_pending).toBeTruthy();
    expect(CUSTOM_BLOCK_PROPOSAL_ERRORS.proposal_not_approved).toBeTruthy();
  });

  it('CustomBlockProposal type is structurally correct (compile-time check)', () => {
    const proposal: CustomBlockProposal = {
      proposalId: 'p-1',
      descriptor: {
        kind: 'custom',
        id: 'block-1',
        title: 'test',
        capabilityRequirements: [],
        meta: { rendererId: 'p-1' },
      },
      rendererSource: {
        kind: 'template',
        template: 'status-card',
        props: { title: 'hello', status: 'active' },
      },
      proposedBy: { kind: 'actor', id: 'agent-1' },
      proposedAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(proposal.proposalId).toBe('p-1');
    expect(proposal.status).toBe('pending');
  });

  it('jsx-snippet source kind is typed as a no-op seam', () => {
    const rs: CustomRendererSource = {
      kind: 'jsx-snippet',
      snippet: '<div>hello</div>',
    };
    expect(rs.kind).toBe('jsx-snippet');
  });

  it('template source kind is valid', () => {
    const rs: CustomRendererSource = {
      kind: 'template',
      template: 'kv-grid',
      props: {},
    };
    expect(rs.kind).toBe('template');
    expect(rs.template).toBe('kv-grid');
  });
});

// ---------------------------------------------------------------------------
// 2. Server validation
// ---------------------------------------------------------------------------

import { validateProposalInput } from '../server/workbench-custom-blocks.js';

function makeValidBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    descriptor: {
      kind: 'custom',
      id: 'block-1',
      title: 'test block',
      capabilityRequirements: [],
      meta: { rendererId: 'renderer-1' },
    },
    rendererSource: {
      kind: 'template',
      template: 'status-card',
      props: { title: 'hello', status: 'active' },
    },
    proposedBy: { kind: 'actor', id: 'agent-1' },
    ...overrides,
  };
}

describe('validateProposalInput', () => {
  it('accepts a valid template proposal', () => {
    expect(validateProposalInput(makeValidBody())).toBeNull();
  });

  it('rejects null body', () => {
    expect(validateProposalInput(null)).toBeTruthy();
  });

  it('rejects string body', () => {
    expect(validateProposalInput('string')).toBeTruthy();
  });

  it('rejects array body', () => {
    expect(validateProposalInput([])).toBeTruthy();
  });

  it('rejects missing descriptor', () => {
    const body = makeValidBody() as Record<string, unknown>;
    delete body['descriptor'];
    const err = validateProposalInput(body);
    expect(err).toContain('descriptor');
  });

  it('rejects descriptor.kind != "custom"', () => {
    const err = validateProposalInput(
      makeValidBody({
        descriptor: {
          kind: 'terminal',
          id: 'b',
          title: 't',
          capabilityRequirements: [],
          meta: { rendererId: 'r' },
        },
      })
    );
    expect(err).toContain('custom');
  });

  it('rejects empty descriptor.id', () => {
    const err = validateProposalInput(
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: '',
          title: 'title',
          capabilityRequirements: [],
          meta: { rendererId: 'r' },
        },
      })
    );
    expect(err).toContain('id');
  });

  it('rejects empty descriptor.title', () => {
    const err = validateProposalInput(
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: 'b',
          title: '',
          capabilityRequirements: [],
          meta: { rendererId: 'r' },
        },
      })
    );
    expect(err).toContain('title');
  });

  it('rejects empty meta.rendererId', () => {
    const err = validateProposalInput(
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: 'b',
          title: 't',
          capabilityRequirements: [],
          meta: { rendererId: '' },
        },
      })
    );
    expect(err).toContain('rendererId');
  });

  it('rejects unknown capability bit in capabilityRequirements (capability boundary)', () => {
    const err = validateProposalInput(
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: 'b',
          title: 't',
          capabilityRequirements: ['rpc:fs:read', 'hack:everything'],
          meta: { rendererId: 'r' },
        },
      })
    );
    expect(err).toContain('hack:everything');
  });

  it('accepts known capability bits in capabilityRequirements', () => {
    expect(
      validateProposalInput(
        makeValidBody({
          descriptor: {
            kind: 'custom',
            id: 'b',
            title: 't',
            capabilityRequirements: ['rpc:fs:read', 'session:read'],
            meta: { rendererId: 'r' },
          },
        })
      )
    ).toBeNull();
  });

  it('rejects jsx-snippet source kind — security boundary, always rejected', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: { kind: 'jsx-snippet', snippet: '<div>hello</div>' },
      })
    );
    expect(err).toContain(
      CUSTOM_BLOCK_PROPOSAL_ERRORS.jsx_snippet_not_supported
    );
  });

  it('rejects unknown template name', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'arbitrary-renderer',
          props: {},
        },
      })
    );
    expect(err).toContain('template');
  });

  it('accepts missing proposedBy (attribution is derived server-side)', () => {
    // proposedBy is no longer validated in the request body — actor identity
    // is derived server-side from the authenticated request context (fix #4).
    const body = makeValidBody() as Record<string, unknown>;
    delete body['proposedBy'];
    expect(validateProposalInput(body)).toBeNull();
  });

  it('accepts proposedBy without id (display hint only, not validated)', () => {
    // The body's proposedBy is an untrusted display hint — it is never used
    // for audit attribution, so its shape is not enforced here (fix #4).
    const err = validateProposalInput(
      makeValidBody({ proposedBy: { kind: 'actor' } })
    );
    expect(err).toBeNull();
  });

  it('rejects unknown rendererSource.kind', () => {
    const err = validateProposalInput(
      makeValidBody({ rendererSource: { kind: 'invalid', data: {} } })
    );
    expect(err).toContain('kind');
  });

  it('rejects missing rendererSource', () => {
    const body = makeValidBody() as Record<string, unknown>;
    delete body['rendererSource'];
    expect(validateProposalInput(body)).toContain('rendererSource');
  });
});

// ---------------------------------------------------------------------------
// 3. Server store: read/write round-trip
// ---------------------------------------------------------------------------

import {
  readAllProposals,
  writeAllProposals,
} from '../server/workbench-custom-blocks.js';

describe('readAllProposals / writeAllProposals', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-store-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when no file exists', () => {
    const map = readAllProposals(configPath);
    expect(map.size).toBe(0);
  });

  it('round-trips a proposal', () => {
    const proposal: CustomBlockProposal = {
      proposalId: 'p-abc',
      descriptor: {
        kind: 'custom',
        id: 'b-1',
        title: 'my block',
        capabilityRequirements: [],
        meta: { rendererId: 'p-abc' },
      },
      rendererSource: {
        kind: 'template',
        template: 'kv-grid',
        props: { rows: [{ key: 'env', value: 'dev' }] },
      },
      proposedBy: { kind: 'actor', id: 'agent-1' },
      proposedAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      statusUpdatedAt: '2026-01-01T00:00:00.000Z',
    };

    const original = new Map<string, CustomBlockProposal>();
    original.set(proposal.proposalId, proposal);
    writeAllProposals(configPath, original);

    const restored = readAllProposals(configPath);
    expect(restored.size).toBe(1);
    const p = restored.get('p-abc');
    expect(p).toBeDefined();
    expect(p!.proposalId).toBe('p-abc');
    expect(p!.status).toBe('pending');
    expect(p!.descriptor.title).toBe('my block');
  });

  it('returns empty map on corrupted file', () => {
    const dir = path.join(path.dirname(configPath), 'workbench-custom-blocks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'custom-block-proposals.json'),
      'NOT JSON {{{{',
      'utf8'
    );
    const map = readAllProposals(configPath);
    expect(map.size).toBe(0);
  });

  it('persists multiple proposals', () => {
    const map = new Map<string, CustomBlockProposal>();
    for (let i = 0; i < 3; i++) {
      const p: CustomBlockProposal = {
        proposalId: `p-${i}`,
        descriptor: {
          kind: 'custom',
          id: `b-${i}`,
          title: `block ${i}`,
          capabilityRequirements: [],
          meta: { rendererId: `p-${i}` },
        },
        rendererSource: {
          kind: 'template',
          template: 'status-card',
          props: { title: `block ${i}`, status: 'active' },
        },
        proposedBy: { kind: 'actor', id: 'agent' },
        proposedAt: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        statusUpdatedAt: '2026-01-01T00:00:00.000Z',
      };
      map.set(p.proposalId, p);
    }
    writeAllProposals(configPath, map);
    const restored = readAllProposals(configPath);
    expect(restored.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. REST endpoint integration tests (http.createServer pattern)
// ---------------------------------------------------------------------------

import { createWorkbenchCustomBlocksRouter } from '../server/workbench-custom-blocks.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';

function makeApp(configPath: string, auditSink?: { append: Mock }): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/workbench/custom-blocks',
    createWorkbenchCustomBlocksRouter({ configPath, auditSink })
  );
  return app;
}

describe('REST: POST /proposals', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-rest-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a proposal and returns 201 with proposalId', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(typeof body['proposalId']).toBe('string');
    expect(body['status']).toBe('pending');
  });

  it('rejects jsx-snippet with 422', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        rendererSource: { kind: 'jsx-snippet', snippet: '<div/>' },
      })
    );
    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(String(body['error'])).toContain(
      CUSTOM_BLOCK_PROPOSAL_ERRORS.jsx_snippet_not_supported
    );
  });

  it('rejects unknown template name with 422', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'bad-template',
          props: {},
        },
      })
    );
    expect(res.status).toBe(422);
  });

  it('rejects unknown capability bit with 422', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: 'b',
          title: 't',
          capabilityRequirements: ['hack:root'],
          meta: { rendererId: 'r' },
        },
      })
    );
    expect(res.status).toBe(422);
    const body = res.body as Record<string, unknown>;
    expect(String(body['error'])).toContain('hack:root');
  });

  it('emits an audit envelope on creation', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    expect(auditSink.append).toHaveBeenCalledOnce();
    const call_ = auditSink.append.mock.calls[0]![0] as SecurityAuditEntryInput;
    expect(call_.intent.action).toBe('workbench.custom-block.propose');
    expect(call_.decision).toBe('recorded');
  });
});

describe('REST: GET /proposals', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-get-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no proposals', async () => {
    const app = makeApp(configPath);
    const res = await call(app, 'GET', '/workbench/custom-blocks/proposals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('filters by pending status', async () => {
    const app = makeApp(configPath);
    await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals?status=pending'
    );
    expect(res.status).toBe(200);
    const body = res.body as unknown[];
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>)['status']).toBe('pending');
  });

  it('returns 400 on invalid status filter', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals?status=invalid'
    );
    expect(res.status).toBe(400);
  });
});

describe('REST: lifecycle transitions', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-lc-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProposal(app: Express): Promise<string> {
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    expect(res.status).toBe(201);
    return (res.body as Record<string, unknown>)['proposalId'] as string;
  }

  // --- approve ---

  it('approve: pending → approved, returns 200', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);

    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/approve`
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['status']).toBe('approved');
  });

  it('approve: emits audit envelope with eventType=approval', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);

    expect(auditSink.append).toHaveBeenCalledTimes(2); // create + approve
    const approveCall = auditSink.append.mock
      .calls[1]![0] as SecurityAuditEntryInput;
    expect(approveCall.intent.action).toBe('workbench.custom-block.approve');
    expect(approveCall.decision).toBe('approved');
    expect(approveCall.eventType).toBe('approval');
  });

  it('approve: approved block appears in approved list (addressable)', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);

    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals?status=approved'
    );
    expect(res.status).toBe(200);
    const body = res.body as Array<Record<string, unknown>>;
    expect(body.some((p) => p['proposalId'] === id)).toBe(true);
  });

  // --- reject ---

  it('reject: pending → rejected, returns 200', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);

    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/reject`
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['status']).toBe('rejected');
  });

  it('reject: emits audit envelope with eventType=denial', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/reject`);

    const rejectCall = auditSink.append.mock
      .calls[1]![0] as SecurityAuditEntryInput;
    expect(rejectCall.intent.action).toBe('workbench.custom-block.reject');
    expect(rejectCall.decision).toBe('deny');
    expect(rejectCall.eventType).toBe('denial');
  });

  it('reject: rejected proposal not addressable as approved', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/reject`);

    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals?status=approved'
    );
    expect(res.status).toBe(200);
    const body = res.body as Array<Record<string, unknown>>;
    expect(body.some((p) => p['proposalId'] === id)).toBe(false);
  });

  // --- revoke ---

  it('revoke: approved → revoked, returns 200', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);

    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/revoke`
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['status']).toBe('revoked');
  });

  it('revoke: emits audit envelope with eventType=revocation', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/revoke`);

    expect(auditSink.append).toHaveBeenCalledTimes(3); // create + approve + revoke
    const revokeCall = auditSink.append.mock
      .calls[2]![0] as SecurityAuditEntryInput;
    expect(revokeCall.intent.action).toBe('workbench.custom-block.revoke');
    expect(revokeCall.decision).toBe('revoked');
    expect(revokeCall.eventType).toBe('revocation');
  });

  it('revoke: revoked proposal not in approved list', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/revoke`);

    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals?status=approved'
    );
    const body = res.body as Array<Record<string, unknown>>;
    expect(body.some((p) => p['proposalId'] === id)).toBe(false);
  });

  // --- error paths ---

  it('approve returns 404 for unknown id', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals/nonexistent/approve'
    );
    expect(res.status).toBe(404);
  });

  it('reject returns 404 for unknown id', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals/nonexistent/reject'
    );
    expect(res.status).toBe(404);
  });

  it('revoke returns 404 for unknown id', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals/nonexistent/revoke'
    );
    expect(res.status).toBe(404);
  });

  it('approve returns 409 if already approved', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);
    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/approve`
    );
    expect(res.status).toBe(409);
  });

  it('revoke returns 409 if still pending', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/revoke`
    );
    expect(res.status).toBe(409);
  });

  it('reject returns 409 if already rejected', async () => {
    const app = makeApp(configPath);
    const id = await createProposal(app);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/reject`);
    const res = await call(
      app,
      'POST',
      `/workbench/custom-blocks/proposals/${id}/reject`
    );
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 5. API client source assertions
// ---------------------------------------------------------------------------

describe('api.ts: custom block proposal API functions', () => {
  const apiPath = join(projectRoot, 'frontend/src/lib/api.ts');

  it('exports fetchCustomBlockProposals', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function fetchCustomBlockProposals');
  });

  it('exports submitCustomBlockProposal', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function submitCustomBlockProposal');
  });

  it('exports approveCustomBlockProposal', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function approveCustomBlockProposal');
  });

  it('exports rejectCustomBlockProposal', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function rejectCustomBlockProposal');
  });

  it('exports revokeCustomBlockProposal', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function revokeCustomBlockProposal');
  });

  it('uses the /workbench/custom-blocks route prefix', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('/workbench/custom-blocks/proposals');
  });
});

// ---------------------------------------------------------------------------
// 6. Server index mounts the router
// ---------------------------------------------------------------------------

describe('server/index.ts: router mount', () => {
  const indexPath = join(projectRoot, 'server/index.ts');

  it('imports createWorkbenchCustomBlocksRouter', () => {
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('createWorkbenchCustomBlocksRouter');
  });

  it('mounts at /workbench/custom-blocks', () => {
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('/workbench/custom-blocks');
  });
});

// ---------------------------------------------------------------------------
// 7. rendererId sync on proposal create (fix #5)
// ---------------------------------------------------------------------------

describe('REST: POST /proposals — rendererId synced to proposalId', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-renderid-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overwrites client rendererId with the server-generated proposalId', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        descriptor: {
          kind: 'custom',
          id: 'block-1',
          title: 'test',
          capabilityRequirements: [],
          // Client submits a rendererId that should be replaced server-side.
          meta: { rendererId: 'client-supplied-renderer-id' },
        },
      })
    );
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    const proposalId = body['proposalId'] as string;
    // The descriptor's rendererId must equal the server-generated proposalId.
    const descriptor = body['descriptor'] as Record<string, unknown>;
    const meta = descriptor['meta'] as Record<string, unknown>;
    expect(meta['rendererId']).toBe(proposalId);
    expect(meta['rendererId']).not.toBe('client-supplied-renderer-id');
  });
});

// ---------------------------------------------------------------------------
// 8. Per-template prop validation 422 cases (fix #6)
// ---------------------------------------------------------------------------

describe('validateProposalInput: per-template prop validation', () => {
  it('rejects status-card without title prop', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'status-card',
          props: { status: 'active' }, // missing title
        },
      })
    );
    expect(err).toBeTruthy();
    expect(err).toContain('title');
  });

  it('accepts status-card with valid props', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'status-card',
          props: { title: 'my card', status: 'active' },
        },
      })
    );
    expect(err).toBeNull();
  });

  it('rejects kv-grid without rows prop', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'kv-grid',
          props: {}, // missing rows
        },
      })
    );
    expect(err).toBeTruthy();
    expect(err).toContain('rows');
  });

  it('rejects kv-grid with invalid row shape', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'kv-grid',
          props: { rows: [{ key: 'k', value: 123 }] }, // value not a string
        },
      })
    );
    expect(err).toBeTruthy();
    expect(err).toContain('rows[0]');
  });

  it('accepts kv-grid with valid rows', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'kv-grid',
          props: { rows: [{ key: 'env', value: 'dev' }] },
        },
      })
    );
    expect(err).toBeNull();
  });

  it('rejects link-list without links prop', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'link-list',
          props: {}, // missing links
        },
      })
    );
    expect(err).toBeTruthy();
    expect(err).toContain('links');
  });

  it('rejects link-list with invalid link shape', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'link-list',
          props: { links: [{ label: 'Home' }] }, // missing url
        },
      })
    );
    expect(err).toBeTruthy();
    expect(err).toContain('links[0]');
  });

  it('accepts link-list with valid links', () => {
    const err = validateProposalInput(
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'link-list',
          props: { links: [{ label: 'Home', url: 'https://example.com' }] },
        },
      })
    );
    expect(err).toBeNull();
  });
});

describe('REST: per-template prop validation returns 422', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-props-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 422 for status-card missing title', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'status-card',
          props: { status: 'active' },
        },
      })
    );
    expect(res.status).toBe(422);
    expect(String((res.body as Record<string, unknown>)['error'])).toContain(
      'title'
    );
  });

  it('returns 422 for kv-grid missing rows', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'kv-grid',
          props: {},
        },
      })
    );
    expect(res.status).toBe(422);
    expect(String((res.body as Record<string, unknown>)['error'])).toContain(
      'rows'
    );
  });

  it('returns 422 for link-list missing links', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody({
        rendererSource: {
          kind: 'template',
          template: 'link-list',
          props: {},
        },
      })
    );
    expect(res.status).toBe(422);
    expect(String((res.body as Record<string, unknown>)['error'])).toContain(
      'links'
    );
  });
});

// ---------------------------------------------------------------------------
// 9. GET /proposals/:id endpoint (fix #1)
// ---------------------------------------------------------------------------

describe('REST: GET /proposals/:id', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-byid-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for unknown id', async () => {
    const app = makeApp(configPath);
    const res = await call(
      app,
      'GET',
      '/workbench/custom-blocks/proposals/nonexistent'
    );
    expect(res.status).toBe(404);
  });

  it('returns a pending proposal by id', async () => {
    const app = makeApp(configPath);
    const createRes = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    expect(createRes.status).toBe(201);
    const proposalId = (createRes.body as Record<string, unknown>)[
      'proposalId'
    ] as string;

    const res = await call(
      app,
      'GET',
      `/workbench/custom-blocks/proposals/${proposalId}`
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['proposalId']).toBe(proposalId);
    expect(body['status']).toBe('pending');
  });

  it('returns a revoked proposal by id (status = revoked)', async () => {
    const app = makeApp(configPath);
    const createRes = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    const id = (createRes.body as Record<string, unknown>)[
      'proposalId'
    ] as string;
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/revoke`);

    const res = await call(
      app,
      'GET',
      `/workbench/custom-blocks/proposals/${id}`
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['status']).toBe('revoked');
  });

  it('returns a rejected proposal by id (status = rejected)', async () => {
    const app = makeApp(configPath);
    const createRes = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    const id = (createRes.body as Record<string, unknown>)[
      'proposalId'
    ] as string;
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/reject`);

    const res = await call(
      app,
      'GET',
      `/workbench/custom-blocks/proposals/${id}`
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)['status']).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 10. Audit peer mapping — agent vs user actor (fix #7)
// ---------------------------------------------------------------------------

import {
  deriveActorRef,
  validateProposalInput as _validateProposalInput2,
} from '../server/workbench-custom-blocks.js';
import type { Request as ExpressRequest } from 'express';

function mockRequest(
  opts: { cliGateway?: boolean; nodeId?: string } = {}
): ExpressRequest {
  const headers: Record<string, string> = {};
  if (opts.cliGateway) headers['x-relay-cli-gateway'] = 'v1';
  if (opts.nodeId) headers['x-relay-node-id'] = opts.nodeId;
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
  } as unknown as ExpressRequest;
}

describe('deriveActorRef: actor identity from request context', () => {
  it('cookie-auth session → hub-user actor', () => {
    const actor = deriveActorRef(mockRequest());
    expect(actor.id).toBe('hub-user');
    expect(actor.kind).toBe('actor');
  });

  it('CLI gateway request → node actor with id = x-relay-node-id', () => {
    const actor = deriveActorRef(
      mockRequest({ cliGateway: true, nodeId: 'node-xyz' })
    );
    expect(actor.id).toBe('node-xyz');
    expect(actor.kind).toBe('actor');
  });

  it('CLI gateway without x-relay-node-id → fallback id = cli-gateway', () => {
    const actor = deriveActorRef(mockRequest({ cliGateway: true }));
    expect(actor.id).toBe('cli-gateway');
  });

  it('uses displayHint as displayName for hub-user', () => {
    const actor = deriveActorRef(mockRequest(), 'My Agent');
    expect(actor.displayName).toBe('My Agent');
  });
});

describe('REST: audit peer kind for agent vs user proposals', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcb-peer-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cookie-auth proposal: audit peer is kind=user', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    // No x-relay-cli-gateway header → hub-user (kind: user)
    await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );

    expect(auditSink.append).toHaveBeenCalledOnce();
    const envelope = auditSink.append.mock
      .calls[0]![0] as SecurityAuditEntryInput;
    expect(envelope.peer.kind).toBe('user');
  });

  it('approve/reject/revoke: audit peer is kind=user (hub action)', async () => {
    const auditSink = { append: vi.fn() };
    const app = makeApp(configPath, auditSink);
    const createRes = await call(
      app,
      'POST',
      '/workbench/custom-blocks/proposals',
      makeValidBody()
    );
    const id = (createRes.body as Record<string, unknown>)[
      'proposalId'
    ] as string;
    await call(app, 'POST', `/workbench/custom-blocks/proposals/${id}/approve`);

    expect(auditSink.append).toHaveBeenCalledTimes(2);
    const approveEnvelope = auditSink.append.mock
      .calls[1]![0] as SecurityAuditEntryInput;
    expect(approveEnvelope.peer.kind).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 11. api.ts: fetchCustomBlockProposalById (fix #1)
// ---------------------------------------------------------------------------

describe('api.ts: fetchCustomBlockProposalById', () => {
  const apiPath = join(projectRoot, 'frontend/src/lib/api.ts');

  it('exports fetchCustomBlockProposalById', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('export async function fetchCustomBlockProposalById');
  });

  it('uses the /workbench/custom-blocks/proposals/:id route', () => {
    const src = readFileSync(apiPath, 'utf-8');
    expect(src).toContain('/workbench/custom-blocks/proposals/');
  });
});
