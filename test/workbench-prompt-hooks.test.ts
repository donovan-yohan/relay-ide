/**
 * Tests for Workbench prompt hooks — slice 5 of epic #612, #625.
 *
 * Covers:
 *   1. summarizeWorkbenchBlocks
 *      - Empty layout → empty summary, no truncation
 *      - Layout with all 8 block kinds → correct per-kind excerpts
 *      - Layout exceeding block cap → truncates to MAX_BLOCKS, truncated=true
 *      - Layout exceeding byte cap → truncates safely, truncated=true
 *      - No secret/env/transcript leakage (grep output for forbidden patterns)
 *      - Markdown block never leaks .meta.content
 *      - File block never leaks a path string
 *      - Custom block only emits rendererId (proposalId)
 *
 *   2. evaluateBlockProposal (pure logic)
 *      - First-party kind with sufficient grants → auto-approved
 *      - First-party kind with missing grants → pending
 *      - Custom kind → always pending (routes to slice-4)
 *      - Malformed descriptor → rejected at validation
 *
 *   3. Server REST router — POST /propose-block
 *      - First-party with sufficient grants → 201 auto-approved
 *      - First-party with missing grants → 201 pending
 *      - Custom kind → 201 pending, stored in slice-4 store
 *      - Malformed body → 422 rejected
 *      - GET /propose-block/proposals lists correctly
 *      - POST /propose-block/proposals/:id/approve transitions pending → approved
 *      - POST /propose-block/proposals/:id/reject transitions pending → rejected
 *
 *   4. Audit envelope emission on each state transition
 *      - proposal create (auto-approved)
 *      - proposal create (pending)
 *      - user approve
 *      - user reject
 *
 *   5. getWorkbenchContextSummary wires layout store + summarizer
 *      - Returns null when no layout stored
 *      - Returns a valid summary when a layout is persisted
 *
 *   6. server/index.ts mounts the router
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
import { readFileSync, existsSync } from 'node:fs';
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
// Shared imports
// ---------------------------------------------------------------------------

import {
  summarizeWorkbenchBlocks,
  evaluateBlockProposal,
  WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES,
  WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS,
} from '../shared/workbench-prompt-hooks.js';
import type { WorkbenchBlockProposalRequest } from '../shared/workbench-prompt-hooks.js';
import { WORKBENCH_LAYOUT_SCHEMA_VERSION } from '../shared/workbench-layout-types.js';
import type {
  WorkbenchLayout,
  WorkbenchBlockPlacement,
} from '../shared/workbench-layout-types.js';

// Server imports
import {
  getWorkbenchContextSummary,
  createWorkbenchProposeBlockRouter,
} from '../server/workbench-prompt-hooks.js';
import { writeWorkbenchLayout } from '../server/workbench-layout.js';
import { getPromptFanoutRunFixture } from '../shared/prompt-fanout-fixtures.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTerminalPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'terminal',
      id: 'block-terminal',
      title: 'Terminal',
      capabilityRequirements: ['session:attach'],
      meta: {
        sessionRef: {
          sessionId: 'sess-abc',
          nodeId: 'node-1',
          tabKind: 'agent',
          cwd: '/home/user/project',
        },
      },
    },
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    minimized: false,
  };
}

function makeAgentPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'agent',
      id: 'block-agent',
      title: 'Claude Agent',
      capabilityRequirements: ['session:attach', 'tab:mode:set-agent'],
      meta: {
        actorRef: {
          kind: 'actor',
          id: 'actor-xyz',
          displayName: 'Claude Code',
        },
      },
    },
    position: { x: 410, y: 0 },
    size: { width: 400, height: 300 },
    minimized: false,
  };
}

function makePromptFanoutPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'prompt-fanout',
      id: 'block-prompt-fanout',
      title: 'Prompt Fanout',
      capabilityRequirements: [],
      meta: {
        fixture: 'all-success',
        run: getPromptFanoutRunFixture('all-success'),
        dryRunOnly: true,
      },
    },
    position: { x: 820, y: 0 },
    size: { width: 500, height: 300 },
    minimized: false,
  };
}

function makeWorkContextPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'work-context',
      id: 'block-wc',
      title: 'Task Context',
      capabilityRequirements: [],
      meta: {
        workContextRef: 'wc:task-123',
      },
    },
    position: { x: 0, y: 310 },
    size: { width: 400, height: 200 },
    minimized: false,
  };
}

function makeFilePlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'file',
      id: 'block-file',
      title: 'package.json',
      capabilityRequirements: ['rpc:fs:read'],
      meta: {
        fileRef: {
          kind: 'file',
          id: 'rpc:fs:node-1:/home/user/project/package.json',
          displayName: 'package.json',
        },
        mode: 'read',
      },
    },
    position: { x: 410, y: 310 },
    size: { width: 400, height: 200 },
    minimized: false,
  };
}

function makeArtifactPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'artifact',
      id: 'block-artifact',
      title: 'Build Log',
      capabilityRequirements: [],
      meta: {
        artifactRef: {
          id: 'artifact-build-42',
          kind: 'log',
          title: 'Build Log 2026-05-19',
          uri: 'relay://artifacts/build-42',
          mediaType: 'text/plain',
        },
      },
    },
    position: { x: 0, y: 520 },
    size: { width: 400, height: 200 },
    minimized: false,
  };
}

function makeMarkdownPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'markdown',
      id: 'block-md',
      title: 'Design Notes',
      capabilityRequirements: [],
      meta: {
        content:
          '# SECRET CONTENT\nSECRET_KEY=abc123\nexport TOKEN=ghp_xyz\npassword: hunter2',
      },
    },
    position: { x: 410, y: 520 },
    size: { width: 400, height: 200 },
    minimized: false,
  };
}

function makeCustomPlacement(): WorkbenchBlockPlacement {
  return {
    descriptor: {
      kind: 'custom',
      id: 'block-custom',
      title: 'Status Dashboard',
      capabilityRequirements: [],
      meta: {
        rendererId: 'proposal-id-001',
        props: {
          title: 'CI Status',
          status: 'active',
        },
      },
    },
    position: { x: 0, y: 730 },
    size: { width: 820, height: 200 },
    minimized: false,
  };
}

function makeLayout(placements: WorkbenchBlockPlacement[]): WorkbenchLayout {
  return {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    workspaceScope: { id: 'ws:test', displayName: 'Test Workspace' },
    blocks: placements,
  };
}

// ---------------------------------------------------------------------------
// 1. summarizeWorkbenchBlocks
// ---------------------------------------------------------------------------

describe('summarizeWorkbenchBlocks', () => {
  it('returns empty summary for empty layout', () => {
    const layout = makeLayout([]);
    const summary = summarizeWorkbenchBlocks(layout);
    expect(summary.blocks).toHaveLength(0);
    expect(summary.totalBlocks).toBe(0);
    expect(summary.truncated).toBe(false);
    expect(summary.workspaceScope.id).toBe('ws:test');
  });

  it('summarizes all 8 block kinds correctly', () => {
    const layout = makeLayout([
      makeTerminalPlacement(),
      makeAgentPlacement(),
      makePromptFanoutPlacement(),
      makeWorkContextPlacement(),
      makeFilePlacement(),
      makeArtifactPlacement(),
      makeMarkdownPlacement(),
      makeCustomPlacement(),
    ]);
    const summary = summarizeWorkbenchBlocks(layout);
    expect(summary.blocks).toHaveLength(8);
    expect(summary.truncated).toBe(false);
    expect(summary.totalBlocks).toBe(8);

    const terminal = summary.blocks.find((b) => b.kind === 'terminal');
    expect(terminal?.excerpt).toMatchObject({
      kind: 'terminal',
      sessionId: 'sess-abc',
    });

    const agent = summary.blocks.find((b) => b.kind === 'agent');
    expect(agent?.excerpt).toMatchObject({
      kind: 'agent',
      actorId: 'actor-xyz',
      actorDisplayName: 'Claude Code',
    });

    const promptFanout = summary.blocks.find(
      (b) => b.kind === 'prompt-fanout'
    );
    expect(promptFanout?.excerpt).toMatchObject({
      kind: 'prompt-fanout',
      runId: 'pfr:all-success',
      state: 'completed',
      selectedTargetCount: 2,
      resultCount: 2,
    });

    const wc = summary.blocks.find((b) => b.kind === 'work-context');
    expect(wc?.excerpt).toMatchObject({
      kind: 'work-context',
      workContextRef: 'wc:task-123',
    });

    const file = summary.blocks.find((b) => b.kind === 'file');
    expect(file?.excerpt).toMatchObject({
      kind: 'file',
      fileRefKind: 'file',
      mode: 'read',
    });

    const artifact = summary.blocks.find((b) => b.kind === 'artifact');
    expect(artifact?.excerpt).toMatchObject({
      kind: 'artifact',
      artifactKind: 'log',
      artifactTitle: 'Build Log 2026-05-19',
    });

    const md = summary.blocks.find((b) => b.kind === 'markdown');
    expect(md?.excerpt).toMatchObject({ kind: 'markdown' });

    const custom = summary.blocks.find((b) => b.kind === 'custom');
    expect(custom?.excerpt).toMatchObject({
      kind: 'custom',
      rendererId: 'proposal-id-001',
    });
  });

  it('truncates when block count exceeds MAX_BLOCKS', () => {
    const placements: WorkbenchBlockPlacement[] = [];
    for (let i = 0; i < WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS + 5; i++) {
      placements.push({
        descriptor: {
          kind: 'markdown',
          id: `block-${i}`,
          title: `Block ${i}`,
          capabilityRequirements: [],
          meta: { content: 'short' },
        },
        position: { x: 0, y: i * 100 },
        size: { width: 200, height: 100 },
        minimized: false,
      });
    }
    const layout = makeLayout(placements);
    const summary = summarizeWorkbenchBlocks(layout);
    expect(summary.blocks).toHaveLength(WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS);
    expect(summary.truncated).toBe(true);
    expect(summary.totalBlocks).toBe(WORKBENCH_CONTEXT_SUMMARY_MAX_BLOCKS + 5);
  });

  it('truncates safely when byte cap is exceeded', () => {
    // Each block gets a long title to push total byte count past 4KB
    const placements: WorkbenchBlockPlacement[] = [];
    for (let i = 0; i < 15; i++) {
      placements.push({
        descriptor: {
          kind: 'markdown',
          id: `block-${i}`,
          title: 'A'.repeat(300), // 300-char title per block
          capabilityRequirements: [],
          meta: { content: 'short' },
        },
        position: { x: 0, y: i * 100 },
        size: { width: 200, height: 100 },
        minimized: false,
      });
    }
    const layout = makeLayout(placements);
    const summary = summarizeWorkbenchBlocks(layout);
    expect(summary.summaryBytes).toBeLessThanOrEqual(
      WORKBENCH_CONTEXT_SUMMARY_MAX_BYTES
    );
    expect(summary.truncated).toBe(true);
    expect(summary.blocks.length).toBeLessThan(15);
  });

  it('does not leak markdown .meta.content', () => {
    const layout = makeLayout([makeMarkdownPlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const serialized = JSON.stringify(summary);

    // The dangerous content in makeMarkdownPlacement
    expect(serialized).not.toContain('SECRET_KEY');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('ghp_xyz');
    // Title ('Design Notes') is allowed
    expect(serialized).toContain('Design Notes');
    // .meta.content string is not present
    expect(serialized).not.toContain('SECRET CONTENT');
  });

  it('does not leak file path from file block', () => {
    const layout = makeLayout([makeFilePlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const serialized = JSON.stringify(summary);

    // The rpc:fs node-scoped id must not appear in the excerpt (file path)
    expect(serialized).not.toContain('rpc:fs:node-1:');
    expect(serialized).not.toContain('/home/user');
    // fileRefKind 'file' is allowed; mode is allowed
    expect(serialized).toContain('"fileRefKind":"file"');
    // Verify the excerpt shape — no fileRef.id or displayName in excerpt
    const fileBlock = summary.blocks.find((b) => b.kind === 'file');
    expect(fileBlock?.excerpt).toMatchObject({
      kind: 'file',
      fileRefKind: 'file',
    });
    expect(JSON.stringify(fileBlock?.excerpt)).not.toContain('rpc:fs:node-1:');
  });

  it('does not leak terminal PTY bytes or session cwd', () => {
    const layout = makeLayout([makeTerminalPlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const serialized = JSON.stringify(summary);

    // Only sessionId is exposed — not cwd, repoPath, nodeId details beyond sessionId
    expect(serialized).toContain('sess-abc');
    // cwd should not appear (it's not in the excerpt shape)
    expect(serialized).not.toContain('/home/user/project');
  });

  it('does not expose custom block props or dataRefs', () => {
    const layout = makeLayout([makeCustomPlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const serialized = JSON.stringify(summary);

    // Props should not appear
    expect(serialized).not.toContain('"active"'); // status prop value
    // rendererId is allowed
    expect(serialized).toContain('proposal-id-001');
  });

  it('includes capabilityRequirements in summary (safe metadata)', () => {
    const layout = makeLayout([makeTerminalPlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const block = summary.blocks[0]!;
    expect(block.capabilityRequirements).toContain('session:attach');
  });

  it('sets summaryBytes accurately', () => {
    const layout = makeLayout([makeMarkdownPlacement()]);
    const summary = summarizeWorkbenchBlocks(layout);
    const expected = Buffer.byteLength(JSON.stringify(summary.blocks), 'utf8');
    expect(summary.summaryBytes).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. evaluateBlockProposal (pure logic)
// ---------------------------------------------------------------------------

describe('evaluateBlockProposal', () => {
  const generateId = () => 'test-proposal-id';

  it('auto-approves first-party kind when all grants satisfied', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: 'Notes',
        capabilityRequirements: [],
        meta: { content: 'hello' },
      },
      actorId: 'actor-1',
      actorGrantedBits: ['session:read', 'rpc:fs:read'],
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('auto-approved');
    expect(result.proposalId).toBe('test-proposal-id');
  });

  it('auto-approves when capabilityRequirements subset of granted bits', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'terminal',
        id: 'block-term',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'node-1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-1',
      actorGrantedBits: ['session:read', 'session:attach', 'rpc:fs:read'],
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('auto-approved');
  });

  it('returns pending when actor is missing a required capability', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'terminal',
        id: 'block-term',
        title: 'Term',
        capabilityRequirements: ['session:attach', 'tab:mode:set-agent'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'node-1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-1',
      actorGrantedBits: ['session:attach'], // missing tab:mode:set-agent
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('pending');
  });

  it('custom kind always returns pending regardless of grants', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'custom',
        id: 'block-custom',
        title: 'Custom',
        capabilityRequirements: [],
        meta: { rendererId: 'renderer-1' },
      },
      actorId: 'actor-1',
      actorGrantedBits: [
        'session:read',
        'session:attach',
        'rpc:fs:read',
        'rpc:fs:write',
        'pty:exec:arbitrary',
      ],
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('pending');
  });

  it('rejects malformed descriptor (missing id)', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'markdown',
        id: '', // empty — invalid
        title: 'Notes',
        capabilityRequirements: [],
        meta: { content: 'hello' },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBeTruthy();
  });

  it('rejects malformed descriptor (missing title)', () => {
    const request: WorkbenchBlockProposalRequest = {
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: '', // empty — invalid
        capabilityRequirements: [],
        meta: { content: 'hello' },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    };
    const result = evaluateBlockProposal(request, generateId);
    expect(result.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 3. Server REST router
// ---------------------------------------------------------------------------

describe('workbench-prompt-hooks REST router', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-propose-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeApp(auditSink?: { append: Mock }) {
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );
    return app;
  }

  // -------------------------------------------------------------------------
  // 3a. POST /propose-block — first-party with sufficient grants → auto-approved
  // -------------------------------------------------------------------------
  it('auto-approves first-party kind with sufficient grants', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: 'Notes',
        capabilityRequirements: [],
        meta: { content: 'hello' },
      },
      actorId: 'actor-test',
      actorGrantedBits: ['session:read'],
    });
    expect(res.status).toBe(201);
    const body = res.body as { status: string; proposalId: string };
    expect(body.status).toBe('auto-approved');
    expect(typeof body.proposalId).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 3b. POST /propose-block — first-party without grants → pending
  // -------------------------------------------------------------------------
  it('queues first-party kind pending when grants insufficient', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'block-term',
        title: 'Term',
        capabilityRequirements: ['session:attach', 'tab:mode:set-agent'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-test',
      actorGrantedBits: ['session:read'], // missing session:attach, tab:mode:set-agent
    });
    expect(res.status).toBe(201);
    const body = res.body as { status: string };
    expect(body.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // 3c. POST /propose-block — custom kind → pending in slice-4 store
  // -------------------------------------------------------------------------
  it('routes custom kind to slice-4 store with pending status', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'custom',
        id: 'block-custom',
        title: 'My Custom Block',
        capabilityRequirements: [],
        meta: { rendererId: 'renderer-abc' },
      },
      rendererSource: {
        kind: 'template',
        template: 'status-card',
        props: { title: 'Status', status: 'active' },
      },
      proposedBy: { kind: 'actor', id: 'actor-test' },
      actorId: 'actor-test',
      actorGrantedBits: [],
    });
    expect(res.status).toBe(201);
    const body = res.body as { status: string; proposalId: string };
    expect(body.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // 3d. Malformed body → 422
  // -------------------------------------------------------------------------
  it('rejects malformed body with 422', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', '/workbench/propose-block', {
      // missing actorId
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: 'Notes',
        capabilityRequirements: [],
        meta: { content: '' },
      },
      actorGrantedBits: [],
    });
    expect(res.status).toBe(422);
  });

  it('rejects unknown capability bit with 422', async () => {
    const app = makeApp();
    const res = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: 'Notes',
        capabilityRequirements: ['not-a-real-bit'],
        meta: { content: '' },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });
    expect(res.status).toBe(422);
  });

  // -------------------------------------------------------------------------
  // 3e. GET /propose-block/proposals — list
  // -------------------------------------------------------------------------
  it('lists stored first-party proposals', async () => {
    const app = makeApp();
    // Create one
    await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'markdown',
        id: 'block-1',
        title: 'Notes',
        capabilityRequirements: [],
        meta: { content: 'hello' },
      },
      actorId: 'actor-test',
      actorGrantedBits: [],
    });

    const res = await call(app, 'GET', '/workbench/propose-block/proposals');
    expect(res.status).toBe(200);
    const body = res.body as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('filters proposals by status', async () => {
    const app = makeApp();
    await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'block-t',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-test',
      actorGrantedBits: [], // no grants → pending
    });

    const pending = await call(
      app,
      'GET',
      '/workbench/propose-block/proposals?status=pending'
    );
    expect(pending.status).toBe(200);
    const body = pending.body as Array<{ status: string }>;
    expect(body.every((p) => p.status === 'pending')).toBe(true);

    const approved = await call(
      app,
      'GET',
      '/workbench/propose-block/proposals?status=auto-approved'
    );
    expect(approved.status).toBe(200);
  });

  it('rejects invalid status filter', async () => {
    const app = makeApp();
    const res = await call(
      app,
      'GET',
      '/workbench/propose-block/proposals?status=INVALID'
    );
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 3f. Approve/reject pending proposal
  // -------------------------------------------------------------------------
  it('approves a pending proposal', async () => {
    const app = makeApp();
    const createRes = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'block-t',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-test',
      actorGrantedBits: [],
    });
    const proposalId = (createRes.body as { proposalId: string }).proposalId;

    const approveRes = await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/approve`
    );
    expect(approveRes.status).toBe(200);
    const approved = approveRes.body as { status: string };
    expect(approved.status).toBe('auto-approved');
  });

  it('rejects a pending proposal', async () => {
    const app = makeApp();
    const createRes = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'block-t2',
        title: 'Term 2',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid2',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-test',
      actorGrantedBits: [],
    });
    const proposalId = (createRes.body as { proposalId: string }).proposalId;

    const rejectRes = await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/reject`
    );
    expect(rejectRes.status).toBe(200);
    const rejected = rejectRes.body as { status: string };
    expect(rejected.status).toBe('rejected');
  });

  it('returns 404 when approving unknown proposal', async () => {
    const app = makeApp();
    const res = await call(
      app,
      'POST',
      '/workbench/propose-block/proposals/non-existent/approve'
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when rejecting a non-pending (auto-approved) proposal', async () => {
    const app = makeApp();
    const createRes = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'block-t3',
        title: 'Term 3',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid3',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-test',
      actorGrantedBits: [], // missing session:attach → pending
    });
    const proposalId = (createRes.body as { proposalId: string }).proposalId;
    expect((createRes.body as { status: string }).status).toBe('pending');

    // Approve it (pending → auto-approved)
    const approveRes = await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/approve`
    );
    expect(approveRes.status).toBe(200);

    // Now trying to reject an already-approved proposal should return 409
    const rejectRes = await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/reject`
    );
    expect(rejectRes.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 4. Audit envelope emission
// ---------------------------------------------------------------------------

describe('audit envelope emission', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-audit-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits audit envelope on auto-approved first-party proposal', async () => {
    const auditSink = { append: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );

    await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'markdown',
        id: 'b1',
        title: 'MD',
        capabilityRequirements: [],
        meta: { content: '' },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });

    expect(auditSink.append).toHaveBeenCalledOnce();
    const callArg = auditSink.append.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg?.['decision']).toBe('approved');
    expect(callArg?.['eventType']).toBe('approval');
  });

  it('emits audit envelope on pending first-party proposal', async () => {
    const auditSink = { append: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );

    await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'b2',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });

    expect(auditSink.append).toHaveBeenCalledOnce();
    const callArg = auditSink.append.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg?.['decision']).toBe('recorded');
  });

  it('emits audit envelope on user approve', async () => {
    const auditSink = { append: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );

    const createRes = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'b3',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });
    const proposalId = (createRes.body as { proposalId: string }).proposalId;
    auditSink.append.mockClear();

    await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/approve`
    );
    expect(auditSink.append).toHaveBeenCalledOnce();
    const callArg = auditSink.append.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg?.['decision']).toBe('approved');
  });

  it('emits audit envelope on user reject', async () => {
    const auditSink = { append: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );

    const createRes = await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'terminal',
        id: 'b4',
        title: 'Term',
        capabilityRequirements: ['session:attach'],
        meta: {
          sessionRef: {
            sessionId: 'sid',
            nodeId: 'n1',
            tabKind: 'agent',
            cwd: '/tmp',
          },
        },
      },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });
    const proposalId = (createRes.body as { proposalId: string }).proposalId;
    auditSink.append.mockClear();

    await call(
      app,
      'POST',
      `/workbench/propose-block/proposals/${proposalId}/reject`
    );
    expect(auditSink.append).toHaveBeenCalledOnce();
    const callArg = auditSink.append.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg?.['decision']).toBe('deny');
  });

  it('emits audit envelope on custom kind proposal create', async () => {
    const auditSink = { append: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      '/workbench',
      createWorkbenchProposeBlockRouter({ configPath, auditSink })
    );

    await call(app, 'POST', '/workbench/propose-block', {
      descriptor: {
        kind: 'custom',
        id: 'block-custom',
        title: 'Custom',
        capabilityRequirements: [],
        meta: { rendererId: 'renderer-x' },
      },
      rendererSource: {
        kind: 'template',
        template: 'status-card',
        props: { title: 'S', status: 'active' },
      },
      proposedBy: { kind: 'actor', id: 'actor-1' },
      actorId: 'actor-1',
      actorGrantedBits: [],
    });

    expect(auditSink.append).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. getWorkbenchContextSummary wires layout store + summarizer
// ---------------------------------------------------------------------------

describe('getWorkbenchContextSummary', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ctx-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no layout stored', () => {
    const result = getWorkbenchContextSummary(configPath, 'ws:missing');
    expect(result).toBeNull();
  });

  it('returns a valid summary when layout is persisted', () => {
    const layout = makeLayout([
      makeMarkdownPlacement(),
      makeTerminalPlacement(),
    ]);
    writeWorkbenchLayout(configPath, 'ws:test', layout);

    const result = getWorkbenchContextSummary(configPath, 'ws:test');
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(2);
    expect(result!.workspaceScope.id).toBe('ws:test');
    expect(result!.truncated).toBe(false);
  });

  it('summary from persisted layout does not leak markdown content', () => {
    const layout = makeLayout([makeMarkdownPlacement()]);
    writeWorkbenchLayout(configPath, 'ws:test', layout);

    const result = getWorkbenchContextSummary(configPath, 'ws:test');
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET_KEY');
    expect(serialized).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------
// 6. server/index.ts mounts the router
// ---------------------------------------------------------------------------

describe('server/index.ts mounts the propose-block router', () => {
  it('imports createWorkbenchProposeBlockRouter in server/index.ts', () => {
    const indexSource = readFileSync(
      join(projectRoot, 'server/index.ts'),
      'utf8'
    );
    expect(indexSource).toContain('createWorkbenchProposeBlockRouter');
  });

  it('uses the propose-block router under /workbench path', () => {
    const indexSource = readFileSync(
      join(projectRoot, 'server/index.ts'),
      'utf8'
    );
    expect(indexSource).toContain("'/workbench'");
    expect(indexSource).toContain('createWorkbenchProposeBlockRouter');
  });

  it('server/workbench-prompt-hooks.ts exists', () => {
    expect(
      existsSync(join(projectRoot, 'server/workbench-prompt-hooks.ts'))
    ).toBe(true);
  });

  it('shared/workbench-prompt-hooks.ts exists', () => {
    expect(
      existsSync(join(projectRoot, 'shared/workbench-prompt-hooks.ts'))
    ).toBe(true);
  });
});
